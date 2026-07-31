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

const QUEUE_NAME = 'didacta.payment-connections.subscribers-sync';
/** Cada 15 min por defecto (configurable). El dashboard también permite sync on-demand. */
const REPEAT_PATTERN = process.env['PAYMENT_SUBSCRIBERS_SYNC_CRON'] ?? '*/15 * * * *';

type JobData = Record<string, never>;

/**
 * Worker BullMQ que materializa periódicamente los suscriptores de TODAS las
 * cuentas conectadas en `mod_payment_connections_subscriber` (la fuente del
 * dashboard de control de suscripciones). Cada 15 min (configurable vía
 * `PAYMENT_SUBSCRIBERS_SYNC_CRON`):
 *
 *  1. Enumera los tenants con ≥1 conexión VERIFIED.
 *  2. Por tenant: `PaymentConnectionsService.syncSubscribers(tenantId)` (reconcile
 *     en vivo de cada cuenta → upsert + churn + SyncHistory).
 *
 * Cross-tenant sin contexto de request: depende de que el rol de la app bypase
 * RLS (mismo modelo que el resto de workers del host, p.ej. grace-expiration).
 *
 * Si REDIS_URL no está set, el worker no arranca (warn). En tests (NODE_ENV=test)
 * tampoco. Best-effort por tenant: un fallo no tumba el barrido del resto.
 */
@Injectable()
export class SubscribersSyncWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue<JobData>;
  private worker?: Worker<JobData>;
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
      this.logger.warn('REDIS_URL no seteada — payment-connections subscribers-sync no arranca');
      return;
    }
    if (process.env['NODE_ENV'] === 'test') return;

    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
    this.workerConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    const conn: ConnectionOptions = this.connection;

    this.queue = new Queue<JobData>(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 7 * 24 * 3600, count: 50 },
        removeOnFail: { age: 7 * 24 * 3600, count: 50 },
      },
    });

    this.worker = new Worker<JobData>(QUEUE_NAME, async () => this.processJob(), {
      connection: this.workerConnection,
      concurrency: 1,
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'payment subscribers-sync job falló');
    });

    await this.queue.add('periodic', {} as JobData, {
      repeat: { pattern: REPEAT_PATTERN, tz: 'UTC' },
      jobId: 'periodic-subscribers-sync',
    });
    this.logger.log(`payment-connections subscribers-sync activo (cron='${REPEAT_PATTERN}' UTC)`);
  }

  /** Encola un barrido inmediato (para QA / endpoint manual). In-process si no hay Redis. */
  async triggerNow(): Promise<void> {
    if (!this.queue) {
      await this.processJob();
      return;
    }
    await this.queue.add('manual', {} as JobData, { jobId: `manual-${Date.now()}` });
  }

  private async processJob(): Promise<void> {
    const service = this.registry.getPaymentConnectionsService();
    const tenants = await service.listTenantsWithVerifiedConnections();
    let ok = 0;
    let failed = 0;
    for (const tenantId of tenants) {
      try {
        const r = await service.syncSubscribers(tenantId);
        ok += 1;
        this.logger.log(
          { tenantId, connections: r.connections, upserted: r.upserted, markedGone: r.markedGone },
          'payment subscribers-sync: tenant sincronizado',
        );
      } catch (err) {
        failed += 1;
        this.logger.error(
          { tenantId, err: err instanceof Error ? err.message : String(err) },
          'payment subscribers-sync: fallo al sincronizar tenant',
        );
      }
    }
    this.logger.log(
      { tenants: tenants.length, ok, failed },
      'payment subscribers-sync: barrido completo',
    );
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
