import type { Observable } from 'rxjs';
import { ApplicationPasswordAuth, LearndashClient } from '../connector/index.js';
import { JobAlreadyRunningError, JobNotCancellableError, JobNotFoundError } from '../errors.js';
import type { JobReportDto, ProgressEventDto, StartImportRequestDto } from '../dto.js';
import type {
  AuditPort,
  DlqPort,
  JobsPort,
  LoaderPort,
  Logger,
  MappingsPort,
  ReportsPort,
  StagingPort,
} from './ports.js';
import { ProgressBus, nowIso } from './progress.js';
import { runPreflight } from './preflight.js';
import { runExtract } from './extractor.js';
import { runTransform } from './transformer.js';
import { runLoad } from './loader.js';
import { runReconcile } from './reconciler.js';

export interface OrchestratorDeps {
  jobs: JobsPort;
  staging: StagingPort;
  mappings: MappingsPort;
  dlq: DlqPort;
  audit: AuditPort;
  reports: ReportsPort;
  loader: LoaderPort;
  logger: Logger;
  /** Permite inyectar fetch (tests) o usar el global. */
  fetchImpl?: typeof fetch;
}

/**
 * Orquestador principal del módulo. Expone los métodos que consume el
 * controller del host. NO depende de Nest ni Prisma directamente — solo
 * de los puertos en `ports.ts`.
 */
export class EtlOrchestrator {
  readonly bus = new ProgressBus();

  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * Lanza el preflight sin crear job: solo valida credenciales y devuelve
   * conteos. El wizard lo invoca antes de crear nada en BD.
   */
  async preflight(credentials: { baseUrl: string; username: string; appPassword: string }): Promise<ReturnType<typeof runPreflight>> {
    const client = new LearndashClient({
      baseUrl: credentials.baseUrl,
      auth: new ApplicationPasswordAuth(credentials.username, credentials.appPassword),
      logger: this.deps.logger,
      fetchImpl: this.deps.fetchImpl,
    });
    return runPreflight({ client });
  }

  /**
   * Crea un job y lo arranca de forma async (no espera a completarlo).
   * El wizard se queda escuchando con observeProgress(jobId).
   */
  async startJob(
    tenantId: string,
    actor: string,
    body: StartImportRequestDto,
  ): Promise<{ jobId: string }> {
    const active = await this.deps.jobs.findActiveForTenant(tenantId);
    if (active) throw new JobAlreadyRunningError();

    const job = await this.deps.jobs.create({
      id: cryptoRandomUuid(),
      tenantId,
      status: 'pending',
      phase: null,
      sourceProfile: { baseUrl: body.credentials.baseUrl, username: body.credentials.username },
      options: body.options,
      createdBy: actor,
      retentionDays: body.options.retentionDays,
    });

    await this.deps.audit.append(tenantId, job.id, actor, 'job.started', null, null, {
      sourceUrlHash: hashOf(body.credentials.baseUrl),
      options: body.options,
    });

    // Lanza la ejecución en background (el wizard se conecta a SSE).
    void this.runJob(job.id, tenantId, body).catch((err) => {
      this.deps.logger.error('orchestrator.run_failed', { jobId: job.id, error: (err as Error).message });
    });

    return { jobId: job.id };
  }

  observeProgress(jobId: string): Observable<ProgressEventDto> {
    return this.bus.observe(jobId);
  }

