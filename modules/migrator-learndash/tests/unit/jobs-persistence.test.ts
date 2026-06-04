import { describe, expect, it, vi } from 'vitest';
import { routes } from '../../src/index.js';

/// Tests de persistencia de jobs vía ctx.db (alpha.51).
///
/// Antes de alpha.51 los jobs vivían en un Map en memoria — se perdían
/// al restart de la API. alpha.51 introdujo `ctx.db` (cliente sandbox
/// con SQL guard scoped al tablePrefix) y este módulo declara
/// `requiresDb: true` en su manifest. Estos tests validan:
///   1. Sin `ctx.db` → 503 DB_NOT_AVAILABLE (host < alpha.51).
///   2. Con `ctx.db` stub → INSERT/SELECT/UPDATE se invocan con SQL
///      scoped al prefix (los SQL reales se cubren end-to-end en el
///      smoke contra Postgres real).
///   3. Errores tipados de ctx.db → status HTTP correcto.

const ADMIN = { sub: 'u-1', tenantId: 't-1', roles: ['tenant_admin'] };

interface DbCall {
  kind: 'query' | 'execute';
  sql: string;
  params: unknown[];
}

function makeDbStub(
  opts: { queryReturn?: unknown[]; throwOn?: 'query' | 'execute'; throwCode?: string } = {},
) {
  const calls: DbCall[] = [];
  const db = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ kind: 'query', sql, params: params ?? [] });
      if (opts.throwOn === 'query') {
        const e = new Error('synthetic') as Error & { code: string; name: string };
        e.code = opts.throwCode ?? 'DB_NETWORK';
        e.name = 'DbError';
        throw e;
      }
      const rows = opts.queryReturn ?? [];
      return { rows, rowCount: rows.length };
    }),
    execute: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ kind: 'execute', sql, params: params ?? [] });
      if (opts.throwOn === 'execute') {
        const e = new Error('synthetic') as Error & { code: string; name: string };
        e.code = opts.throwCode ?? 'DB_NETWORK';
        e.name = 'DbError';
        throw e;
      }
      return { rowCount: 1 };
    }),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { db, calls };
}

/// Stub de ctx.secrets requerido por POST /jobs desde alpha.56. Sin esto, el
/// handler responde 503 SECRETS_NOT_AVAILABLE antes de tocar la BD y todos
/// los tests del segundo describe block (POST /jobs con ctx.db stub) fallan.
function makeSecretsStub() {
  const calls: Array<{ kind: 'get' | 'set' | 'delete' | 'list'; key?: string }> = [];
  const secrets = {
    get: vi.fn(async (key: string) => {
      calls.push({ kind: 'get', key });
      return null;
    }),
    set: vi.fn(async (key: string, _value: string) => {
      calls.push({ kind: 'set', key });
    }),
    delete: vi.fn(async (key: string) => {
      calls.push({ kind: 'delete', key });
    }),
    list: vi.fn(async () => {
      calls.push({ kind: 'list' });
      return [];
    }),
  };
  return { secrets, calls };
}

function findRoute(method: string, path: string) {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`ruta ${method} ${path} no encontrada`);
  return r;
}

function makeReq(extra: Record<string, unknown> = {}) {
  return {
    method: 'POST' as const,
    path: '/jobs',
    params: {} as Record<string, string>,
    query: {} as Record<string, string | string[]>,
    body: undefined,
    user: ADMIN,
    ...extra,
  };
}

describe('migrator-learndash · /jobs sin ctx.db (host < alpha.51)', () => {
  it('POST /jobs → 503 DB_NOT_AVAILABLE', async () => {
    const route = findRoute('POST', '/jobs');
    const res = await route.handler(makeReq({ body: { credentials: {}, options: {} } }));
    expect(res.status).toBe(503);
    expect((res.body as { code: string }).code).toBe('DB_NOT_AVAILABLE');
  });

  it('GET /jobs → 503 DB_NOT_AVAILABLE', async () => {
    const route = findRoute('GET', '/jobs');
    const res = await route.handler(makeReq({ method: 'GET', path: '/jobs' }));
    expect(res.status).toBe(503);
  });

  it('GET /jobs/:id → 503 DB_NOT_AVAILABLE', async () => {
    const route = findRoute('GET', '/jobs/:id');
    const res = await route.handler(
      makeReq({ method: 'GET', path: '/jobs/abc', params: { id: 'abc' } }),
    );
    expect(res.status).toBe(503);
  });

  it('POST /jobs/:id/cancel → 503 DB_NOT_AVAILABLE', async () => {
    const route = findRoute('POST', '/jobs/:id/cancel');
    const res = await route.handler(makeReq({ path: '/jobs/abc/cancel', params: { id: 'abc' } }));
    expect(res.status).toBe(503);
  });
});

