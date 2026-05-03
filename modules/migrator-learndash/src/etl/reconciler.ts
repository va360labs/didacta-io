import type {
  AuditPort,
  DlqPort,
  JobsPort,
  Logger,
  MappingsPort,
  ReportsPort,
  StagingPort,
  StagingTable,
} from './ports.js';
import type { ProgressBus } from './progress.js';
import { nowIso } from './progress.js';

export interface ReconcilerDeps {
  jobs: JobsPort;
  staging: StagingPort;
  mappings: MappingsPort;
  dlq: DlqPort;
  audit: AuditPort;
  reports: ReportsPort;
  bus: ProgressBus;
  logger: Logger;
}

const ENTITIES: { table: StagingTable; entityType: string }[] = [
  { table: 'users', entityType: 'user' },
  { table: 'media', entityType: 'media' },
  { table: 'courses', entityType: 'course' },
  { table: 'lessons', entityType: 'lesson' },
  { table: 'topics', entityType: 'topic' },
  { table: 'quizzes', entityType: 'quiz' },
  { table: 'questions', entityType: 'question' },
  { table: 'groups', entityType: 'group' },
  { table: 'enrollments', entityType: 'enrollment' },
];

/**
 * Fase RECONCILE: cuenta lo que cargó vs lo que falló por entidad y
 * persiste un ValidationReport. Al final emite job.completed.
 */
export async function runReconcile(
  deps: ReconcilerDeps,
  jobId: string,
  tenantId: string,
): Promise<void> {
  const { jobs, audit, bus, reports, staging, dlq, mappings, logger } = deps;

  await jobs.updateStatus(jobId, 'reconciling', 'reconcile:start');
  await audit.append(tenantId, jobId, 'system', 'phase.started', null, null, { phase: 'reconcile' });
  bus.emit(jobId, { type: 'phase.started', phase: 'reconcile', at: nowIso() });

  const summary: { entityType: string; sourceCount: number; loadedCount: number; skippedCount: number; failedCount: number }[] = [];

  for (const { table, entityType } of ENTITIES) {
    const stagedCount = await staging.count(table, tenantId, jobId);
    const validCount = await staging.countValid(table, tenantId, jobId);
    const loadedCount = await staging.countLoaded(table, tenantId, jobId);
    const skippedCount = await mappings.countByStatus(tenantId, jobId, entityType, 'skipped');
    const failedCount = await mappings.countByStatus(tenantId, jobId, entityType, 'failed');
    const failureGroups = await dlq.groupByErrorCode(tenantId, jobId, table);
    const failureReasons = failureGroups.map((g) => ({ code: g.code, count: g.count, sample: g.samples.slice(0, 5) }));

    await reports.upsert(
      tenantId,
      jobId,
      entityType,
      {
        sourceCount: stagedCount, // approximation: we use stagedCount as proxy for source
        stagedCount,
        validCount,
        loadedCount,
        skippedCount,
        failedCount,
      },
      undefined,
      failureReasons,
    );
    summary.push({ entityType, sourceCount: stagedCount, loadedCount, skippedCount, failedCount });
    logger.info('reconcile.entity.done', { jobId, entityType, stagedCount, validCount, loadedCount, failedCount });
  }

  await audit.append(tenantId, jobId, 'system', 'phase.completed', null, null, { phase: 'reconcile' });
  bus.emit(jobId, { type: 'phase.completed', phase: 'reconcile', counts: {}, at: nowIso() });

  await jobs.complete(jobId);
  await audit.append(tenantId, jobId, 'system', 'job.completed', null, null, { summary });
  bus.emit(jobId, { type: 'job.completed', summary, at: nowIso() });
}
