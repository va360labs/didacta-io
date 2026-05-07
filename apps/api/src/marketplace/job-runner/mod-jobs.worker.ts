import {
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from '../../modules/module-context.factory';
import { ModuleRegistryService } from '../../modules/module-registry.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { RateLimitedHttp, RateLimiterService } from '../rate-limiter.service';
import { SandboxedDbService } from '../sandboxed-db.service';
import { BlockedSandboxedDb, type SandboxedDb } from '../sandboxed-db.types';
import {
  ScopedDidactaApiFactory,
  type CoreServicesResolver,
} from '../sandboxed-didacta.service';
import { BlockedDidactaApi, type DidactaApi } from '../sandboxed-didacta.types';
import { SandboxedHttpService } from '../sandboxed-http.service';
import {
  BlockedSandboxedHttp,
  type SandboxedHttp,
} from '../sandboxed-http.types';
import { ModuleJobLifecycleRegistry } from './mod-jobs-lifecycle.registry';
import { ModJobsMetrics } from './mod-jobs.metrics';
import {
  MOD_JOBS_QUEUE_NAME,
  ModJobsQueueService,
  type ModJobPayload,
} from './mod-jobs.queue';
import type {
  JobTickResult,
  ModuleJobTickContext,
  ModuleJobTickHandler,
} from './mod-jobs.types';

/// Concurrencia del worker. 4 ticks en paralelo es un balance razonable:
/// suficiente para que un host con varios módulos no quede serializado en
/// un tick lento, pero bajo para no saturar la BD ni APIs externas (cada
/// tick consume conexión Prisma + posiblemente HTTP saliente). Si en el
/// futuro hay módulos CPU-intensive vamos a querer un worker dedicado en
/// otro proceso — esa migración no rompe el contrato (el tick solo usa
/// ctx.* y no comparte memoria con el host).
const WORKER_CONCURRENCY = 4;

/// Timeout duro por tick. 5 minutos es generoso: un tick típico procesa
/// un batch (50-100 cursos del migrator, page de 100 lessons, etc.) y
/// debería volver bajo el minuto. Si pasa de 5 min, el handler está
/// haciendo algo mal (sync I/O bloqueante, query sin index, etc.) — se
/// aborta y se re-encola con backoff. NO se considera fallo terminal:
/// el módulo puede recuperarse en el próximo tick (estado idempotente
/// vía mod_<slug>_jobs).
const TICK_TIMEOUT_MS = 5 * 60 * 1000;

/// Backoff fijo cuando el tick fue abortado por timeout o lanzó excepción
/// no controlada. 10s es suficiente para que un transitorio (DB hipo,
/// API externa lenta) se recupere antes del próximo tick. Para pacing
/// más fino el handler usa `{ status: 'continue', delaySec }`.
const ERROR_BACKOFF_SEC = 10;

/**
 * Worker BullMQ que procesa los jobs `mod-jobs` invocando el `onJobTick`
 * del módulo correspondiente (Sprint 3 / JR-002).
 *
 * Pipeline por job:
 *   1. Resolver entry en `ModuleJobLifecycleRegistry`. Si el módulo no
 *      está registrado (desinstalado mientras el job estaba encolado) →
 *      log error + skip (no re-encolar — el job está huérfano).
 *   2. Construir `ctx`: db / http / didacta scoped al módulo + tenant.
 *      Mismo patrón que `ModulesDispatcherController.dispatch` pero sin
 *      AbortSignal del reply de Fastify (no hay reply en un job).
 *   3. **Propagar tenant context al ALS** vía `TenantContextService.run({
 *      tenantId, userId: undefined, traceId: ... }, () => invokeHandler())`.
 *      CRÍTICO: BullMQ workers corren fuera del request context — el ALS
 *      del TenantContextService está vacío. Sin este `run()`, ctx.didacta
 *      lanzaría `DIDACTA_NO_TENANT_CONTEXT` y ctx.db no aplicaría RLS.
 *   4. Invocar `handler(ctx)` con `Promise.race` contra timeout (5 min).
 *      Tres outcomes posibles:
 *        - `continue` → re-encolar con `tickIndex + 1` y `delaySec`.
 *        - `completed` → no re-encolar (job exitoso).
 *        - `failed` → no re-encolar (job fallido, módulo lo registra en
 *          su tabla mod_<slug>_jobs vía ctx.db).
 *      Errores adicionales:
 *        - timeout → re-encolar con backoff + log warn.
 *        - excepción → re-encolar con backoff + log error.
 *
 * Diferencia clave con `OutboxQueueService`: el outbox dispatch NO necesita
 * tenant context (procesa eventos del outbox con metadata.tenantId que va
 * a SQS / webhooks externos). Acá el handler corre lógica DEL MÓDULO que
 * espera RLS activo + ctx.didacta resolviendo tenantId del ALS.
 */
@Injectable()
export class ModJobsWorkerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private worker?: Worker<ModJobPayload>;
  private workerConnection?: Redis;

  constructor(
    private readonly queueService: ModJobsQueueService,
    private readonly registry: ModuleJobLifecycleRegistry,
    private readonly dbService: SandboxedDbService,
    private readonly httpService: SandboxedHttpService,
    private readonly rateLimiter: RateLimiterService,
    private readonly didactaFactory: ScopedDidactaApiFactory,
    private readonly moduleRegistry: ModuleRegistryService,
    private readonly contextFactory: ModuleContextFactory,
    private readonly tenantContext: TenantContextService,
    private readonly metrics: ModJobsMetrics,
    private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.warn(
        'REDIS_URL no seteada — mod-jobs worker NO arrancado. Los onJobTick de módulos third-party no se procesarán.',
      );
      return;
    }
    if (process.env['NODE_ENV'] === 'test') {
      // En tests no levantamos el worker BullMQ; los tests del worker
      // mockean la queue + registry e invocan el callback directamente.
      return;
    }

    // Connection dedicada para el worker (BullMQ recomienda separar
    // publisher de worker). Mismo patrón que `OutboxQueueService`.
    this.workerConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    const connOptions: ConnectionOptions = this.workerConnection;

    this.worker = new Worker<ModJobPayload>(
      MOD_JOBS_QUEUE_NAME,
      async (job) => {
        await this.processTick(job);
      },
      {
        connection: connOptions,
        concurrency: WORKER_CONCURRENCY,
      },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        {
          jobId: job?.id,
          module: job?.data?.moduleName,
          tickIndex: job?.data?.tickIndex,
          attemptsMade: job?.attemptsMade,
          err: err.message,
        },
        'mod-jobs tick falló a nivel BullMQ (no re-encolado por el handler)',
      );
    });

    this.logger.log(
      `mod-jobs worker activo (concurrency=${WORKER_CONCURRENCY}, timeout=${TICK_TIMEOUT_MS}ms)`,
    );
  }

  /// Procesa un tick. Pública solo para tests — en runtime la invoca el
  /// callback del Worker BullMQ. Encapsula resolver registry, construir
  /// ctx, propagar tenant ALS, ejecutar handler con timeout, decidir
  /// re-encolar o no.
  async processTick(job: Job<ModJobPayload>): Promise<void> {
    const payload = job.data;
    const startedAt = Date.now();
    const entry = this.registry.get(payload.moduleName);

    if (!entry) {
      // Módulo desinstalado mientras el job estaba en cola. Log + skip.
      // NO re-encolar — el job está huérfano y volvería a fallar igual
      // hasta que removeOnFail lo limpie.
      this.metrics.recordTick(payload.moduleName, 'unregistered');
      this.logger.warn(
        {
          jobId: payload.jobId,
          module: payload.moduleName,
          tickIndex: payload.tickIndex,
        },
        'mod-jobs tick recibido pero el módulo no tiene handler registrado (desinstalado o sin jobLifecycle)',
      );
      return;
    }

    const ctx = this.buildTickContext(payload, entry.manifest);

    // Propagación tenant context al ALS. CRÍTICO: sin esto el handler
    // corre fuera del scope del TenantContextService y ctx.didacta
    // lanza DIDACTA_NO_TENANT_CONTEXT. El traceId es único por
    // (jobId, tickIndex) para que los logs del módulo se puedan
    // correlacionar entre ticks.
    const traceId = `mod-job-${payload.jobId}-${payload.tickIndex}`;
    let result: JobTickResult;
    let outcome: 'continue' | 'completed' | 'failed' | 'timeout' | 'error';
    try {
      result = await this.tenantContext.run(
        { tenantId: payload.tenantId, userId: undefined, traceId },
        () => runWithTimeout(entry.handler, ctx, TICK_TIMEOUT_MS),
      );
      outcome = result.status;
    } catch (err) {
      const isTimeout = err instanceof TickTimeoutError;
      outcome = isTimeout ? 'timeout' : 'error';
      const message = err instanceof Error ? err.message : String(err);
      if (isTimeout) {
        this.logger.warn(
          {
            jobId: payload.jobId,
            module: payload.moduleName,
            tickIndex: payload.tickIndex,
            timeoutMs: TICK_TIMEOUT_MS,
          },
          'mod-jobs tick excedió el timeout duro — re-encolando con backoff',
        );
      } else {
        this.logger.error(
          {
            jobId: payload.jobId,
            module: payload.moduleName,
            tickIndex: payload.tickIndex,
            err: message,
          },
          'mod-jobs tick lanzó excepción no controlada — re-encolando con backoff',
        );
      }
      // Re-encolar con backoff fijo para timeouts y errores no
      // controlados. El módulo decide en su propia lógica si quiere
      // marcar el job como fallido (vía status: 'failed' en el próximo
      // tick) o seguir reintentando.
      await this.requeueWithBackoff(payload, ERROR_BACKOFF_SEC);
      this.metrics.recordTick(payload.moduleName, outcome);
      this.metrics.recordTickDuration(
        payload.moduleName,
        (Date.now() - startedAt) / 1000,
      );
      return;
    }

    this.metrics.recordTick(payload.moduleName, outcome);
    this.metrics.recordTickDuration(
      payload.moduleName,
      (Date.now() - startedAt) / 1000,
    );

    if (result.status === 'continue') {
      await this.requeueWithBackoff(payload, result.delaySec ?? 0);
      return;
    }
    if (result.status === 'failed') {
      this.logger.warn(
        {
          jobId: payload.jobId,
          module: payload.moduleName,
          tickIndex: payload.tickIndex,
          reason: result.reason,
        },
        'mod-jobs tick retornó failed — job no se re-encola',
      );
      return;
    }
    // status === 'completed' → no re-encolar, OK silencioso (logs los
    // emite el módulo si quiere via ctx.log).
  }

  /// Re-encola el job para el siguiente tick con `tickIndex + 1` y el
  /// `delaySec` indicado. Si la queue no está disponible (caso edge:
  /// destroy en curso) loguea y abandona — el job queda perdido pero el
  /// módulo puede recuperarlo en el próximo bootstrap leyendo su tabla
  /// mod_<slug>_jobs (estado persistido por el módulo).
  private async requeueWithBackoff(
    payload: ModJobPayload,
    delaySec: number,
  ): Promise<void> {
    if (!this.queueService.isEnabled()) {
      this.logger.error(
        {
          jobId: payload.jobId,
          module: payload.moduleName,
          tickIndex: payload.tickIndex,
        },
        'mod-jobs queue no disponible — no se pudo re-encolar el siguiente tick',
      );
      return;
    }
    try {
      await this.queueService.enqueue(
        {
          moduleName: payload.moduleName,
          jobId: payload.jobId,
          tenantId: payload.tenantId,
          tickIndex: payload.tickIndex + 1,
        },
        { delaySec },
      );
    } catch (err) {
      this.logger.error(
        {
          jobId: payload.jobId,
          module: payload.moduleName,
          tickIndex: payload.tickIndex,
          err: err instanceof Error ? err.message : String(err),
        },
        'fallo al re-encolar mod-jobs tick — job perdido',
      );
    }
  }

  /// Construye el ctx que el handler recibe. Mismo wiring que el
  /// dispatcher pero sin AbortSignal y sin user/method/path/etc.
  private buildTickContext(
    payload: ModJobPayload,
    manifest: {
      httpConfig: import('../module-manifest.schema').ModuleHttpConfig | null;
      dbEnabled: boolean;
      tablePrefix: string;
      didactaConfig: import('../module-manifest.schema').ModuleDidactaConfig | null;
      moduleVersion: string;
    },
  ): ModuleJobTickContext {
    const db: SandboxedDb = manifest.dbEnabled
      ? this.dbService.build(payload.moduleName, manifest.tablePrefix, payload.tenantId)
      : new BlockedSandboxedDb(payload.moduleName);

    let http: SandboxedHttp;
    if (manifest.httpConfig) {
      const inner = this.httpService.build(payload.moduleName, manifest.httpConfig);
      http = new RateLimitedHttp(
        inner,
        this.rateLimiter,
        payload.moduleName,
        manifest.httpConfig.rateLimitPerHost,
      );
    } else {
      http = new BlockedSandboxedHttp(payload.moduleName);
    }

    let didacta: DidactaApi;
    if (manifest.didactaConfig) {
      const resolver: CoreServicesResolver = {
        getCoursesService: () => this.moduleRegistry.getCoursesService(),
        getLearningService: () => this.moduleRegistry.getLearningService(),
        getAssessmentsService: () => this.moduleRegistry.getAssessmentsService(),
        getWebBaseUrl: () =>
          process.env['WEB_BASE_URL'] ?? 'http://localhost:3000',
        getStorage: () => this.contextFactory.getStorage(),
      };
      didacta = this.didactaFactory.build(
        payload.moduleName,
        manifest.didactaConfig,
        resolver,
      );
    } else {
      didacta = new BlockedDidactaApi(payload.moduleName);
    }

    return {
      moduleName: payload.moduleName,
      moduleVersion: manifest.moduleVersion,
      jobId: payload.jobId,
      tenantId: payload.tenantId,
      tickIndex: payload.tickIndex,
      log: (level, message) => {
        const logFn = this.logger[level].bind(this.logger);
        logFn(
          { module: payload.moduleName, jobId: payload.jobId, tickIndex: payload.tickIndex },
          `[mod:${payload.moduleName}] ${message}`,
        );
      },
      db,
      http,
      didacta,
    };
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.worker?.close();
    } catch (err) {
      this.logger.error({ err }, 'error cerrando mod-jobs worker');
    }
    try {
      await this.workerConnection?.quit();
    } catch {
      /* noop */
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internos (exportados para tests)
// ─────────────────────────────────────────────────────────────────────────────

/// Marker error que distingue timeout duro del worker de cualquier otro
/// error que el handler pueda lanzar. Permite a `processTick` decidir si
/// reportar como `timeout` (warn) o `error` (error) en logs/metrics.
export class TickTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`onJobTick excedió el timeout de ${timeoutMs}ms`);
    this.name = 'TickTimeoutError';
  }
}

/// Ejecuta el handler con `Promise.race` contra un timeout. Si vence el
/// timeout, lanza `TickTimeoutError`. Si el handler era sync y retornó,
/// devuelve el valor sin esperar al timer (`Promise.race` resuelve en
/// la primera). El timer se limpia en finally para no acumular handles.
export async function runWithTimeout(
  handler: ModuleJobTickHandler,
  ctx: ModuleJobTickContext,
  timeoutMs: number,
): Promise<JobTickResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TickTimeoutError(timeoutMs)), timeoutMs);
    timer.unref();
  });
  try {
    const result = handler(ctx);
    if (!(result instanceof Promise)) {
      // Sync return — no necesitamos race, evita creación innecesaria
      // de la promesa de timeout.
      return result;
    }
    return await Promise.race([result, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
