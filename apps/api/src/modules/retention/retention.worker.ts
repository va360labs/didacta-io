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
import { RETENTION_MODULE } from '@didacta/mod-retention';
import { runAsTenant, runSanctionedGlobalAccess } from '../../tenancy/tenant-context.storage';
import { ModuleRegistryService } from '../module-registry.service';

const QUEUE_NAME = 'didacta.retention.sweep';
/** Cada 5 minutos: lo bastante a menudo para que la bienvenida llegue «al entrar». */
const REPEAT_PATTERN = process.env['RETENTION_CRON'] ?? '*/5 * * * *';

/**
 * Barrido de mod.retention (BullMQ, como el resto de trabajos programados).
 *
 * En cada pasada:
 *  1. Lista las aulas con algún mensaje automático encendido (lectura de todas
 *     las aulas: acceso global SANCIONADO). Un aula sin mensajes no se toca.
 *  2. Para cada una, bajo SU contexto de aula (RLS), llama a
 *     `RetentionService.runTenant`: ocurrencias nuevas, envíos con las reglas
 *     anti-spam y lecturas/respuestas al día.
 *
 * Un aula que falla no para a las demás. Sin REDIS_URL o con NODE_ENV=test no
 * arranca (igual que el resto de workers); `POST /modules/retention/admin/run`
 * pasa el barrido de un aula a mano.
 */
@Injectable()
export class RetentionWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue;
  private worker?: Worker;
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
      this.logger.warn('REDIS_URL no seteada — el barrido de mensajes automáticos no arranca');
      return;
    }
    if (process.env['NODE_ENV'] === 'test') return;

    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
    this.workerConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    const conn: ConnectionOptions = this.connection;
    this.queue = new Queue(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 24 * 3600, count: 50 },
        removeOnFail: { age: 7 * 24 * 3600, count: 50 },
      },
    });
    this.worker = new Worker(QUEUE_NAME, async () => this.sweep(), {
      connection: this.workerConnection,
      concurrency: 1,
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'barrido de retención falló');
    });
    await this.queue.add(
      'sweep',
      {},
      { repeat: { pattern: REPEAT_PATTERN, tz: 'UTC' }, jobId: 'retention-sweep' },
    );
    this.logger.log(`barrido de mensajes automáticos activo (cron='${REPEAT_PATTERN}' UTC)`);
  }

  /** Una pasada por todas las aulas con mensajes encendidos. */
  async sweep(now = new Date()): Promise<{ tenants: number; sent: number; failed: number }> {
    const service = this.registry.getRetentionService();
    const tenantIds = await runSanctionedGlobalAccess(() => service.listActiveTenantIds());
    let sent = 0;
    let failed = 0;
    for (const tenantId of tenantIds) {
      try {
        const stats = await runAsTenant(
          tenantId,
          async () => {
            if (!(await this.registry.isModuleEnabledForTenant(tenantId, RETENTION_MODULE))) {
              return null;
            }
            return service.runTenant(tenantId, now);
          },
          { traceLabel: 'retention-sweep' },
        );
        if (stats) {
          sent += stats.sent;
          failed += stats.failed;
        }
      } catch (err) {
        failed++;
        this.logger.warn(
          { tenantId, err: err instanceof Error ? err.message : String(err) },
          'barrido de retención: el aula falló, se sigue con las demás',
        );
      }
    }
    if (tenantIds.length > 0) {
      this.logger.log({ tenants: tenantIds.length, sent, failed }, 'barrido de retención hecho');
    }
    return { tenants: tenantIds.length, sent, failed };
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
