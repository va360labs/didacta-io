import {
  forwardRef,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from './module-context.factory';

const QUEUE_NAME = 'learnship.outbox';

interface OutboxJobData {
  /** ID de la fila `outbox_event` (BigInt serializado a string para BullMQ). */
  outboxId: string;
}

/**
 * Wrapper de BullMQ que encola jobs de despacho de eventos del outbox.
 *
 * Si `REDIS_URL` no está seteada, la cola NO se inicializa y el sistema cae
 * en el fallback in-process del PersistentEventBus (compat con dev local sin
 * Redis). En producción Easypanel `REDIS_URL` siempre está, así que el
 * dispatcher BullMQ es el camino normal.
 *
 * Por qué BullMQ vs el setInterval(30s) anterior:
 *  - reintentos exponenciales nativos
 *  - despacho async no bloquea el publish del evento
 *  - concurrencia controlable
 *  - facilita extraer el worker a un proceso separado en el futuro sin tocar
 *    el contrato de PersistentEventBus
 */
@Injectable()
export class OutboxQueueService implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue<OutboxJobData>;
  private worker?: Worker<OutboxJobData>;
  private connection?: Redis;
  private workerConnection?: Redis;

  constructor(
    @Inject(forwardRef(() => ModuleContextFactory))
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.warn(
        'REDIS_URL no seteada — outbox dispatcher cae en modo in-process (no recomendado en producción)',
      );
      return;
    }
    // En tests el bootstrap intenta conectar a Redis y rompe. Para health.e2e
    // (un único test que arranca AppModule entero) no tenemos Redis y no nos
    // interesa, así que skip explícito.
    if (process.env['NODE_ENV'] === 'test') {
      return;
    }

    // Connection para la Queue (publisher) y otra para el Worker. BullMQ
    // recomienda conexiones separadas para no mezclar comandos blocking.
    this.connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    this.workerConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });

    const connOptions: ConnectionOptions = this.connection;

    this.queue = new Queue<OutboxJobData>(QUEUE_NAME, {
      connection: connOptions,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 24 * 3600, count: 1_000 },
        removeOnFail: { age: 7 * 24 * 3600, count: 5_000 },
      },
    });

    this.worker = new Worker<OutboxJobData>(
      QUEUE_NAME,
      async (job) => {
        const eventBus = this.factory.getEventBus();
        const outboxId = BigInt(job.data.outboxId);
        await eventBus.processOutboxId(outboxId);
      },
      {
        connection: this.workerConnection,
        concurrency: 5,
      },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        { jobId: job?.id, attemptsMade: job?.attemptsMade, err: err.message },
        'outbox dispatch job falló',
      );
    });
    this.worker.on('completed', (job) => {
      this.logger.debug({ jobId: job.id }, 'outbox dispatch job completado');
    });

    this.logger.log('outbox dispatcher activo (BullMQ + Redis)');
  }

  isEnabled(): boolean {
    return this.queue !== undefined;
  }

  /**
   * Encola el despacho de un evento ya persistido en outbox_event.
   *
   * Usa el `outboxId` como `jobId` para que BullMQ deduplique automáticamente
   * si el mismo evento se reencola (ej. reintento + recovery worker).
   */
  async enqueue(outboxId: bigint): Promise<void> {
    if (!this.queue) {
      throw new Error('OutboxQueueService no inicializada (REDIS_URL ausente)');
    }
    await this.queue.add(
      'dispatch',
      { outboxId: outboxId.toString() },
      { jobId: outboxId.toString() },
    );
  }

  /** Health check de Redis. Devuelve true si PING contesta PONG. */
  async ping(): Promise<boolean> {
    if (!this.connection) return false;
    try {
      const pong = await this.connection.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.worker?.close();
    } catch (err) {
      this.logger.error({ err }, 'error cerrando outbox worker');
    }
    try {
      await this.queue?.close();
    } catch (err) {
      this.logger.error({ err }, 'error cerrando outbox queue');
    }
    try {
      await this.connection?.quit();
    } catch {
      /* noop */
    }
    try {
      await this.workerConnection?.quit();
    } catch {
      /* noop */
    }
  }
}
