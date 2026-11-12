/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PayoutsReconcilerService, type ReconcileReport } from '@didacta/mod-payouts';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PayoutsRuntime } from './payouts-runtime.service';
import {
  PLATFORM_EVENT_DISPATCHER,
  type PlatformEventDispatcher,
} from './platform-event-dispatcher';
import { PlatformEventProcessor } from './platform-event-processor';

const QUEUE_NAME = 'didacta.payouts.reconcile';
/** Pasada horaria (ventana de 6 h). */
const HOURLY_PATTERN = process.env['PAYOUTS_RECONCILE_CRON'] ?? '7 * * * *';
/** Pasada profunda diaria (ventana de 72 h, invariantes de todas las ventas). */
const DEEP_PATTERN = process.env['PAYOUTS_RECONCILE_DEEP_CRON'] ?? '40 3 * * *';

export type PayoutsReconcileJobData = { readonly deep: boolean };

/**
 * Conciliador de cobros de plataforma (BullMQ, patrón de
 * `subscriptions-grace-expiration.worker.ts`): cada hora y una pasada profunda
 * al día. Qué hace, en `modules/payouts/src/reconciler.service.ts`.
 *
 * Los eventos perdidos se reproducen con el MISMO `PlatformEventProcessor`
 * que usa el webhook: mismo registro, mismas comprobaciones, mismo reparto a
 * los módulos (un pedido cobrado sin acceso recibe su acceso).
 *
 * Sin `REDIS_URL` no se programa; queda el disparo manual
 * (`POST /modules/payouts/admin/reconcile/run-now`, solo `super_admin`).
 */
@Injectable()
export class PayoutsReconcileWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly reconciler: PayoutsReconcilerService;
  private queue?: Queue<PayoutsReconcileJobData>;
  private worker?: Worker<PayoutsReconcileJobData>;
  private connection?: Redis;
  private workerConnection?: Redis;

  constructor(
    runtime: PayoutsRuntime,
    private readonly logger: PinoLogger,
    @Inject(PLATFORM_EVENT_DISPATCHER) dispatcher: PlatformEventDispatcher,
  ) {
    const processor = new PlatformEventProcessor(runtime, logger, dispatcher);
    this.reconciler = new PayoutsReconcilerService({
      db: runtime.db,
      stripe: runtime.stripe,
      settlement: runtime.settlement,
      replayEvent: (event) =>
        processor.process(event, { ip: null, userAgent: 'payouts-reconcile' }),
      logger: {
        warn: (obj, msg) => logger.warn(obj, msg),
        log: (obj, msg) => logger.log(obj, msg),
        error: (obj, msg) => logger.error(obj, msg),
      },
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.warn(
        'REDIS_URL no seteada — el conciliador de cobros no se programa; queda el disparo manual',
      );
      return;
    }
    if (process.env['NODE_ENV'] === 'test') return;

    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
    this.workerConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    const conn: ConnectionOptions = this.connection;
    this.queue = new Queue<PayoutsReconcileJobData>(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 7 * 24 * 3600, count: 50 },
        removeOnFail: { age: 30 * 24 * 3600, count: 50 },
      },
    });
    this.worker = new Worker<PayoutsReconcileJobData>(
      QUEUE_NAME,
      async (job) => {
        await this.run({ deep: job.data.deep === true });
      },
      { connection: this.workerConnection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'payouts reconcile job falló');
    });
    await this.queue.add(
      'hourly',
      { deep: false },
      { repeat: { pattern: HOURLY_PATTERN, tz: 'UTC' }, jobId: 'payouts-reconcile-hourly' },
    );
    await this.queue.add(
      'deep',
      { deep: true },
      { repeat: { pattern: DEEP_PATTERN, tz: 'UTC' }, jobId: 'payouts-reconcile-deep' },
    );
    this.logger.log(
      `conciliador de cobros activo (horario '${HOURLY_PATTERN}', profundo '${DEEP_PATTERN}' UTC)`,
    );
  }

  /** Una pasada. Público para el disparo manual y los tests. */
  run(options: { deep: boolean; windowHours?: number }): Promise<ReconcileReport> {
    return this.reconciler.run(options);
  }

  async onModuleDestroy(): Promise<void> {
    for (const close of [
      () => this.worker?.close(),
      () => this.queue?.close(),
      () => this.connection?.quit(),
      () => this.workerConnection?.quit(),
    ]) {
      try {
        await close();
      } catch {
        /* noop */
      }
    }
  }
}
