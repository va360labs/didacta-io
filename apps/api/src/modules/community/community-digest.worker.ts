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
import { CommunityDigestMetrics } from './community-digest.metrics';
import { ModuleContextFactory } from '../module-context.factory';
import { ModuleRegistryService } from '../module-registry.service';

const QUEUE_NAME = 'didacta.community.digest';
const REPEAT_PATTERN = process.env['COMMUNITY_DIGEST_CRON'] ?? '0 9 * * 1'; // Lun 09:00 UTC

interface DigestJobData {
  /** ISO 8601 del corte: el digest cubre desde `since` hasta now. */
  since: string;
}

/**
 * Worker BullMQ que dispara el digest semanal de comunidad. Cada lunes 09:00
 * UTC (configurable vía `COMMUNITY_DIGEST_CRON`):
 *
 *  1. Lista todos los usuarios ACTIVE.
 *  2. Para cada uno, llama `CommunityService.buildDigest(since=now-7d)`.
 *  3. Si hay menciones o respuestas, envía un email vía NotificationHub
 *     con templateKey `community.digest.weekly`.
 *
 * Si REDIS_URL no está set, el worker no arranca (igual que outbox queue).
 * En tests (NODE_ENV=test) tampoco, para no romper bootstraps de Nest sin
 * Redis.
 *
 * Endpoint manual `POST /modules/community/digest/run-now` (super_admin)
 * permite disparar el job sin esperar a la cron — útil para QA y pruebas.
 */
@Injectable()
export class CommunityDigestWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue<DigestJobData>;
  private worker?: Worker<DigestJobData>;
  private connection?: Redis;
  private workerConnection?: Redis;

  constructor(
    @Inject(forwardRef(() => ModuleContextFactory))
    private readonly factory: ModuleContextFactory,
    @Inject(forwardRef(() => ModuleRegistryService))
    private readonly registry: ModuleRegistryService,
    private readonly logger: PinoLogger,
    private readonly metrics: CommunityDigestMetrics,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.warn('REDIS_URL no seteada — community digest scheduler no arranca');
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

    this.queue = new Queue<DigestJobData>(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 30 * 24 * 3600, count: 50 },
        removeOnFail: { age: 30 * 24 * 3600, count: 50 },
      },
    });

    this.worker = new Worker<DigestJobData>(
      QUEUE_NAME,
      async (job) => {
        await this.processDigestJob(job.data);
      },
      { connection: this.workerConnection, concurrency: 1 },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'community digest job falló');
    });

    // Repeatable: lunes 09:00 UTC. BullMQ registra el repeat key idempotente
    // con la combinación (jobId base + pattern), así que rebootear no duplica.
    await this.queue.add(
      'weekly',
      { since: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString() },
      {
        repeat: { pattern: REPEAT_PATTERN, tz: 'UTC' },
        jobId: 'weekly-digest', // estable
      },
    );

    this.logger.log(`community digest scheduler activo (cron='${REPEAT_PATTERN}' UTC)`);
  }

  /**
   * Punto de entrada manual para el endpoint super_admin: encola un job
   * inmediato con `since = now - 7 días`.
   */
  async triggerNow(sinceOverride?: Date): Promise<void> {
    if (!this.queue) {
      // Si no hay Redis, lo ejecutamos in-process (degraded mode).
      await this.processDigestJob({
        since: (sinceOverride ?? new Date(Date.now() - 7 * 24 * 3600 * 1000)).toISOString(),
      });
      return;
    }
    await this.queue.add(
      'weekly-manual',
      {
        since: (sinceOverride ?? new Date(Date.now() - 7 * 24 * 3600 * 1000)).toISOString(),
      },
      { jobId: `manual-${Date.now()}` },
    );
  }

  private async processDigestJob(data: DigestJobData): Promise<void> {
    const since = new Date(data.since);
    const community = this.registry.getCommunityService();
    const ctx = this.factory.build();

    const stopTimer = this.metrics.startRunTimer();
    const users = await community.listActiveUsersForDigest();
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const u of users) {
      this.metrics.recordUserProcessed();
      const digest = await community.buildDigest(u.tenantId, u.userId, since);
      if (digest.mentions.length === 0 && digest.replies.length === 0) {
        skipped++;
        this.metrics.recordSkipped();
        continue;
      }
      try {
        await ctx.notificationHub.send({
          tenantId: u.tenantId,
          channel: 'email',
          templateKey: 'community.digest.weekly',
          locale: 'es-ES',
          to: u.userId,
          variables: {
            mentionsCount: digest.mentions.length,
            repliesCount: digest.replies.length,
            mentions: digest.mentions,
            replies: digest.replies,
            sinceIso: since.toISOString(),
          },
        });
        sent++;
        this.metrics.recordSent();
      } catch (err) {
        failed++;
        this.metrics.recordFailed();
        this.logger.warn(
          {
            tenantId: u.tenantId,
            userId: u.userId,
            err: err instanceof Error ? err.message : String(err),
          },
          'community digest: notify failed',
        );
      }
    }

    const elapsedSec = stopTimer();
    this.logger.log(
      { sent, skipped, failed, total: users.length, since: data.since, elapsedSec },
      'community digest job completado',
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
