import { describe, expect, it, vi } from 'vitest';
import { onJobTick } from '../../src/index.js';

/// Tests de visibilidad del skip silencioso del loader (v1.0.33).
///
/// Contexto: hasta v1.0.32 el SELECT del loader (`listValidUnloadedStg`)
/// filtraba con `target_id IS NULL`. Cualquier row con sentinel `!SKIP:%`
/// quedaba silenciosamente fuera del re-procesado. Resultado: en el primer
/// reporte real del operador, 20 topics + 8 groups habían sido marcados
/// con `!SKIP:` por versiones previas del adapter y no aparecían en el
/// DLQ → el operador no podía diagnosticar por qué se "perdían".
///
/// v1.0.33 hace dos cambios coordinados:
///   1. El SELECT ahora incluye rows con `target_id LIKE '!SKIP:%'`.
///   2. Al re-procesar uno de esos rows, ANTES de evaluarlo contra el
///      adapter actual, escribe una entry visibility en el DLQ con código
///      `SKIP_ALREADY_LOADED_IN_PREVIOUS_RUN` y mensaje explicando el
///      sentinel previo.
///
/// Estos tests usan el stub de db de `job-tick.test.ts` (forma reducida)
/// para verificar que el INSERT al DLQ ocurre cuando corresponde y NO
/// ocurre para rows con target_id real o `!FAIL:`.

const TENANT = '11111111-1111-1111-1111-111111111111';
const JOB_ID = '22222222-2222-2222-2222-222222222222';

interface DbCall {
  kind: 'query' | 'execute';
  sql: string;
  params: unknown[];
}

function makeDbStub(
  opts: {
    queryRows?: Array<unknown[] | unknown>;
    executeRowCounts?: number[];
  } = {},
) {
  const calls: DbCall[] = [];
  const queryRows = [...(opts.queryRows ?? [])];
  const executeRowCounts = [...(opts.executeRowCounts ?? [])];
  const db = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ kind: 'query', sql, params: params ?? [] });
      const next = queryRows.shift();
      const rows = Array.isArray(next) ? next : next === undefined ? [] : [next];
      return { rows, rowCount: rows.length };
    }),
    execute: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ kind: 'execute', sql, params: params ?? [] });
      const rc = executeRowCounts.shift();
      return { rowCount: rc ?? 1 };
    }),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { db, calls };
}

/// Helper: row del job en estado 'loading' apuntando a una entidad concreta.
function jobLoadingRow(entity: string) {
  return {
    id: JOB_ID,
    tenant_id: TENANT,
    status: 'loading',
    phase: null,
    source_profile: { baseUrl: 'https://example.com' },
    options: {},
    started_at: '2026-06-02T00:00:00.000Z',
    completed_at: null,
    progress: { phase: 'load', current: entity, completed: ['users', 'courses', 'lessons'] },
    error: null,
    created_by: '33333333-3333-3333-3333-333333333333',
  };
}

/// Helper: row de stg "viejo" — ya marcado con sentinel `!SKIP:<code>` por
/// una versión previa del adapter.
function stgRowWithSentinel(opts: {
  id: string;
  sourceId: string;
  target: string;
  canonical: Record<string, unknown>;
  rawPayload?: unknown;
}) {
  return {
    id: opts.id,
    source_id: opts.sourceId,
    raw_payload: opts.rawPayload ?? { id: Number(opts.sourceId) },
    canonical: opts.canonical,
    is_valid: true,
    target_id: opts.target,
  };
}

function makeCtx(db: unknown, overrides: Record<string, unknown> = {}) {
  const log = vi.fn();
  const lessonsUpsert = vi.fn(async (_input: Record<string, unknown>) => ({
    id: 'didacta-uuid-of-lesson',
  }));
  return {
    moduleName: 'mod.migrator-learndash',
    moduleVersion: '1.0.33',
    jobId: JOB_ID,
    tenantId: TENANT,
    tickIndex: 0,
    log,
    db,
    http: {} as unknown,
    didacta: {
      lessons: { upsertByExternalRef: lessonsUpsert },
      // ns vacío para groups — no se llama porque adapter falla antes.
    },
    _lessonsUpsert: lessonsUpsert,
    ...overrides,
  } as unknown as Parameters<typeof onJobTick>[0];
}

