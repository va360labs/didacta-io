/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { VIDEO_CLOUD_SERVICE, VIDEO_INACTIVITY_SERVICE } from './video-cloud.di';
import type { VideoCloudService } from './video-cloud.service';
import type { DailyResult, VideoInactivityService } from './video-inactivity.service';

const QUEUE_NAME = 'didacta.video.cloud';
/** Cada hora, a y 17: estado, horas vistas y limpieza de lo que nadie usa. */
const HOURLY = process.env['VIDEO_CLOUD_SYNC_CRON'] ?? '17 * * * *';
/** Cada día a las 03:40 UTC: inactividad, copias caducadas y coste. */
const DAILY = process.env['VIDEO_CLOUD_DAILY_CRON'] ?? '40 3 * * *';

/**
 * Barridos del vídeo de Didacta Cloud (BullMQ, mismo patrón que
 * `PayoutsSettleWorker`). Sin `REDIS_URL`, o en test, no se programan: el
 * estado lo trae el webhook y lo refresca el editor al consultar.
 */
@Injectable()
export class VideoCloudWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(VideoCloudWorker.name);
  private queue?: Queue;
  private worker?: Worker;
  private connection?: Redis;
  private workerConnection?: Redis;

  constructor(
    @Inject(VIDEO_CLOUD_SERVICE) private readonly cloud: VideoCloudService,
    @Inject(VIDEO_INACTIVITY_SERVICE) private readonly inactivity: VideoInactivityService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.warn('REDIS_URL no seteada — sin barridos de vídeo (ni inactividad)');
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
        removeOnComplete: { age: 7 * 24 * 3600, count: 200 },
        removeOnFail: { age: 30 * 24 * 3600, count: 200 },
      },
    });
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        if (job.name === 'hourly') return this.hourly();
        if (job.name === 'daily') return this.daily();
        return undefined;
      },
      { connection: this.workerConnection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`barrido de vídeo ${job?.name ?? '?'} falló: ${err.message}`);
    });
    await this.queue.add(
      'hourly',
      {},
      { repeat: { pattern: HOURLY, tz: 'UTC' }, jobId: 'video-hourly' },
    );
    await this.queue.add(
      'daily',
      {},
      { repeat: { pattern: DAILY, tz: 'UTC' }, jobId: 'video-daily' },
    );
    this.logger.log(`barridos de vídeo activos (hora '${HOURLY}', día '${DAILY}' UTC)`);
  }

  /** Público para el disparo manual y los tests. */
  async hourly(): Promise<{ tenants: number; deleted: number; watchedAddedSeconds: number }> {
    let deleted = 0;
    let watchedAddedSeconds = 0;
    const tenants = await this.cloud.tenantsWithVideo();
    for (const tenantId of tenants) {
      try {
        const r = await this.cloud.reconcileTenant(tenantId);
        deleted += r.deleted;
        watchedAddedSeconds += r.watchedAddedSeconds;
      } catch (err) {
        this.logger.error(`barrido de vídeo del aula ${tenantId}: ${(err as Error).message}`);
      }
    }
    return { tenants: tenants.length, deleted, watchedAddedSeconds };
  }

  async daily(): Promise<DailyResult> {
    const result = await this.inactivity.runDaily();
    this.logger.log(`inactividad de vídeo: ${JSON.stringify(result)}`);
    return result;
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
