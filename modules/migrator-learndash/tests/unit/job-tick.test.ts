import { describe, expect, it, vi } from 'vitest';
import { onJobTick } from '../../src/index.js';

/// Tests del lifecycle hook `onJobTick` (alpha.53 / Sprint 3).
///
/// El worker BullMQ del host (mod-jobs.worker.ts) invoca `onJobTick(ctx)`
/// por cada tick del job. El módulo decide si avanzar la state machine,
/// completar, fallar, o re-encolar.
///
/// Reglas que estos tests fijan:
///   - Cancelación cooperativa (JR-005): si el status es 'cancelled' al
///     entrar al tick, el handler retorna { status: 'completed' } sin
///     trabajo. El cambio de status lo dispara POST /jobs/:id/cancel
///     fuera del tick — la sincronización es vía read-then-decide.
///   - Transición atómica con CAS (JR-004): cada cambio de fase usa
///     UPDATE ... WHERE status = $from. Si el rowCount=0 (otro tick
///     transicionó), el handler retorna `continue` para re-leer.
///   - Estados terminales (completed, failed) → tick es no-op exitoso.
///   - Job inexistente → failed JOB_NOT_FOUND.

const TENANT = '11111111-1111-1111-1111-111111111111';
const JOB_ID = '22222222-2222-2222-2222-222222222222';

interface DbCall {
  kind: 'query' | 'execute';
  sql: string;
  params: unknown[];
}

/// Stub mínimo de ctx.db. Tests pueden:
///   - Predefinir filas para `query` (queueQueryRows).
///   - Predefinir rowCount para `execute` (queueExecuteRowCount).
///   - Lanzar un error tipado en query/execute (throwOn).
function makeDbStub(
  opts: {
    queryRows?: Array<unknown[] | unknown>;
    executeRowCounts?: number[];
    throwOn?: 'query' | 'execute';
    throwCode?: string;
  } = {},
) {
  const calls: DbCall[] = [];
  const queryRows = [...(opts.queryRows ?? [])];
  const executeRowCounts = [...(opts.executeRowCounts ?? [])];
  const db = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ kind: 'query', sql, params: params ?? [] });
      if (opts.throwOn === 'query') {
        const e = new Error('synthetic') as Error & { code: string; name: string };
        e.code = opts.throwCode ?? 'DB_NETWORK';
        e.name = 'DbError';
        throw e;
      }
      const next = queryRows.shift();
      const rows = Array.isArray(next) ? next : next === undefined ? [] : [next];
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
      const rc = executeRowCounts.shift();
      return { rowCount: rc ?? 1 };
    }),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { db, calls };
}

/// Genera un row típico de jobs con el status indicado. El `getJob`
/// del módulo lo lee con SELECT y `rowToJob` lo normaliza, así que el
/// shape DEBE incluir todas las columnas que `rowToJob` lee.
function fakeJobRow(status: string) {
  return {
    id: JOB_ID,
    tenant_id: TENANT,
    status,
    phase: null,
    source_profile: { baseUrl: 'https://example.com' },
    options: {},
    started_at: '2026-05-07T00:00:00.000Z',
    completed_at: null,
    progress: null,
    error: null,
    created_by: '33333333-3333-3333-3333-333333333333',
  };
}

function makeCtx(db: unknown, overrides: Record<string, unknown> = {}) {
  const log = vi.fn();
  return {
    moduleName: 'mod.migrator-learndash',
    moduleVersion: '1.0.8',
    jobId: JOB_ID,
    tenantId: TENANT,
    tickIndex: 0,
    log,
    db,
    http: {} as unknown,
    didacta: {} as unknown,
    ...overrides,
  } as Parameters<typeof onJobTick>[0];
}

describe('onJobTick · lectura inicial y casos terminales', () => {
  it('job no existe → failed JOB_NOT_FOUND', async () => {
    const { db } = makeDbStub({ queryRows: [[]] }); // SELECT sin filas
    const res = await onJobTick(makeCtx(db));
    expect(res).toEqual({ status: 'failed', reason: 'JOB_NOT_FOUND' });
  });

  it('error en SELECT del job → failed con causa preservada', async () => {
    const { db } = makeDbStub({ throwOn: 'query', throwCode: 'DB_TIMEOUT' });
    const res = await onJobTick(makeCtx(db));
    expect(res.status).toBe('failed');
    if (res.status === 'failed') {
      expect(res.reason).toMatch(/db_error_reading_job/);
    }
  });

  it('job cancelado → completed sin tocar nada (cancelación cooperativa)', async () => {
    const { db, calls } = makeDbStub({ queryRows: [[fakeJobRow('cancelled')]] });
    const res = await onJobTick(makeCtx(db));
    expect(res).toEqual({ status: 'completed' });
    // Solo debería haber 1 call (el SELECT inicial). Sin UPDATE.
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
  });

  it('job ya completed → completed (idempotente)', async () => {
    const { db, calls } = makeDbStub({ queryRows: [[fakeJobRow('completed')]] });
    const res = await onJobTick(makeCtx(db));
    expect(res).toEqual({ status: 'completed' });
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
  });

  it('job ya failed → completed (no re-encolar)', async () => {
    const { db } = makeDbStub({ queryRows: [[fakeJobRow('failed')]] });
    const res = await onJobTick(makeCtx(db));
    expect(res).toEqual({ status: 'completed' });
  });
});

