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
import type { SubscriberToWarn, UpcomingRenewal } from '@didacta/mod-payment-connections';
import { ModuleRegistryService } from '../module-registry.service';
import { SmtpAdapterService, type SmtpConfig } from '../smtp-adapter.service';
import { TenantSmtpResolverService } from '../tenant-smtp-resolver.service';
import { renewalEmailHtml } from '../../common/renewal-email-html';

const QUEUE_NAME = 'didacta.payment-connections.daily';
// 9:00 hora de España por defecto. Configurable por env.
const REPEAT_PATTERN = process.env['SUBSCRIPTIONS_DAILY_CRON'] ?? '0 9 * * *';
const REPEAT_TZ = process.env['SUBSCRIPTIONS_DAILY_TZ'] ?? 'Europe/Madrid';
/** Ventana del resumen + del aviso previo (días antes de la renovación/caducidad). */
const WINDOW_DAYS = Math.max(1, Number(process.env['SUBSCRIPTIONS_RENEWAL_WINDOW_DAYS'] ?? 7));

type JobData = Record<string, never>;

/**
 * Worker BullMQ diario (9:00 Europe/Madrid por defecto). Por cada tenant con
 * conexiones VERIFIED:
 *   1. **Resumen para el admin**: email a los super_admin/tenant_admin con el nº de
 *      suscripciones activas y las que se renuevan/caducan en los próximos N días.
 *   2. **Aviso al miembro (N días antes)**: a cada suscriptor que se renueva en ≤N
 *      días y no se avisó aún para ese periodo, email de "se te cobrará el {fecha}"
 *      con el enlace del Customer Portal de Stripe para cancelar. Idempotente.
 *
 * Envía por el SMTP del tenant directamente (destinatarios arbitrarios: emails de
 * admins y de suscriptores que pueden no ser usuarios de Didacta). Best-effort por
 * tenant y por email. Sin Redis (dev/test) no arranca la cron.
 */
