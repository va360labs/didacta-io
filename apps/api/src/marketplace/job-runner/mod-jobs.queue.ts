import {
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { Logger as PinoLogger } from 'nestjs-pino';

/// Nombre canónico de la queue BullMQ. UNA sola queue para TODO el host
/// — el `tenantId` viaja en el payload, no en el nombre. Mismo patrón
/// que `outbox-queue.service.ts` (`didacta.outbox`).
export const MOD_JOBS_QUEUE_NAME = 'didacta.mod-jobs';

/// Payload del job. Todo lo que necesita el worker para invocar el
/// `onJobTick` del módulo correspondiente vive en el payload — el worker
/// NO consulta BD para resolver tenant/user/etc.
///
/// El `jobId` lógico es el UUID del registro en `mod_<slug>_jobs` del
/// módulo (cada módulo persiste sus propios jobs en su prefijo de tablas
/// vía ctx.db). El worker solo se lo pasa de vuelta al `onJobTick` —
/// el host no inspecciona la fila.
export interface ModJobPayload {
  /// Nombre del módulo, ej. "mod.migrator-learndash". Sirve para resolver
  /// el handler en el `ModuleJobLifecycleRegistry` y para logs/metrics.
  moduleName: string;
  /// UUID del job dentro del módulo. Opaco para el host.
  jobId: string;
  /// UUID del tenant. El worker lo propaga al ALS via TenantContextService
  /// antes de invocar `onJobTick` para que ctx.didacta y ctx.db lo lean.
  tenantId: string;
  /// Iteración actual del onJobTick. 0 = primera ejecución; cada
  /// re-encolado del worker incrementa el valor. Se usa también como
  /// dedupe key (`${moduleName}:${jobId}:${tickIndex}`) para que BullMQ
  /// rechace dos enqueues idénticos.
  tickIndex: number;
}

/**
 * Wrapper de BullMQ que encola jobs `mod-jobs` para los módulos third-party
 * del marketplace (Sprint 3 / JR-001).
 *
 * Por qué UNA queue y no una por tenant:
 *   - Aislamiento de carga por tenant se logra con el rate limiter del módulo
 *     (JR-? Sprint 4) y con el cap de concurrencia del worker. Una queue por
 *     tenant explotaría operacionalmente: un host con 1000 tenants tendría
 *     1000 queues + 1000 workers BullMQ = 1000+ conexiones Redis.
 *   - El `tenantId` viaja en el payload y el worker propaga el ALS via
 *     `TenantContextService.run({ tenantId, ... }, () => ...)` antes de
 *     invocar `onJobTick`. Así RLS + ctx.didacta funcionan idéntico que
 *     en un request HTTP.
 *
 * Si `REDIS_URL` no está seteada → la queue NO se inicializa. El módulo
 * que llame a `enqueue()` recibirá un error claro. En dev local sin
 * Redis, los jobs solo viven en la BD del módulo (mod_<slug>_jobs) y no
 * se procesan — el dev tiene que levantar Redis para verlos correr.
 *
 * En `NODE_ENV=test` también skip el bootstrap (consistencia con
 * `OutboxQueueService`).
 */
@Injectable()
export class ModJobsQueueService implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue<ModJobPayload>;
  private connection?: Redis;

  constructor(private readonly logger: PinoLogger) {}

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.warn(
        'REDIS_URL no seteada — mod-jobs queue deshabilitada. Los onJobTick de módulos third-party no se procesarán hasta que Redis esté disponible.',
      );
      return;
    }
    if (process.env['NODE_ENV'] === 'test') {
      // En tests no levantamos conexión a Redis; cualquier test que
      // necesite la queue mockea esta clase.
      return;
    }

    this.connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });

    const connOptions: ConnectionOptions = this.connection;

    this.queue = new Queue<ModJobPayload>(MOD_JOBS_QUEUE_NAME, {
      connection: connOptions,
      defaultJobOptions: {
        // Jobs de módulos suelen ser largos (migrator LearnDash puede
        // procesar miles de cursos en una corrida). Reintentos agresivos
        // no aportan: el módulo decide en su lógica si reintenta vía
        // re-encolar con `continue` o si marca fail definitivo. 3 attempts
        // cubren el caso transitorio de Redis hipo / DB timeout.
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 24 * 3600, count: 100 },
        removeOnFail: { age: 7 * 24 * 3600, count: 1_000 },
      },
    });

    this.logger.log(
      `mod-jobs queue activa (BullMQ + Redis) — queue=${MOD_JOBS_QUEUE_NAME}`,
    );
  }

  /// `true` si la queue se inicializó correctamente. Útil para que el
  /// worker decida si arrancar y para health checks.
  isEnabled(): boolean {
    return this.queue !== undefined;
  }

  /// Encola un job para invocar `onJobTick` del módulo. La dedupe key
  /// `${moduleName}:${jobId}:${tickIndex}` evita que dos enqueues idénticos
  /// del mismo tick generen dos jobs (caso típico: re-encolado defensivo
  /// tras crash del worker).
  ///
  /// `delaySec`: opcional. Si se provee, el job no se ejecuta hasta que
  /// pasen N segundos — usado por el worker cuando el `onJobTick` retorna
  /// `{ status: 'continue', delaySec: 30 }` (módulo pidió esperar antes
  /// del próximo tick).
  async enqueue(
    payload: ModJobPayload,
    opts: { delaySec?: number } = {},
  ): Promise<void> {
    if (!this.queue) {
      throw new Error(
        'ModJobsQueueService no inicializada (REDIS_URL ausente o NODE_ENV=test).',
      );
    }
    const jobId = `${payload.moduleName}:${payload.jobId}:${payload.tickIndex}`;
    const jobOpts: JobsOptions = { jobId };
    if (opts.delaySec !== undefined && opts.delaySec > 0) {
      jobOpts.delay = opts.delaySec * 1000;
    }
    await this.queue.add('tick', payload, jobOpts);
  }

  /// Health check de Redis. `true` si PING contesta. Mismo contrato que
  /// `OutboxQueueService.ping()`.
  async ping(): Promise<boolean> {
    if (!this.connection) return false;
    try {
      const pong = await this.connection.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  /// Acceso interno a la Queue para que el `ModJobsWorkerService` pueda
  /// re-encolar desde dentro del callback del worker sin pasar por
  /// `enqueue()` (evita logs duplicados y permite ajustar opts internos).
  /// Devuelve undefined si la queue no se inicializó.
  getQueue(): Queue<ModJobPayload> | undefined {
    return this.queue;
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.queue?.close();
    } catch (err) {
      this.logger.error({ err }, 'error cerrando mod-jobs queue');
    }
    try {
      await this.connection?.quit();
    } catch {
      /* noop */
    }
  }
}
