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
import { ModuleContextFactory } from '../module-context.factory';
import { ModuleRegistryService } from '../module-registry.service';

const QUEUE_NAME = 'didacta.surveys.reminder';
const REPEAT_PATTERN = process.env['SURVEYS_REMINDER_CRON'] ?? '*/15 * * * *';

/** Horas sin responder tras las que se envía el recordatorio (default 24). */
function reminderDelayHours(): number {
  const raw = Number(process.env['SURVEYS_REMINDER_DELAY_HOURS'] ?? '24');
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
}

/** Enlace absoluto a la clase, o '' si WEB_PUBLIC_URL no está configurada. */
function classUrl(sessionId: string): string {
  const base = (process.env['WEB_PUBLIC_URL'] ?? '').trim().replace(/\/+$/, '');
  return base ? `${base}/clase/${sessionId}` : '';
}

/**
 * Worker BullMQ de recordatorios de encuesta (mod.surveys): cada 15 min barre
 * las encuestas post-clase abiertas creadas hace ≥24h sin recordatorio enviado
 * y avisa SOLO a los inscritos que aún no respondieron (vía hash anónimo: se
 * sabe quién no respondió sin poder ver qué respondió nadie). Un recordatorio
 * por encuesta como máximo (`reminder_sent_at` + claim atómico anti-carrera).
 *
 * Patrón idéntico a ReferralsApprovalWorker: sin Redis no arranca (warn), en
 * NODE_ENV=test tampoco, y `runSweep()` queda expuesto para el disparo manual
 * del endpoint admin (QA / clases pasadas).
 */
@Injectable()
export class SurveysReminderWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue<Record<string, never>>;
  private worker?: Worker<Record<string, never>>;
  private connection?: Redis;
  private workerConnection?: Redis;

  constructor(
    @Inject(forwardRef(() => ModuleRegistryService))
    private readonly registry: ModuleRegistryService,
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.warn('REDIS_URL no seteada — surveys reminder scheduler no arranca');
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
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 7 * 24 * 3600, count: 50 },
        removeOnFail: { age: 7 * 24 * 3600, count: 50 },
      },
    });

    this.worker = new Worker(
      QUEUE_NAME,
      async () => {
        await this.processJob();
      },
      { connection: this.workerConnection, concurrency: 1 },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'surveys reminder job falló');
    });

    await this.queue.add(
      'sweep',
      {},
      { repeat: { pattern: REPEAT_PATTERN, tz: 'UTC' }, jobId: 'surveys-reminder-sweep' },
    );

    this.logger.log(
      `surveys reminder scheduler activo (cron='${REPEAT_PATTERN}' UTC, delay=${reminderDelayHours()}h)`,
    );
  }

  /**
   * Barrido de recordatorios. Público: lo usa también el endpoint admin
   * `POST /modules/surveys/admin/reminders/run` (QA / disparo manual).
   */
  async runSweep(): Promise<{ surveys: number; reminders: number }> {
    const service = this.registry.getSurveysService();
    const prisma = this.factory.getPrisma();
    const due = await service.findDueReminders(new Date(), reminderDelayHours());
    let reminders = 0;

    for (const survey of due) {
      // Reclama ANTES de enviar: con dos instancias barriendo a la vez, solo
      // una gana el updateMany condicionado y envía.
      const claimed = await service.claimReminder(survey.tenantId, survey.id);
      if (!claimed) continue;

      // Lectura acotada de mod_zoom_session_registration (ADR-016, manifest).
      const registrations = await prisma.modZoomSessionRegistration.findMany({
        where: { tenantId: survey.tenantId, sessionId: survey.zoomSessionId },
        select: { userId: true },
      });
      const pending = await service.filterPendingRespondents(
        survey.tenantId,
        survey.id,
        registrations.map((r) => r.userId),
      );

      const variables = { topic: survey.title, surveyUrl: classUrl(survey.zoomSessionId) };
      // Secuencial a propósito: nada de ráfagas SMTP paralelas.
      for (const userId of pending) {
        await this.notify(survey.tenantId, userId, variables);
        reminders += 1;
      }

      this.logger.log(
        {
          tenantId: survey.tenantId,
          surveyId: survey.id,
          registered: registrations.length,
          pending: pending.length,
        },
        'mod.surveys: recordatorio de encuesta enviado',
      );
    }

    return { surveys: due.length, reminders };
  }

  private async processJob(): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await this.runSweep();
      if (result.surveys > 0) {
        this.logger.log(
          { ...result, elapsedMs: Date.now() - startedAt },
          'surveys reminder sweep completado',
        );
      }
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'surveys reminder: runSweep() lanzó error',
      );
      throw err; // BullMQ aplica retry exponencial
    }
  }

  private async notify(
    tenantId: string,
    userId: string,
    variables: Record<string, unknown>,
  ): Promise<void> {
    const hub = this.factory.getNotificationHub();
    for (const channel of ['in-app', 'email'] as const) {
      try {
        await hub.send({
          tenantId,
          channel,
          templateKey: 'surveys.post_class.reminder',
          locale: 'es-ES',
          to: userId,
          variables,
          category: 'LEARNING',
        });
      } catch (err) {
        this.logger.warn(
          { tenantId, userId, channel, err: err instanceof Error ? err.message : String(err) },
          'mod.surveys: fallo al enviar recordatorio (best-effort)',
        );
      }
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