@Injectable()
export class SubscriptionsDailyWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue<JobData>;
  private worker?: Worker<JobData>;
  private connection?: Redis;
  private workerConnection?: Redis;

  constructor(
    @Inject(forwardRef(() => ModuleRegistryService))
    private readonly registry: ModuleRegistryService,
    private readonly smtp: SmtpAdapterService,
    private readonly smtpResolver: TenantSmtpResolverService,
    private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) {
      this.logger.warn('REDIS_URL no seteada — subscriptions daily worker no arranca');
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
        backoff: { type: 'exponential', delay: 5 * 60_000 },
        removeOnComplete: { age: 14 * 24 * 3600, count: 30 },
        removeOnFail: { age: 30 * 24 * 3600, count: 30 },
      },
    });

    this.worker = new Worker<JobData>(QUEUE_NAME, async () => this.processJob(), {
      connection: this.workerConnection,
      concurrency: 1,
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err: err.message }, 'subscriptions daily job falló');
    });

    await this.queue.add('daily', {} as JobData, {
      repeat: { pattern: REPEAT_PATTERN, tz: REPEAT_TZ },
      jobId: 'daily-subscriptions',
    });
    this.logger.log(
      `subscriptions daily worker activo (cron='${REPEAT_PATTERN}' ${REPEAT_TZ}, ventana ${WINDOW_DAYS}d)`,
    );
  }

  /** Ejecuta el barrido ahora (QA/endpoint manual). In-process si no hay Redis. */
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
    for (const tenantId of tenants) {
      try {
        const resolved = await this.smtpResolver.resolve(tenantId);
        if (!resolved) {
          this.logger.log({ tenantId }, 'subscriptions daily: tenant sin SMTP, salto');
          continue;
        }
        await this.sendAdminDigest(service, resolved.config, tenantId);
        await this.sendMemberWarnings(service, resolved.config, tenantId);
      } catch (err) {
        this.logger.error(
          { tenantId, err: err instanceof Error ? err.message : String(err) },
          'subscriptions daily: fallo en tenant',
        );
      }
    }
  }

  private async sendAdminDigest(
    service: ReturnType<ModuleRegistryService['getPaymentConnectionsService']>,
    config: SmtpConfig,
    tenantId: string,
  ): Promise<void> {
    const [{ activeCount, upcoming }, adminEmails] = await Promise.all([
      service.getSubscriptionDigest(tenantId, WINDOW_DAYS),
      service.listTenantAdminEmails(tenantId),
    ]);
    if (adminEmails.length === 0) return;

    const lines = upcoming.length
      ? upcoming.map((u) => `· ${describeUpcoming(u)}`).join('\n')
      : `Ninguna en los próximos ${WINDOW_DAYS} días.`;
    const subject = `Resumen de suscripciones — ${activeCount} activas, ${upcoming.length} próximas (${WINDOW_DAYS} días)`;
    const text =
      `Suscripciones activas: ${activeCount}\n\n` +
      `Próximas a renovarse/caducar (${WINDOW_DAYS} días):\n${lines}\n\n` +
      `— Didacta`;

    for (const to of adminEmails) {
      const r = await this.smtp.send(config, { to, subject, text, html: renewalEmailHtml(text) });
      if (!r.ok) {
        this.logger.warn({ tenantId, to, err: r.error }, 'subscriptions daily: digest admin falló');
      }
    }
  }

  private async sendMemberWarnings(
    service: ReturnType<ModuleRegistryService['getPaymentConnectionsService']>,
    config: SmtpConfig,
    tenantId: string,
  ): Promise<void> {
    const [toWarn, cancelUrl] = await Promise.all([
      service.listSubscribersToWarn(tenantId, WINDOW_DAYS),
      service.getCancelPortalUrl(tenantId),
    ]);
    let sent = 0;
    for (const s of toWarn) {
      const text = buildWarningBody(s, cancelUrl);
      const subject = 'Tu suscripción se renovará pronto';
      try {
        const r = await this.smtp.send(config, {
          to: s.userEmail,
          subject,
          text,
          html: renewalEmailHtml(text),
        });
        if (r.ok) {
          await service.markRenewalWarned(s.id, s.currentPeriodEnd);
          sent++;
        } else {
          this.logger.warn({ tenantId, to: s.userEmail, err: r.error }, 'aviso 7d: envío falló');
        }
      } catch (err) {
        this.logger.warn(
          { tenantId, to: s.userEmail, err: err instanceof Error ? err.message : String(err) },
          'aviso 7d: excepción',
        );
      }
      // Ritmo suave (el volumen diario es bajo, pero evitamos ráfagas).
      await new Promise((res) => setTimeout(res, 300));
    }
    if (toWarn.length) {
      this.logger.log({ tenantId, sent, total: toWarn.length }, 'subscriptions daily: avisos 7d');
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

function fmtAmount(unitAmount: number | null, currency: string | null): string {
  if (unitAmount == null) return '';
  const value = (unitAmount / 100).toFixed(2);
  return ` por ${value} ${(currency ?? 'eur').toUpperCase()}`;
}

function fmtDate(d: Date): string {
  return new Date(d).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

function describeUpcoming(u: UpcomingRenewal): string {
  const plan = u.productName ?? 'Suscripción';
  const amount =
    u.unitAmount != null
      ? ` (${(u.unitAmount / 100).toFixed(2)} ${(u.currency ?? 'eur').toUpperCase()})`
      : '';
  return `${plan}${amount} · ${u.userEmail} · ${fmtDate(u.currentPeriodEnd)}`;
}

function buildWarningBody(s: SubscriberToWarn, cancelUrl: string | null): string {
  const plan = s.productName ? ` (${s.productName})` : '';
  const cancelLine = cancelUrl
    ? `Si no quieres continuar, puedes cancelarla aquí antes de esa fecha:\n${cancelUrl}`
    : `Si no quieres continuar, responde a este correo para cancelarla antes de esa fecha.`;
  return (
    `Hola,\n\n` +
    `Tu suscripción${plan} se renovará el ${fmtDate(s.currentPeriodEnd)}${fmtAmount(
      s.unitAmount,
      s.currency,
    )}.\n\n` +
    `${cancelLine}\n\n` +
    `Si quieres seguir, no tienes que hacer nada.\n\n— Didacta`
  );
}
