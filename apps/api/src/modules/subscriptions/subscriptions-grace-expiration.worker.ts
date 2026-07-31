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
import { ModuleRegistryService } from '../module-registry.service';

const QUEUE_NAME = 'didacta.subscriptions.grace-expiration';
const REPEAT_PATTERN = process.env['SUBSCRIPTIONS_GRACE_EXPIRATION_CRON'] ?? '0 * * * *'; // Cada hora en punto UTC

// El job no necesita parámetros: opera sobre todas las subs en PAST_DUE con
// `gracePeriodEndsAt < now` del tenant-set completo. Mantenemos la forma del
// data record para futura extensibilidad (filtros por tenant, dry-run, etc).
type GraceExpirationJobData = Record<string, never>;

/**
 * Worker BullMQ que ejecuta el barrido de grace periods de mod.subscriptions.
 * Cada hora en punto UTC (configurable vía `SUBSCRIPTIONS_GRACE_EXPIRATION_CRON`):
 *
 *  1. Llama `SubscriptionsService.expireGracePeriods()` que:
 *     - lee subs en PAST_DUE con `gracePeriodEndsAt < now`,
 *     - las marca UNPAID,
 *     - emite `subscriptions.subscription.unpaid` por cada una.
 *  2. El bridge `SubscriptionsLearningBridge` escucha el evento y pausa el
 *     enrollment correspondiente (sin borrar progreso).
 *
 * Si REDIS_URL no está set, el worker no arranca (warn). En tests
 * (NODE_ENV=test) tampoco, para no romper bootstraps de Nest sin Redis.
 *
 * Si mod.subscriptions no está inicializado (faltan STRIPE_SECRET_KEY /
 * STRIPE_WEBHOOK_SECRET), el job loguea warn y no hace nada. Esto es
 * intencional: el cron está siempre activo en bootstrap pero es no-op si el
 * módulo no está configurado en este tenant-set.
 *
 * Endpoint manual `POST /modules/subscriptions/admin/grace-expiration/run-now`
 * (super_admin) permite disparar el job sin esperar la cron — útil para QA.
 */
@Injectable()
export class SubscriptionsGraceExpirationWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue<GraceExpirationJobData>;
  private worker?: Worker<GraceExpirationJobData>;
  private connection?: Redis;
  private workerConnection?: Redis;

  constructor(
    @Inject(forwardRef(() => ModuleRegistryService))
    private readonly registry: ModuleRegistryService,
    private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.warn(
        'REDIS_URL no seteada — subscriptions grace-expiration scheduler no arranca',
      );
      return;
    }
    if (process.env['NODE_ENV'] === 'test') return;

    this.connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    this.workerConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    const conn: ConnectionOptions = this.connection;

    this.queue = new Queue<GraceExpirationJobData>(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 30 * 24 * 3600, count: 50 },
        removeOnFail: { age: 30 * 24 * 3600, count: 50 },
      },
    });

    this.worker = new Worker<GraceExpirationJobData>(
      QUEUE_NAME,
      async () => {
        await this.processJob();
      },
      { connection: this.workerConnection, concurrency: 1 },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        { jobId: job?.id, err: err.message },
        'subscriptions grace-expiration job falló',
      );
    });

    // Repeatable: cada hora en punto. BullMQ deduplica el repeat key con la
    // combinación (jobId base + pattern), así que rebootear no duplica.
    await this.queue.add('hourly', {} as GraceExpirationJobData, {
      repeat: { pattern: REPEAT_PATTERN, tz: 'UTC' },
      jobId: 'hourly-grace-expiration', // estable
    });

    this.logger.log(
      `subscriptions grace-expiration scheduler activo (cron='${REPEAT_PATTERN}' UTC)`,
    );
  }

  /**
   * Punto de entrada manual para el endpoint super_admin: encola un job
   * inmediato. Si no hay Redis (tests, bootstrap sin REDIS_URL), ejecuta
   * in-process en modo degraded.
   */
  async triggerNow(): Promise<void> {
    if (!this.queue) {
      // Sin Redis → ejecución in-process. Mismo patrón que CommunityDigestWorker.
      await this.processJob();
      return;
    }
    await this.queue.add('hourly-manual', {} as GraceExpirationJobData, {
      jobId: `manual-${Date.now()}`,
    });
  }

  /**
   * Lógica del job: invoca `SubscriptionsService.expireGracePeriods()` y
   * loguea el resultado. Si el módulo no está inicializado, warn y exit.
   */
  private async processJob(): Promise<void> {
    let service;
    try {
      service = this.registry.getSubscriptionsService();
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'subscriptions grace-expiration: mod.subscriptions no inicializado — job no-op',
      );
      return;
    }

    const startedAt = Date.now();
    try {
      const expired = await service.expireGracePeriods();
      const elapsedMs = Date.now() - startedAt;
      this.logger.log(
        { count: expired.length, elapsedMs },
        'subscriptions grace-expiration job completado',
      );
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'subscriptions grace-expiration: expireGracePeriods() lanzó error',
      );
      throw err; // re-lanzamos para que BullMQ aplique retry exponencial
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.worker?.close();
    } catch {
      /* noop */
    }
    try {
      await this.queue?.close();
    } catch {
      /* noop */
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
