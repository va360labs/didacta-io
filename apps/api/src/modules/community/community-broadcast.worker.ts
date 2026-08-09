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
import { runAsTenant, runSanctionedGlobalAccess } from '../../tenancy/tenant-context.storage';
import { ModuleContextFactory } from '../module-context.factory';
import { ModuleRegistryService } from '../module-registry.service';
import { signUnsubscribeToken } from './broadcast-unsubscribe';

const QUEUE_NAME = 'didacta.community.broadcast';
// Ritmo conservador por defecto: BATCH_SIZE emails y luego pausa BATCH_INTERVAL_MS.
// 5 cada 10s ≈ 30/min. Configurable por env según el proveedor SMTP del tenant.
const BATCH_SIZE = Math.max(1, Number(process.env['COMMUNITY_BROADCAST_BATCH_SIZE'] ?? 5));
const BATCH_INTERVAL_MS = Math.max(
  1000,
  Number(process.env['COMMUNITY_BROADCAST_INTERVAL_MS'] ?? 10_000),
);

interface BroadcastJobData {
  broadcastId: string;
}

/**
 * Worker BullMQ del envío MASIVO de avisos a la comunidad. Procesa cada aviso
 * por **lotes con auto-continuación**: manda un lote (BATCH_SIZE) y re-encola el
 * siguiente con `delay` (BATCH_INTERVAL_MS) para no reventar el rate-limit del
 * SMTP. El avance es resumible (cursor por userId en la tabla) e idempotente ante
 * reinicios. Respeta la baja (`broadcastOptOut`) salvo avisos `important`.
 *
 * Sin `REDIS_URL` (dev/test) cae a modo in-process: procesa los lotes en el propio
 * proceso con la misma pausa entre lotes (sin durabilidad).
 */
@Injectable()
export class CommunityBroadcastWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue<BroadcastJobData>;
  private worker?: Worker<BroadcastJobData>;
  private connection?: Redis;
  private workerConnection?: Redis;

  constructor(
    @Inject(forwardRef(() => ModuleContextFactory))
    private readonly factory: ModuleContextFactory,
    @Inject(forwardRef(() => ModuleRegistryService))
    private readonly registry: ModuleRegistryService,
    private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.warn('REDIS_URL no seteada — community broadcast usa modo in-process (sin cola)');
      return;
    }
    if (process.env['NODE_ENV'] === 'test') return;

    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
    this.workerConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    const conn: ConnectionOptions = this.connection;

    this.queue = new Queue<BroadcastJobData>(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { age: 7 * 24 * 3600, count: 100 },
        removeOnFail: { age: 30 * 24 * 3600, count: 100 },
      },
    });

    this.worker = new Worker<BroadcastJobData>(
      QUEUE_NAME,
      async (job) => {
        await this.processBatch(job.data.broadcastId);
      },
      { connection: this.workerConnection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'community broadcast job falló');
    });

    this.logger.log(
      `community broadcast worker activo (lote=${BATCH_SIZE}, intervalo=${BATCH_INTERVAL_MS}ms)`,
    );
  }

  /** Arranca el envío de un aviso: encola el primer lote (o lo corre in-process). */
  async enqueue(broadcastId: string): Promise<void> {
    if (!this.queue) {
      // Sin Redis: fire-and-forget en proceso (dev/test). No bloquea la request.
      void this.runInProcess(broadcastId).catch((err) => {
        this.logger.error({ broadcastId, err: String(err) }, 'broadcast in-process falló');
      });
      return;
    }
    await this.queue.add('batch', { broadcastId }, { jobId: `bcast-${broadcastId}-start` });
  }

  private async runInProcess(broadcastId: string): Promise<void> {
    for (;;) {
      const done = await this.processBatch(broadcastId);
      if (done) break;
      await new Promise((r) => setTimeout(r, BATCH_INTERVAL_MS));
    }
  }

  /** Procesa un lote del aviso. Devuelve true si el aviso ya terminó. */
  private async processBatch(broadcastId: string): Promise<boolean> {
    const community = this.registry.getCommunityService();
    const ctx = this.factory.build();
    // Lookup por broadcastId sin tenant aún: acceso global sancionado (RLS F3).
    const { broadcast, recipients, done } = await runSanctionedGlobalAccess(() =>
      community.claimBroadcastBatch(broadcastId, BATCH_SIZE),
    );
    if (done || !broadcast) return true;

    const webBase = (process.env['WEB_PUBLIC_URL'] ?? '').replace(/\/$/, '');
    // El enlace viaja SOLO (sin su frase): «Ver la publicación:» y la nota de
    // baja son copy del producto y viven en la plantilla `community.broadcast`,
    // que tiene gemela inglesa. Aquí estaban concatenados al cuerpo, así que
    // llegaban al hub dentro de `variables` y ninguna traducción los alcanzaba:
    // un miembro con `locale = en-US` recibía el aviso de su admin con el pie
    // de baja en español.
    const postUrl = broadcast.postId ? `${webBase}/comunidad` : '';
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let lastUserId = broadcast.cursorUserId ?? '';

    // Envíos y commit del cursor bajo el tenant del aviso (scope RLS).
    await runAsTenant(broadcast.tenantId, async () => {
      for (const r of recipients) {
        lastUserId = r.userId;
        if (r.optedOut && !broadcast.important) {
          skipped++;
          continue;
        }
        const unsubUrl = `${webBase}/api/v1/modules/community/unsubscribe?token=${signUnsubscribeToken(
          broadcast.tenantId,
          r.userId,
        )}`;
        try {
          // La baja SOLO va por email (in-app no se «recibe» en la bandeja):
          // la plantilla envuelve su bloque en `{{#unsubUrl}}`, así que omitir
          // la variable hace desaparecer el pie, igual que antes.
          await ctx.notificationHub.send({
            tenantId: broadcast.tenantId,
            channel: 'email',
            templateKey: 'community.broadcast',
            to: r.userId,
            variables: { subject: broadcast.subject, body: broadcast.bodyText, postUrl, unsubUrl },
          });
          await ctx.notificationHub.send({
            tenantId: broadcast.tenantId,
            channel: 'in-app',
            templateKey: 'community.broadcast',
            to: r.userId,
            variables: { subject: broadcast.subject, body: broadcast.bodyText, postUrl },
          });
          sent++;
        } catch (err) {
          failed++;
          this.logger.warn(
            {
              broadcastId,
              userId: r.userId,
              err: err instanceof Error ? err.message : String(err),
            },
            'broadcast: envío falló',
          );
        }
      }

      await community.commitBroadcastBatch(broadcastId, { sent, failed, skipped, lastUserId });
    });

    if (this.queue) {
      // Siguiente lote con delay = rate-limit.
      await this.queue.add(
        'batch',
        { broadcastId },
        { delay: BATCH_INTERVAL_MS, jobId: `bcast-${broadcastId}-${lastUserId}` },
      );
    }
    return false;
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