describe('migrator-learndash · POST /jobs con ctx.db stub', () => {
  it('inserta job con tablePrefix correcto y NO persiste appPassword', async () => {
    const { db, calls } = makeDbStub({ queryReturn: [{ id: 'job-uuid-1' }] });
    const { secrets } = makeSecretsStub();
    const route = findRoute('POST', '/jobs');
    const res = await route.handler(
      makeReq({
        db,
        secrets,
        body: {
          credentials: {
            baseUrl: 'https://wp.cliente.com',
            username: 'admin',
            appPassword: 'super-secret-do-not-leak',
          },
          options: { dryRun: true },
        },
      }),
    );
    expect(res.status).toBe(201);
    expect((res.body as { jobId: string }).jobId).toBe('job-uuid-1');

    // Verifica que el INSERT toca SOLO la tabla del módulo (prefix scope).
    const insert = calls.find((c) => c.sql.includes('INSERT INTO mod_migrator_learndash_jobs'));
    expect(insert).toBeDefined();
    // Y que el appPassword NO está en los params persistidos del INSERT a la BD.
    // El appPassword va por ctx.secrets (separado), no por params del SQL.
    const allParams = JSON.stringify(insert!.params);
    expect(allParams).not.toContain('super-secret-do-not-leak');
    // Pero sí los identificadores no-secretos.
    expect(allParams).toContain('https://wp.cliente.com');
    expect(allParams).toContain('admin');
    // Y secrets.set debe haberse llamado con el appPassword cifrado.
    expect(secrets.set).toHaveBeenCalled();
  });

  it('400 VALIDATION_ERROR si faltan credentials/options', async () => {
    const { db } = makeDbStub();
    const { secrets } = makeSecretsStub();
    const route = findRoute('POST', '/jobs');
    const res = await route.handler(makeReq({ db, secrets, body: {} }));
    expect(res.status).toBe(400);
  });

  it('mapea DB_UNIQUE_VIOLATION → 409', async () => {
    const { db } = makeDbStub({ throwOn: 'query', throwCode: 'DB_UNIQUE_VIOLATION' });
    const { secrets } = makeSecretsStub();
    const route = findRoute('POST', '/jobs');
    const res = await route.handler(
      makeReq({
        db,
        secrets,
        body: {
          credentials: { baseUrl: 'x', username: 'y', appPassword: 'z' },
          options: {},
        },
      }),
    );
    expect(res.status).toBe(409);
  });

  it('mapea DB_TIMEOUT → 504', async () => {
    const { db } = makeDbStub({ throwOn: 'query', throwCode: 'DB_TIMEOUT' });
    const { secrets } = makeSecretsStub();
    const route = findRoute('POST', '/jobs');
    const res = await route.handler(
      makeReq({
        db,
        secrets,
        body: {
          credentials: { baseUrl: 'x', username: 'y', appPassword: 'z' },
          options: {},
        },
      }),
    );
    expect(res.status).toBe(504);
  });
});

describe('migrator-learndash · GET /jobs con ctx.db stub', () => {
  it('SELECT con tenant_id en WHERE + limit 200 + ORDER BY started_at DESC', async () => {
    const { db, calls } = makeDbStub({
      queryReturn: [
        {
          id: 'j1',
          tenant_id: 't-1',
          status: 'pending',
          phase: null,
          source_profile: { baseUrl: 'x' },
          options: {},
          started_at: '2026-05-05T10:00:00.000Z',
          completed_at: null,
          progress: null,
          error: null,
          created_by: 'u-1',
        },
      ],
    });
    const route = findRoute('GET', '/jobs');
    const res = await route.handler(makeReq({ method: 'GET', path: '/jobs', db }));
    expect(res.status).toBe(200);
    expect((res.body as { items: unknown[] }).items).toHaveLength(1);

    const select = calls[0]!;
    expect(select.sql).toContain('FROM mod_migrator_learndash_jobs');
    expect(select.sql).toContain('WHERE tenant_id = $1');
    expect(select.sql).toContain('ORDER BY started_at DESC');
    expect(select.sql).toContain('LIMIT 200');
    expect(select.params[0]).toBe('t-1');
  });
});

describe('migrator-learndash · POST /jobs/:id/cancel con ctx.db stub', () => {
  it('UPDATE solo cuando el job está cancellable', async () => {
    const { db, calls } = makeDbStub({
      queryReturn: [
        {
          id: 'j1',
          tenant_id: 't-1',
          status: 'pending',
          phase: null,
          source_profile: {},
          options: {},
          started_at: '2026-05-05T10:00:00.000Z',
          completed_at: null,
          progress: null,
          error: null,
          created_by: 'u-1',
        },
      ],
    });
    const route = findRoute('POST', '/jobs/:id/cancel');
    const res = await route.handler(makeReq({ path: '/jobs/j1/cancel', params: { id: 'j1' }, db }));
    expect(res.status).toBe(200);

    const update = calls.find(
      (c) => c.kind === 'execute' && c.sql.includes('UPDATE mod_migrator_learndash_jobs'),
    );
    expect(update).toBeDefined();
    expect(update!.sql).toContain('SET status = $3');
    expect(update!.sql).toContain('WHERE tenant_id = $1::uuid AND id = $2::uuid');
  });

  it('409 JOB_NOT_CANCELLABLE si ya está completed', async () => {
    const { db } = makeDbStub({
      queryReturn: [
        {
          id: 'j1',
          tenant_id: 't-1',
          status: 'completed',
          phase: null,
          source_profile: {},
          options: {},
          started_at: '2026-05-05T10:00:00.000Z',
          completed_at: '2026-05-05T11:00:00.000Z',
          progress: null,
          error: null,
          created_by: 'u-1',
        },
      ],
    });
    const route = findRoute('POST', '/jobs/:id/cancel');
    const res = await route.handler(makeReq({ path: '/jobs/j1/cancel', params: { id: 'j1' }, db }));
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe('JOB_NOT_CANCELLABLE');
  });
});
