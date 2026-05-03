import type {
  AuditPort,
  DlqPort,
  JobsPort,
  LoaderPort,
  Logger,
  MappingsPort,
  StagingPort,
  StagingTable,
} from './ports.js';
import type { ProgressBus } from './progress.js';
import { nowIso } from './progress.js';
import type {
  CanonicalCourse,
  CanonicalEnrollment,
  CanonicalGroup,
  CanonicalLearningUnit,
  CanonicalAssessment,
  CanonicalQuestion,
  CanonicalUser,
  CanonicalMedia,
} from '../mappers/canonical.js';

export interface LoaderDeps {
  jobs: JobsPort;
  staging: StagingPort;
  mappings: MappingsPort;
  dlq: DlqPort;
  audit: AuditPort;
  bus: ProgressBus;
  loader: LoaderPort;
  logger: Logger;
}

export interface LoadOptions {
  passwordStrategy: 'activation_reset' | 'preserve_hash';
  copyMediaBinaries: boolean;
}

const BATCH = 50;

/**
 * Fase LOAD: canonical → API pública del módulo destino.
 * Orden topológico: users → media → courses → learning_units (lessons → topics)
 *                  → assessments (quizzes) → questions → groups → enrollments
 * (progress se omite en MVP — requiere endpoints específicos en mod.learning).
 */
export async function runLoad(
  deps: LoaderDeps,
  jobId: string,
  tenantId: string,
  options: LoadOptions,
  signal?: AbortSignal,
): Promise<void> {
  const { jobs, audit, bus } = deps;

  await jobs.updateStatus(jobId, 'loading', 'load:start');
  await audit.append(tenantId, jobId, 'system', 'phase.started', null, null, { phase: 'load' });
  bus.emit(jobId, { type: 'phase.started', phase: 'load', at: nowIso() });

  await loadEntity(deps, jobId, tenantId, 'users', 'user', async (canonical) =>
    deps.loader.upsertUser(tenantId, canonical as CanonicalUser, { passwordStrategy: options.passwordStrategy }),
    signal,
  );
  await loadEntity(deps, jobId, tenantId, 'media', 'media', async (canonical) =>
    deps.loader.upsertMedia(tenantId, canonical as CanonicalMedia, {
      copyBinary: options.copyMediaBinaries,
    }),
    signal,
  );
  await loadEntity(deps, jobId, tenantId, 'courses', 'course', async (canonical) =>
    deps.loader.upsertCourse(tenantId, canonical as CanonicalCourse),
    signal,
  );
  await loadEntity(deps, jobId, tenantId, 'lessons', 'lesson', async (canonical) =>
    deps.loader.upsertLearningUnit(tenantId, canonical as CanonicalLearningUnit),
    signal,
  );
  await loadEntity(deps, jobId, tenantId, 'topics', 'topic', async (canonical) =>
    deps.loader.upsertLearningUnit(tenantId, canonical as CanonicalLearningUnit),
    signal,
  );
  await loadEntity(deps, jobId, tenantId, 'quizzes', 'quiz', async (canonical) =>
    deps.loader.upsertAssessment(tenantId, canonical as CanonicalAssessment),
    signal,
  );
  await loadEntity(deps, jobId, tenantId, 'questions', 'question', async (canonical) =>
    deps.loader.upsertQuestion(tenantId, canonical as CanonicalQuestion),
    signal,
  );
  await loadEntity(deps, jobId, tenantId, 'groups', 'group', async (canonical) =>
    deps.loader.upsertGroup(tenantId, canonical as CanonicalGroup),
    signal,
  );
  await loadEntity(deps, jobId, tenantId, 'enrollments', 'enrollment', async (canonical) =>
    deps.loader.upsertEnrollment(tenantId, canonical as CanonicalEnrollment),
    signal,
  );

  await audit.append(tenantId, jobId, 'system', 'phase.completed', null, null, { phase: 'load' });
  bus.emit(jobId, { type: 'phase.completed', phase: 'load', counts: {}, at: nowIso() });
}

async function loadEntity(
  deps: LoaderDeps,
  jobId: string,
  tenantId: string,
  table: StagingTable,
  entityType: string,
  loadFn: (canonical: unknown) => Promise<{ id: string; created: boolean }>,
  signal?: AbortSignal,
): Promise<void> {
  const { staging, mappings, dlq, jobs, bus, logger } = deps;
  let cursor: string | undefined;
  let total = 0;
  while (true) {
    if (signal?.aborted || (await jobs.isCancelling(jobId))) return;
    const batch = await staging.listValid(table, tenantId, jobId, BATCH, cursor);
    if (batch.length === 0) break;
    for (const row of batch) {
      if (row.loadedAt) {
        await mappings.upsert(
          tenantId,
          jobId,
          entityType,
          row.sourceId,
          extExternalId(row.canonical),
          'skipped',
          row.targetId ?? undefined,
          row.checksum,
        );
        continue;
      }
      try {
        const result = await loadFn(row.canonical);
        await staging.markLoaded(table, row.id, result.id);
        await mappings.upsert(
          tenantId,
          jobId,
          entityType,
          row.sourceId,
          extExternalId(row.canonical),
          'loaded',
          result.id,
          row.checksum,
        );
      } catch (err) {
        const e = err as Error;
        await dlq.add(tenantId, jobId, table, row.sourceId, 'load', 'LOAD_FAILED', e.message, row.rawPayload, row.canonical);
        await mappings.upsert(
          tenantId,
          jobId,
          entityType,
          row.sourceId,
          extExternalId(row.canonical),
          'failed',
          undefined,
          row.checksum,
        );
        logger.warn('load.entity.failed', { jobId, table, sourceId: row.sourceId, error: e.message });
      }
      total += 1;
    }
    const last = batch[batch.length - 1];
    if (!last) break;
    cursor = last.id;
    bus.emit(jobId, { type: 'phase.progress', phase: `load:${table}`, current: total, at: nowIso() });
  }
  logger.info('load.entity.done', { jobId, table, total });
}

function extExternalId(canonical: unknown): string {
  if (canonical && typeof canonical === 'object' && 'externalId' in canonical) {
    const v = (canonical as Record<string, unknown>)['externalId'];
    if (typeof v === 'string') return v;
  }
  return 'learndash:unknown';
}
