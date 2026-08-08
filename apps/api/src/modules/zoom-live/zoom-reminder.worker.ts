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
import { calendarVariables } from './class-links';

const QUEUE_NAME = 'didacta.zoom-live.reminder';
/**
 * Cada 5 min. Con 2h de antelación, el peor caso es un aviso 5 minutos
 * "temprano" — irrelevante — y a cambio una clase creada con menos de 2h de
 * margen recibe su recordatorio casi al instante.
 */
const REPEAT_PATTERN = process.env['ZOOM_REMINDER_CRON'] ?? '*/5 * * * *';

/** Horas de antelación del aviso (default 2). */
function reminderHoursBefore(): number {
  const raw = Number(process.env['ZOOM_REMINDER_HOURS_BEFORE'] ?? '2');
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
}

/**
 * Hora de inicio en la zona del formador. Es la referencia que el alumno ya
 * ve en el email de confirmación; cambiar de criterio ahora sería contarle
 * dos horas distintas para la misma clase.
 */
function formatStartsAt(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('es-ES', {
      timeZone: timezone || 'UTC',
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * Worker BullMQ del recordatorio "tu clase empieza en 2 horas"
 * (mod.zoom-live). Cada 5 min busca clases SCHEDULED/STARTED que arrancan
 * dentro de la ventana y todavía no tienen `reminder_sent_at`, reclama cada
 * una atómicamente y avisa a sus inscritos (in-app + email, plantilla
 * `zoom.class.reminder`, categoría LEARNING — respeta las preferencias del
 * usuario).
 *
 * Un aviso por clase como máximo: el claim (`updateMany` condicionado a
 * `reminderSentAt: null`) impide que dos instancias de la API avisen dos
 * veces. Si la clase se reprograma, `update()` devuelve el campo a NULL y el
 * recordatorio se vuelve a armar para la hora nueva.
 *
 * Mismo patrón que `ZoomAttendanceSyncWorker` y `SurveysReminderWorker`: sin
 * `REDIS_URL` no arranca (warn), en `NODE_ENV=test` tampoco, y `runSweep()`
 * queda expuesto para dispararlo a mano en QA.
 */
@Injectable()
export class ZoomReminderWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue;
  private worker?: Worker;
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
      this.logger.warn('REDIS_URL no seteada — zoom reminder scheduler no arranca');
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
        backoff: { type: 'exponential', delay: 30_000 },
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
      this.logger.error({ jobId: job?.id, err: err.message }, 'zoom reminder job falló');
    });

    // Repeatable idempotente (jobId estable): rebootear no duplica.
    await this.queue.add(
      'sweep',
      {},
      { repeat: { pattern: REPEAT_PATTERN, tz: 'UTC' }, jobId: 'zoom-reminder-sweep' },
    );

    this.logger.log(
      `zoom reminder scheduler activo (cron='${REPEAT_PATTERN}' UTC, ${reminderHoursBefore()}h antes)`,
    );
  }

  /**
   * Barrido de recordatorios. Público: lo usa también el endpoint
   * `POST /modules/zoom-live/admin/reminders/run` (QA / disparo manual), que
   * pasa `tenantId` para no avisar en nombre de otros tenants.
   */
  async runSweep(
    now = new Date(),
    tenantId?: string,
  ): Promise<{ sessions: number; reminders: number }> {
    const service = this.registry.getZoomLiveService();
    const hoursBefore = reminderHoursBefore();
    // Barrido cross-tenant de clases pendientes (inventario RLS F3).
    const due = await runSanctionedGlobalAccess(() =>
      service.listSessionsPendingReminder(now, hoursBefore, 100, tenantId),
    );
    let reminders = 0;
    let sessions = 0;

    for (const pending of due) {
      // Todo el procesado de la sesión corre bajo su tenant (scope RLS).
      const sent = await runAsTenant(pending.tenantId, async () => {
        // Reclama ANTES de enviar: con dos instancias barriendo a la vez, solo
        // una gana el updateMany condicionado y avisa.
        const claimed = await service.claimReminder(pending.tenantId, pending.id, now);
        if (!claimed) return null;

        const info = await service.getCalendarInfo(pending.id);
        if (!info) return 0;

        const userIds = await service.listRegisteredUserIds(pending.tenantId, pending.id);
        const variables = {
          topic: info.topic,
          startsAt: formatStartsAt(info.startTime, info.timezone),
          hoursBefore,
          ...calendarVariables(pending.id),
        };

        // Secuencial a propósito: el hub hace SMTP por destinatario y no
        // queremos ráfagas paralelas contra el servidor de correo.
        for (const userId of userIds) {
          await this.notify(pending.tenantId, userId, variables);
        }

        this.logger.log(
          { tenantId: pending.tenantId, sessionId: pending.id, registered: userIds.length },
          'mod.zoom-live: recordatorio de clase enviado',
        );
        return userIds.length;
      });
      if (sent === null) continue;
      sessions += 1;
      reminders += sent;
    }

    return { sessions, reminders };
  }

  private async processJob(): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await this.runSweep();
      if (result.sessions > 0) {
        this.logger.log(
          { ...result, elapsedMs: Date.now() - startedAt },
          'zoom reminder sweep completado',
        );
      }
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'zoom reminder: runSweep() lanzó error',
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
          templateKey: 'zoom.class.reminder',
          to: userId,
          variables,
          category: 'LEARNING',
        });
      } catch (err) {
        this.logger.warn(
          { tenantId, userId, channel, err: err instanceof Error ? err.message : String(err) },
          'mod.zoom-live: fallo al enviar recordatorio (best-effort)',
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
