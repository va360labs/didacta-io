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

const QUEUE_NAME = 'didacta.zoom-live.attendance-sync';
// Cada 10 min por defecto. Configurable vía env.
const REPEAT_PATTERN = process.env['ZOOM_ATTENDANCE_SYNC_CRON'] ?? '*/10 * * * *';

/**
 * Worker BullMQ que reconcilia la asistencia de las clases ya terminadas
 * contra la API de Zoom (ADR-018).
 *
 * Por qué una cron y no un pull dentro del webhook `meeting.ended`: Zoom
 * espera un 2xx en menos de 3s y el informe de participantes no está listo
 * en el instante en que acaba la reunión. Una cron además sobrevive a
 * reinicios y reintenta sola si la primera lectura llega demasiado pronto.
 *
 * `listSessionsPendingAttendanceSync` acota la ventana a 48h para no
 * machacar la API de Zoom indefinidamente cuando a la cuenta le falta el
 * scope `report:read:admin`; pasado ese plazo queda el botón manual del
 * formador. El motivo del último fallo se persiste en la sesión, así que el
 * error es visible en la UI en vez de morir en los logs.
 *
 * Sin `REDIS_URL` (o en tests) el worker no arranca.
 */
@Injectable()
export class ZoomAttendanceSyncWorker implements OnApplicationBootstrap, OnModuleDestroy {
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
      this.logger.warn('REDIS_URL no seteada — zoom attendance sync no arranca');
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
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { age: 7 * 24 * 3600, count: 50 },
        removeOnFail: { age: 7 * 24 * 3600, count: 50 },
      },
    });

    this.worker = new Worker(
      QUEUE_NAME,
      async () => {
        await this.syncDueSessions();
      },
      { connection: this.workerConnection, concurrency: 1 },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'zoom attendance sync job falló');
    });

    // Repeatable idempotente (jobId estable): rebootear no duplica.
    await this.queue.add(
      'tick',
      {},
      { repeat: { pattern: REPEAT_PATTERN }, jobId: 'zoom-attendance-sync' },
    );
    this.logger.log(`zoom attendance sync activo (cron='${REPEAT_PATTERN}')`);
  }

  /** Fuerza un ciclo de reconciliación (útil en QA). */
  async runNow(): Promise<{ synced: number; failed: number }> {
    return this.syncDueSessions();
  }

  private async syncDueSessions(): Promise<{ synced: number; failed: number }> {
    const service = this.registry.getZoomLiveService();
    const pending = await service.listSessionsPendingAttendanceSync(new Date());
    if (pending.length === 0) return { synced: 0, failed: 0 };

    let synced = 0;
    let failed = 0;
    for (const session of pending) {
      try {
        const report = await service.syncAttendance(session.tenantId, session.id);
        // `syncAttendance` no lanza cuando Zoom falla: deja el motivo en
        // `syncError` y no marca `syncedAt`. Distinguimos por ahí.
        if (report.syncedAt) synced++;
        else failed++;
      } catch (err) {
        failed++;
        this.logger.warn(
          { sessionId: session.id, err: err instanceof Error ? err.message : String(err) },
          'zoom attendance sync: sesión falló',
        );
      }
    }

    this.logger.log({ synced, failed }, 'zoom attendance sync: sesiones procesadas');
    return { synced, failed };
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