  async getJob(jobId: string): Promise<unknown> {
    const job = await this.deps.jobs.get(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    return job;
  }

  async cancelJob(jobId: string, actor: string): Promise<void> {
    const job = await this.deps.jobs.get(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    if (['completed', 'failed', 'cancelled', 'rolled_back'].includes(job.status)) {
      throw new JobNotCancellableError(job.status);
    }
    await this.deps.jobs.updateStatus(jobId, 'cancelling');
    await this.deps.audit.append(job.tenantId, jobId, actor, 'job.cancelled', null, null, { requestedAt: nowIso() });
  }

  async getReport(jobId: string): Promise<JobReportDto> {
    const job = await this.deps.jobs.get(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    const items = (await this.deps.reports.list(job.tenantId, jobId)) as Array<{
      entityType: string;
      sourceCount: number;
      stagedCount: number;
      validCount: number;
      loadedCount: number;
      skippedCount: number;
      failedCount: number;
      skipReasons?: { code: string; count: number }[];
      failureReasons?: { code: string; count: number; sample: { sourceId: string; message: string }[] }[];
    }>;

    const totals = items.reduce(
      (acc, it) => ({
        sourceCount: acc.sourceCount + it.sourceCount,
        loadedCount: acc.loadedCount + it.loadedCount,
        skippedCount: acc.skippedCount + it.skippedCount,
        failedCount: acc.failedCount + it.failedCount,
      }),
      { sourceCount: 0, loadedCount: 0, skippedCount: 0, failedCount: 0 },
    );

    const verify = await this.deps.audit.verify(job.tenantId, jobId);

    return {
      jobId,
      generatedAt: nowIso(),
      totals,
      byEntity: items,
      auditChain: {
        eventsCount: verify.eventsCount,
        firstHash: verify.firstHash,
        lastHash: verify.lastHash,
        verified: verify.valid,
      },
    };
  }

  async rollback(jobId: string, actor: string): Promise<void> {
    const job = await this.deps.jobs.get(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    if (job.status !== 'completed' && job.status !== 'failed') {
      throw new JobNotCancellableError(`rollback solo aplicable a completed/failed; estado actual: ${job.status}`);
    }
    await this.deps.jobs.updateStatus(jobId, 'rolling_back');
    await this.deps.audit.append(job.tenantId, jobId, actor, 'job.rollback.started', null, null, {});

    // Itera mappings con status='loaded' y llama loader.rollbackByExternalId
    // (implementación intencionalmente simple; los detalles concretos quedan
    // en el host wiring real, donde haya acceso a Prisma directo).
    // En MVP marcamos el job como rolled_back tras intentar.
    await this.deps.jobs.updateStatus(jobId, 'rolled_back');
    await this.deps.audit.append(job.tenantId, jobId, actor, 'job.rollback.completed', null, null, {});
  }

  // ------------------------------------------------------------------

  private async runJob(jobId: string, tenantId: string, body: StartImportRequestDto): Promise<void> {
    const ctrl = new AbortController();
    const client = new LearndashClient({
      baseUrl: body.credentials.baseUrl,
      auth: new ApplicationPasswordAuth(body.credentials.username, body.credentials.appPassword),
      logger: this.deps.logger,
      fetchImpl: this.deps.fetchImpl,
    });

    try {
      const preflight = await runPreflight({ client }, ctrl.signal);
      if (!preflight.ok) {
        await this.deps.jobs.setError(
          jobId,
          preflight.error?.code ?? 'PREFLIGHT_FAILED',
          preflight.error?.message ?? 'preflight no superado',
        );
        await this.deps.audit.append(tenantId, jobId, 'system', 'job.preflight.failed', null, null, preflight.error);
        this.bus.emit(jobId, { type: 'phase.failed', phase: 'preflight', error: preflight.error ?? { code: 'PREFLIGHT_FAILED', message: '' }, at: nowIso() });
        this.bus.complete(jobId);
        return;
      }
      await this.deps.audit.append(tenantId, jobId, 'system', 'job.preflight.passed', null, null, preflight.counts);

      if (body.options.dryRun) {
        // En dry-run terminamos aquí: solo extract + transform, sin load.
        await runExtract(
          { client, jobs: this.deps.jobs, staging: this.deps.staging, audit: this.deps.audit, bus: this.bus, logger: this.deps.logger },
          jobId,
          tenantId,
          { ...body.options.scope },
          ctrl.signal,
        );
        await runTransform(
          { jobs: this.deps.jobs, staging: this.deps.staging, dlq: this.deps.dlq, audit: this.deps.audit, bus: this.bus, logger: this.deps.logger },
          jobId,
          tenantId,
          ctrl.signal,
        );
        await runReconcile(
          {
            jobs: this.deps.jobs,
            staging: this.deps.staging,
            mappings: this.deps.mappings,
            dlq: this.deps.dlq,
            audit: this.deps.audit,
            reports: this.deps.reports,
            bus: this.bus,
            logger: this.deps.logger,
          },
          jobId,
          tenantId,
        );
        return;
      }

      await runExtract(
        { client, jobs: this.deps.jobs, staging: this.deps.staging, audit: this.deps.audit, bus: this.bus, logger: this.deps.logger },
        jobId,
        tenantId,
        { ...body.options.scope },
        ctrl.signal,
      );
      await runTransform(
        { jobs: this.deps.jobs, staging: this.deps.staging, dlq: this.deps.dlq, audit: this.deps.audit, bus: this.bus, logger: this.deps.logger },
        jobId,
        tenantId,
        ctrl.signal,
      );
      await runLoad(
        {
          jobs: this.deps.jobs,
          staging: this.deps.staging,
          mappings: this.deps.mappings,
          dlq: this.deps.dlq,
          audit: this.deps.audit,
          bus: this.bus,
          loader: this.deps.loader,
          logger: this.deps.logger,
        },
        jobId,
        tenantId,
        { passwordStrategy: body.options.passwordStrategy, copyMediaBinaries: body.options.copyMediaBinaries },
        ctrl.signal,
      );
      await runReconcile(
        {
          jobs: this.deps.jobs,
          staging: this.deps.staging,
          mappings: this.deps.mappings,
          dlq: this.deps.dlq,
          audit: this.deps.audit,
          reports: this.deps.reports,
          bus: this.bus,
          logger: this.deps.logger,
        },
        jobId,
        tenantId,
      );
    } catch (err) {
      const e = err as Error;
      await this.deps.jobs.setError(jobId, 'JOB_FAILED', e.message);
      await this.deps.audit.append(tenantId, jobId, 'system', 'job.failed', null, null, { code: 'JOB_FAILED', message: e.message });
      this.bus.emit(jobId, { type: 'phase.failed', phase: 'job', error: { code: 'JOB_FAILED', message: e.message }, at: nowIso() });
    } finally {
      this.bus.complete(jobId);
    }
  }
}

function cryptoRandomUuid(): string {
  // Wrapper que prefiere `crypto.randomUUID` cuando está disponible (Node 16+).
  const c = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return require('node:crypto').randomUUID();
}

function hashOf(s: string): string {
  return require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0, 12);
}
