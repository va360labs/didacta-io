/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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
import { enqueueOutboxJob, type OutboxJobQueuePort } from './outbox-enqueue';
import { OutboxMetrics } from './outbox.metrics';
import type { EnqueueOutcome, OutboxJobRef } from './persistent-event-bus';

const QUEUE_NAME = 'didacta.outbox';

interface OutboxJobData {
  /** ID de la fila `outbox_event` (BigInt serializado a string para BullMQ). */
  outboxId: string;
}

/**
 * Wrapper de BullMQ que encola jobs de despacho de eventos del outbox.
 *
 * Si `REDIS_URL` no está seteada, la cola NO se inicializa y el sistema cae
 * en el fallback in-process del PersistentEventBus (compat con dev local sin
 * Redis). En producción `REDIS_URL` siempre está, así que el
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
    private readonly metrics: OutboxMetrics,
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
        const start = process.hrtime.bigint();
        try {
          const eventBus = this.factory.getEventBus();
          const outboxId = BigInt(job.data.outboxId);
          await eventBus.processOutboxId(outboxId);
        } finally {
          // Sea cual sea el resultado, mide la duración. BullMQ solo emite
          // 'completed' tras éxito, así que el histograma del 'failed' lo
          // observamos desde aquí mismo.
          const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
          this.metrics.recordDispatchDuration(elapsed);
        }
      },
      {
        connection: this.workerConnection,
        concurrency: 5,
      },
    );

    this.worker.on('failed', (job, err) => {
      this.metrics.recordDispatchFailed();
      this.logger.error(
        { jobId: job?.id, attemptsMade: job?.attemptsMade, err: err.message },
        'outbox dispatch job falló',
      );
    });
    this.worker.on('completed', (job) => {
      this.metrics.recordDispatchCompleted();
      this.logger.debug({ jobId: job.id }, 'outbox dispatch job completado');
    });

    this.logger.log('outbox dispatcher activo (BullMQ + Redis)');
  }

  isEnabled(): boolean {
    return this.queue !== undefined;
  }

  /**
   * Cuántos workers hay ENCHUFADOS a esta cola en este Redis, contando los de
   * otros procesos.
   *
   * No es una curiosidad: BullMQ entrega cada job a **un solo** worker. Si dos
   * procesos distintos se suscriben a `didacta.outbox` sobre el mismo Redis,
   * los eventos se reparten entre ellos al azar, y los que se lleva el otro
   * proceso **jamás llegan a los bridges de éste** — pero la fila de
   * `outbox_event` vuelve marcada `processed_at` sin error, indistinguible de
   * una entrega correcta. Es exactamente el modo de fallo que dejó tres specs
   * E2E cayendo de forma intermitente durante varias sesiones: un API huérfano
   * de otra sesión seguía atado al Redis del arnés y se comía la mitad del
   * tráfico del bus.
   *
   * `getWorkers()` es de BullMQ y no necesita cooperación del otro proceso:
   * cada worker nombra su conexión bloqueante `bull:<base64(cola)>` al
   * conectarse, así que un binario viejo también se cuenta.
   *
   * En producción con N réplicas el valor esperado es N; el número no es
   * bueno ni malo por sí solo, por eso se EXPONE (health-detail) en vez de
   * convertirlo en un error aquí. Quien sabe cuántos debería haber es el
   * operador — o el arnés E2E, que sabe que debe ser exactamente 1.
   */
  async countWorkers(): Promise<number> {
    if (!this.queue) return 0;
    return (await this.queue.getWorkers()).length;
  }

  /**
   * Encola el despacho de un evento ya persistido en outbox_event.
   *
   * El `jobId` sigue derivándose de la fila para que BullMQ deduplique cuando
   * el mismo evento se reencola (publish + failsafe, o varias réplicas de la
   * API a la vez), pero ya no del BIGSERIAL a secas: ver `buildOutboxJobId`.
   *
   * Devuelve el desenlace en vez de `void` porque un `add` puede quedar
   * absorbido por un job terminal homónimo sin que BullMQ lo diga. El llamante
   * NECESITA distinguirlo: `recoverPending()` lo contaba como procesado y el
   * failsafe reportaba éxito sin haber entregado nada.
   */
  async enqueue(ref: OutboxJobRef): Promise<EnqueueOutcome> {
    const queue = this.queue;
    if (!queue) {
      throw new Error('OutboxQueueService no inicializada (REDIS_URL ausente)');
    }
    const outboxId = ref.id.toString();
    const port: OutboxJobQueuePort = {
      add: (jobId) => queue.add('dispatch', { outboxId }, { jobId }),
      remove: (jobId) => queue.remove(jobId),
    };
    return enqueueOutboxJob(port, ref, {
      onReplaced: (jobId) => {
        this.metrics.recordEnqueueCollision('replaced');
        this.logger.warn(
          { jobId, outboxId },
          'outbox enqueue chocó con un job ya terminado: retirado y reencolado',
        );
      },
      onSwallowed: (jobId) => {
        this.metrics.recordEnqueueCollision('swallowed');
        this.logger.error(
          { jobId, outboxId },
          'outbox enqueue absorbido por un job terminal irreemplazable: el evento NO se despachará por la cola',
        );
      },
    });
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
