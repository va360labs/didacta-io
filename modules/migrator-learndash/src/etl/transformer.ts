import type {
  AuditPort,
  DlqPort,
  JobsPort,
  Logger,
  StagingPort,
  StagingTable,
} from './ports.js';
import type { ProgressBus } from './progress.js';
import { nowIso } from './progress.js';
import {
  mapCourse,
  mapGroup,
  mapLesson,
  mapMedia,
  mapQuestion,
  mapQuiz,
  mapTopic,
  mapUser,
  mapDirectEnrollment,
  mapGroupEnrollment,
  type MapResult,
} from '../mappers/index.js';
import type {
  LdCourse,
  LdGroup,
  LdLesson,
  LdQuestion,
  LdQuiz,
  LdTopic,
  WpMedia,
  WpUser,
} from '../connector/index.js';

export interface TransformerDeps {
  jobs: JobsPort;
  staging: StagingPort;
  dlq: DlqPort;
  audit: AuditPort;
  bus: ProgressBus;
  logger: Logger;
}

const BATCH = 500;

/**
 * Fase TRANSFORM: stg_*.rawPayload → stg_*.canonical aplicando los mappers.
 * Filas inválidas pasan a la DLQ con errorCode tipado.
 */
export async function runTransform(
  deps: TransformerDeps,
  jobId: string,
  tenantId: string,
  signal?: AbortSignal,
): Promise<void> {
  const { jobs, bus, audit } = deps;

  await jobs.updateStatus(jobId, 'transforming', 'transform:start');
  await audit.append(tenantId, jobId, 'system', 'phase.started', null, null, { phase: 'transform' });
  bus.emit(jobId, { type: 'phase.started', phase: 'transform', at: nowIso() });

  await transformTable(deps, jobId, tenantId, 'users', (raw) => mapUser(raw as WpUser), signal);
  await transformTable(deps, jobId, tenantId, 'media', (raw) => mapMedia(raw as WpMedia), signal);
  await transformTable(deps, jobId, tenantId, 'courses', (raw) => mapCourse(raw as LdCourse), signal);
  await transformTable(deps, jobId, tenantId, 'lessons', (raw) => mapLesson(raw as LdLesson), signal);
  await transformTable(deps, jobId, tenantId, 'topics', (raw) => mapTopic(raw as LdTopic), signal);
  await transformTable(deps, jobId, tenantId, 'quizzes', (raw) => mapQuiz(raw as LdQuiz), signal);
  await transformTable(deps, jobId, tenantId, 'questions', (raw) => mapQuestion(raw as LdQuestion), signal);
  await transformTable(deps, jobId, tenantId, 'groups', (raw) => mapGroup(raw as LdGroup), signal);

  // Enrollments tienen 2 sub-tipos
  await transformEnrollments(deps, jobId, tenantId, signal);

  await audit.append(tenantId, jobId, 'system', 'phase.completed', null, null, { phase: 'transform' });
  bus.emit(jobId, { type: 'phase.completed', phase: 'transform', counts: {}, at: nowIso() });
}

async function transformTable<TRaw>(
  deps: TransformerDeps,
  jobId: string,
  tenantId: string,
  table: StagingTable,
  mapper: (raw: TRaw) => MapResult<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const { staging, dlq, jobs, bus, logger } = deps;
  let cursor: string | undefined;
  let totalProcessed = 0;
  while (true) {
    if (signal?.aborted || (await jobs.isCancelling(jobId))) return;
    const batch = await staging.listAll(table, tenantId, jobId, BATCH, cursor);
    if (batch.length === 0) break;
    for (const row of batch) {
      const result = mapper(row.rawPayload as TRaw);
      if (result.ok) {
        await staging.setCanonical(table, row.id, result.canonical, true);
      } else {
        await staging.setCanonical(
          table,
          row.id,
          null,
          false,
          { errorCode: result.errorCode, errorMessage: result.errorMessage, warnings: result.warnings },
        );
        await dlq.add(
          tenantId,
          jobId,
          table,
          row.sourceId,
          'transform',
          result.errorCode,
          result.errorMessage,
          row.rawPayload,
        );
      }
    }
    totalProcessed += batch.length;
    const last = batch[batch.length - 1];
    if (!last) break;
    cursor = last.id;
    bus.emit(jobId, { type: 'phase.progress', phase: `transform:${table}`, current: totalProcessed, at: nowIso() });
  }
  logger.info('transform.table.done', { jobId, table, total: totalProcessed });
}

async function transformEnrollments(
  deps: TransformerDeps,
  jobId: string,
  tenantId: string,
  signal?: AbortSignal,
): Promise<void> {
  const { staging, dlq, jobs, bus, logger } = deps;
  let cursor: string | undefined;
  let total = 0;
  while (true) {
    if (signal?.aborted || (await jobs.isCancelling(jobId))) return;
    const batch = await staging.listAll('enrollments', tenantId, jobId, BATCH, cursor);
    if (batch.length === 0) break;
    for (const row of batch) {
      const raw = row.rawPayload as { id?: number; [k: string]: unknown };
      const meta = row as unknown as {
        sourceUserId?: string;
        sourceCourseId?: string | null;
        sourceGroupId?: string | null;
        enrollmentKind?: 'direct' | 'group';
      };
      // El stg.upsertEnrollment guardó las claves en raw_payload + columnas; aquí leemos el payload + reusamos parts.
      // En el modelo Prisma, `enrollment_kind` y `source_*_id` viven en columnas dedicadas, no en row.sourceId.
      // Aquí pasamos por el rawPayload para mappear el lado de "user" del enrollment.
      // El staging real provee cols extra; en esta fase asumimos que `raw` es un WpUser.
      const userPayload = raw as unknown as WpUser;
      let result: MapResult<unknown>;
      if (meta.enrollmentKind === 'group' && meta.sourceGroupId) {
        result = mapGroupEnrollment(meta.sourceGroupId, userPayload);
      } else if (meta.sourceCourseId) {
        result = mapDirectEnrollment(meta.sourceCourseId, userPayload);
      } else {
        result = {
          ok: false,
          errorCode: 'MISSING_DEPENDENCY',
          errorMessage: 'enrollment sin courseId ni groupId',
          warnings: [],
        };
      }
      if (result.ok) {
        await staging.setCanonical('enrollments', row.id, result.canonical, true);
      } else {
        await staging.setCanonical('enrollments', row.id, null, false, {
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        });
        await dlq.add(tenantId, jobId, 'enrollments', row.sourceId, 'transform', result.errorCode, result.errorMessage, row.rawPayload);
      }
      total += 1;
    }
    const last = batch[batch.length - 1];
    if (!last) break;
    cursor = last.id;
    bus.emit(jobId, { type: 'phase.progress', phase: 'transform:enrollments', current: total, at: nowIso() });
  }
  logger.info('transform.enrollments.done', { jobId, total });
}