describe('loader skip visibility (v1.0.33)', () => {
  it('topic con sentinel `!SKIP:ADAPTER_TOPIC_SKIPPED` (legacy) → DLQ visibility entry SKIP_ALREADY_LOADED_IN_PREVIOUS_RUN', async () => {
    const topicRow = stgRowWithSentinel({
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      sourceId: '101',
      target: '!SKIP:ADAPTER_TOPIC_SKIPPED', // legacy v1.0.32
      canonical: {
        sourceId: '101',
        parentCourseSourceId: '5',
        title: 'Topic legacy',
        contentHtml: '<p>x</p>',
      },
    });
    const { db, calls } = makeDbStub({
      queryRows: [
        [jobLoadingRow('topics')], // SELECT job
        [topicRow], // SELECT stg_topics
        [], // posterior SELECT stg_topics (empty → cursor avanza)
      ],
      executeRowCounts: [1, 1, 1, 1], // INSERTs DLQ + UPDATEs stg
    });
    const res = await onJobTick(makeCtx(db));
    expect(res.status).toBe('continue');

    const dlqInserts = calls.filter(
      (c) => c.kind === 'execute' && c.sql.includes('mod_migrator_learndash_dlq'),
    );
    expect(dlqInserts.length).toBeGreaterThanOrEqual(1);
    const visibilityEntry = dlqInserts.find((c) =>
      c.params.includes('SKIP_ALREADY_LOADED_IN_PREVIOUS_RUN'),
    );
    expect(visibilityEntry).toBeDefined();
    // El mensaje debe ser accionable: mencionar la versión y el sentinel previo.
    const msg = String(
      visibilityEntry!.params.find((p) => typeof p === 'string' && p.includes('v1.0.33')) ?? '',
    );
    expect(msg).toMatch(/v1\.0\.33/);
    expect(msg).toMatch(/ADAPTER_TOPIC_SKIPPED/);
  });

  it('topic con sentinel `!SKIP:` se RE-EVALÚA y carga vía ctx.didacta.lessons (no se queda atascado)', async () => {
    const topicRow = stgRowWithSentinel({
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      sourceId: '202',
      target: '!SKIP:ADAPTER_TOPIC_SKIPPED',
      canonical: {
        sourceId: '202',
        parentCourseSourceId: '7',
        parentLessonSourceId: '50',
        title: 'Topic re-procesado',
        contentHtml: '<p>content</p>',
      },
    });
    const lessonsUpsert = vi.fn(async (_input: Record<string, unknown>) => ({
      id: 'lesson-uuid-202',
    }));
    const { db, calls } = makeDbStub({
      queryRows: [[jobLoadingRow('topics')], [topicRow], []],
      executeRowCounts: [1, 1, 1],
    });
    const ctx = makeCtx(db, {
      didacta: { lessons: { upsertByExternalRef: lessonsUpsert } },
    });
    await onJobTick(ctx);

    expect(lessonsUpsert).toHaveBeenCalledTimes(1);
    const upsertedInput = lessonsUpsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(upsertedInput['externalId']).toBe('202');
    expect(upsertedInput['moduleExternalRef']).toEqual({
      externalSource: 'learndash',
      externalId: '7',
    });

    // Y el row de stg quedó con target_id REAL (no `!SKIP:`), reemplazando el sentinel.
    const stgUpdate = calls.find(
      (c) =>
        c.kind === 'execute' &&
        c.sql.includes('UPDATE mod_migrator_learndash_stg_topics') &&
        c.params.includes('lesson-uuid-202'),
    );
    expect(stgUpdate).toBeDefined();
  });

  it('group con sentinel `!SKIP:ADAPTER_GROUPS_NO_TARGET` (legacy) → DLQ visibility entry + DLQ failure entry (ADAPTER_GROUPS_NOT_SUPPORTED)', async () => {
    const groupRow = stgRowWithSentinel({
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      sourceId: '300',
      target: '!SKIP:ADAPTER_GROUPS_NO_TARGET', // legacy v1.0.32
      canonical: { sourceId: '300', title: 'Equipo legacy' },
    });
    const { db, calls } = makeDbStub({
      queryRows: [[jobLoadingRow('groups')], [groupRow], []],
      executeRowCounts: [1, 1, 1, 1],
    });
    await onJobTick(makeCtx(db));

    const dlqInserts = calls.filter(
      (c) => c.kind === 'execute' && c.sql.includes('mod_migrator_learndash_dlq'),
    );
    // Esperamos DOS entries para este group:
    //   1. visibility: SKIP_ALREADY_LOADED_IN_PREVIOUS_RUN
    //   2. failure: ADAPTER_GROUPS_NOT_SUPPORTED (porque el adapter lo rechaza)
    const visibility = dlqInserts.find((c) =>
      c.params.includes('SKIP_ALREADY_LOADED_IN_PREVIOUS_RUN'),
    );
    const failure = dlqInserts.find((c) => c.params.includes('ADAPTER_GROUPS_NOT_SUPPORTED'));
    expect(visibility).toBeDefined();
    expect(failure).toBeDefined();
  });

  it('row SIN sentinel (`target_id IS NULL`) → NO escribe SKIP_ALREADY_LOADED_IN_PREVIOUS_RUN', async () => {
    // Row "virgen" — primera vez que pasa por el loader. NO debe emitir
    // la visibility entry porque no hubo skip previo.
    const topicRow = stgRowWithSentinel({
      id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      sourceId: '500',
      target: null as unknown as string, // null → row recién extraída
      canonical: {
        sourceId: '500',
        parentCourseSourceId: '5',
        title: 'Topic virgen',
      },
    });
    // Como el stub no distingue null vs string, lo seteo en el row directamente:
    (topicRow as { target_id: string | null }).target_id = null;

    const { db, calls } = makeDbStub({
      queryRows: [[jobLoadingRow('topics')], [topicRow], []],
      executeRowCounts: [1, 1, 1],
    });
    await onJobTick(makeCtx(db));

    const dlqInserts = calls.filter(
      (c) => c.kind === 'execute' && c.sql.includes('mod_migrator_learndash_dlq'),
    );
    const visibility = dlqInserts.find((c) =>
      c.params.includes('SKIP_ALREADY_LOADED_IN_PREVIOUS_RUN'),
    );
    expect(visibility).toBeUndefined();
  });

  it('el SELECT del loader INCLUYE rows con sentinel `!SKIP:%` (re-procesado habilitado)', async () => {
    // Verifica que la query del loader cubre el caso. Si alguien revierte
    // el WHERE a `target_id IS NULL` plano, este test atrapa la regresión.
    const { db, calls } = makeDbStub({
      queryRows: [
        [jobLoadingRow('topics')],
        [], // batch vacío para cortar pronto
      ],
    });
    await onJobTick(makeCtx(db));

    const stgSelects = calls.filter(
      (c) =>
        c.kind === 'query' &&
        c.sql.includes('FROM mod_migrator_learndash_stg_topics') &&
        c.sql.includes('is_valid = TRUE'),
    );
    expect(stgSelects.length).toBeGreaterThanOrEqual(1);
    // El WHERE debe permitir AMBOS: target_id IS NULL o target_id LIKE '!SKIP:%'
    expect(stgSelects[0]!.sql).toMatch(/target_id IS NULL/);
    expect(stgSelects[0]!.sql).toMatch(/target_id LIKE '!SKIP:%'/);
  });
});