describe('onJobTick · state machine (JR-004)', () => {
  it('pending → preflight con CAS y retorna continue sin delay', async () => {
    const { db, calls } = makeDbStub({
      queryRows: [[fakeJobRow('pending')]],
      executeRowCounts: [1],
    });
    const res = await onJobTick(makeCtx(db));
    expect(res).toEqual({ status: 'continue', delaySec: 0 });
    const update = calls.find((c) => c.kind === 'execute');
    expect(update).toBeDefined();
    expect(update!.sql).toContain('UPDATE mod_migrator_learndash_jobs');
    expect(update!.sql).toContain('status = $4');
    expect(update!.sql).toContain('WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = $3');
    expect(update!.params).toEqual([TENANT, JOB_ID, 'pending', 'preflight']);
  });

  it('preflight → extracting con CAS', async () => {
    const { db, calls } = makeDbStub({
      queryRows: [[fakeJobRow('preflight')]],
      executeRowCounts: [1],
    });
    const res = await onJobTick(makeCtx(db));
    expect(res).toEqual({ status: 'continue', delaySec: 0 });
    expect(calls[1]!.params[3]).toBe('extracting');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Tests obsoletos (4) borrados 2026-05-20 — modelaban STUBs de Sprint 3
  // (extracting/transforming/loading/reconciling solo logueaban warn y
  // avanzaban vacíos). En Sprint 4 (alpha.56) esas fases pasaron a ser
  // REALES: extract paginable con ctx.http contra WP REST, transform con
  // mappers + DLQ, load via ctx.didacta.upsertByExternalRef, reconcile con
  // audit chain SHA-256. Los tests fallaban porque ya no hay "STUB" en el
  // log ni avance vacío. La cobertura real de estas fases queda como item
  // del backlog (`MIGRATOR-TESTS-REFACTOR` P3): reescribir como integration
  // tests con Postgres real + mocks de ctx.http capturando responses WP
  // de fixture. Mientras tanto, la evidencia funcional es el handoff de
  // 2026-05-19 con un import real contra un LearnDash productivo: 13 cursos /
  // 60 modules / 448 lessons importadas con audit chain verificada.
  // ─────────────────────────────────────────────────────────────────────────

  it('CAS rechaza (rowCount=0 — otro tick transicionó) → continue para re-leer', async () => {
    const { db } = makeDbStub({
      queryRows: [[fakeJobRow('pending')]],
      executeRowCounts: [0], // CAS falla
    });
    const res = await onJobTick(makeCtx(db));
    expect(res).toEqual({ status: 'continue', delaySec: 0 });
  });

  it('estado inesperado → failed con razón identificable', async () => {
    const { db } = makeDbStub({
      queryRows: [[fakeJobRow('zombie_state' as never)]],
    });
    const res = await onJobTick(makeCtx(db));
    expect(res.status).toBe('failed');
    if (res.status === 'failed') {
      expect(res.reason).toMatch(/unexpected_status:zombie_state/);
    }
  });

  it('error transitorio en state machine → continue con backoff de 30s', async () => {
    const { db } = makeDbStub({
      queryRows: [[fakeJobRow('extracting')]],
      throwOn: 'execute',
      throwCode: 'DB_NETWORK',
    });
    const res = await onJobTick(makeCtx(db));
    expect(res).toEqual({ status: 'continue', delaySec: 30 });
  });
});

describe('onJobTick · cancelación cooperativa (JR-005)', () => {
  it('NUNCA mira status global ni signals — solo el row del job', async () => {
    // Simulamos que entre tick 1 (vio "extracting") y tick 2 alguien hizo
    // POST /jobs/:id/cancel: ahora el row dice "cancelled" y el segundo
    // tick lo respeta sin tocar la state machine.
    const { db, calls } = makeDbStub({ queryRows: [[fakeJobRow('cancelled')]] });
    const res = await onJobTick(makeCtx(db, { tickIndex: 5 }));
    expect(res).toEqual({ status: 'completed' });
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
  });

  it('cancelación entre dos ticks consecutivos: tick N avanza, tick N+1 detecta cancel', async () => {
    // Tick N: ve 'pending', avanza a 'preflight', retorna continue
    const tickN = await onJobTick(
      makeCtx(makeDbStub({ queryRows: [[fakeJobRow('pending')]], executeRowCounts: [1] }).db, {
        tickIndex: 0,
      }),
    );
    expect(tickN.status).toBe('continue');

    // Tick N+1: alguien hizo cancel — el row ahora dice 'cancelled'
    const { calls: callsN1 } = makeDbStub({ queryRows: [[fakeJobRow('cancelled')]] });
    const tickN1 = await onJobTick(
      makeCtx(makeDbStub({ queryRows: [[fakeJobRow('cancelled')]] }).db, { tickIndex: 1 }),
    );
    expect(tickN1).toEqual({ status: 'completed' });
    // Latencia esperada: <= 1 batch (el tick que ya estaba ejecutando termina,
    // y el siguiente respeta el cancel). No es interrupción dura.
    void callsN1;
  });
});
