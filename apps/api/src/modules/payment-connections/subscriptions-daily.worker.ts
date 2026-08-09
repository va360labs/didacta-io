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
import type { UpcomingRenewal } from '@didacta/mod-payment-connections';
import { runAsTenant, runSanctionedGlobalAccess } from '../../tenancy/tenant-context.storage';
import { ModuleRegistryService } from '../module-registry.service';
import { SmtpAdapterService, type SmtpConfig } from '../smtp-adapter.service';
import { TenantSmtpResolverService } from '../tenant-smtp-resolver.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  resolveEmailBranding,
  renderBrandedEmail,
  textToHtmlParagraphs,
  type BrandingPrisma,
  type EmailBranding,
} from '../../common/branded-email';
import {
  applyEmailOverride,
  emailDateLocale,
  fetchEmailOverride,
  HUB_DEFAULT_LOCALE,
  interpolate,
  resolveFixedEmailCopy,
  resolveRecipientLocale,
  resolveTransactionalDefault,
  toHubTemplateLang,
  type RawEmailOverride,
  type TemplateOverridePrisma,
} from '../notifications/email-template-catalog';

const QUEUE_NAME = 'didacta.payment-connections.daily';
// 9:00 UTC por defecto. Cada instalación ajusta su zona con
// SUBSCRIPTIONS_DAILY_TZ (identificador IANA, ej. Europe/Madrid).
const REPEAT_PATTERN = process.env['SUBSCRIPTIONS_DAILY_CRON'] ?? '0 9 * * *';
const REPEAT_TZ = process.env['SUBSCRIPTIONS_DAILY_TZ'] ?? 'UTC';
/** Ventana del resumen + del aviso previo (días antes de la renovación/caducidad). */
const WINDOW_DAYS = Math.max(1, Number(process.env['SUBSCRIPTIONS_RENEWAL_WINDOW_DAYS'] ?? 7));
/** Keys de este worker en el catálogo de plantillas del producto. */
const DIGEST_TEMPLATE_KEY = 'subscriptions.admin_digest';
const RENEWAL_TEMPLATE_KEY = 'subscriptions.renewal_warning';
const ACCESS_EXPIRING_TEMPLATE_KEY = 'payment_connections.access_expiring';

type JobData = Record<string, never>;

/**
 * Worker BullMQ diario (9:00 UTC por defecto). Por cada tenant con
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
    private readonly prisma: PrismaService,
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
    // Barrido cross-tenant de conexiones VERIFIED (inventario RLS F3).
    const tenants = await runSanctionedGlobalAccess(() =>
      service.listTenantsWithVerifiedConnections(),
    );
    for (const tenantId of tenants) {
      try {
        // Todo el procesado del tenant (SMTP, branding, overrides, digest,
        // avisos y marks) corre bajo su contexto (scope RLS).
        await runAsTenant(tenantId, async () => {
          const resolved = await this.smtpResolver.resolve(tenantId);
          if (!resolved) {
            this.logger.log({ tenantId }, 'subscriptions daily: tenant sin SMTP, salto');
            return;
          }
          const branding = await resolveEmailBranding(
            this.prisma as unknown as BrandingPrisma,
            tenantId,
            process.env['WEB_PUBLIC_URL']?.trim() ?? '',
          );
          await this.sendAdminDigest(service, resolved.config, tenantId, branding);
          await this.sendMemberWarnings(service, resolved.config, tenantId, branding);
          // Los accesos con vigencia no los cubre el aviso de renovación: viven
          // en otra tabla y nadie más va a avisar de ellos.
          await this.sendTimedAccessWarnings(resolved.config, tenantId, branding);
        });
      } catch (err) {
        this.logger.error(
          { tenantId, err: err instanceof Error ? err.message : String(err) },
          'subscriptions daily: fallo en tenant',
        );
      }
    }
  }

  /**
   * Idioma de cada destinatario a partir de su fila en `user`, en UNA consulta
   * por lote (no una por email).
   *
   * CAMINO DEGRADADO NOMBRADO: los destinatarios de este worker son emails
   * arbitrarios —un suscriptor de Stripe o un comprador de WooCommerce puede no
   * ser usuario de la plataforma—, así que quien no tenga fila cae a
   * `HUB_DEFAULT_LOCALE`. Si la consulta revienta, TODOS caen ahí y el aviso
   * sale igual: perder el idioma es aceptable, perder el aviso no.
   */
  private async localesByEmail(
    tenantId: string,
    emails: readonly string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (emails.length === 0) return out;
    try {
      const rows = await this.prisma.user.findMany({
        where: { tenantId, email: { in: [...new Set(emails)] } },
        select: { email: true, locale: true },
      });
      for (const r of rows) out.set(r.email, resolveRecipientLocale(r.locale));
    } catch (err) {
      this.logger.warn(
        { tenantId, err: err instanceof Error ? err.message : String(err) },
        'subscriptions daily: no se pudo leer el idioma de los destinatarios',
      );
    }
    return out;
  }

  private async sendAdminDigest(
    service: ReturnType<ModuleRegistryService['getPaymentConnectionsService']>,
    config: SmtpConfig,
    tenantId: string,
    branding: EmailBranding,
  ): Promise<void> {
    const [{ activeCount, upcoming }, adminEmails] = await Promise.all([
      service.getSubscriptionDigest(tenantId, WINDOW_DAYS),
      service.listTenantAdminEmails(tenantId),
    ]);
    if (adminEmails.length === 0) return;

    // Cada admin lo lee en SU idioma, así que el digest se compone una vez por
    // idioma presente (no una por admin) y se manda a los suyos.
    const localeOf = await this.localesByEmail(tenantId, adminEmails);
    const byLocale = new Map<string, string[]>();
    for (const to of adminEmails) {
      const locale = localeOf.get(to) ?? HUB_DEFAULT_LOCALE;
      byLocale.set(locale, [...(byLocale.get(locale) ?? []), to]);
    }

    for (const [locale, recipients] of byLocale) {
      const lines = upcoming.length
        ? upcoming.map((u) => `· ${describeUpcoming(u, locale)}`).join('\n')
        : interpolate(resolveFixedEmailCopy('value.no_upcoming_renewals', locale), {
            windowDays: WINDOW_DAYS,
          });
      const vars = {
        activeCount,
        upcomingCount: upcoming.length,
        windowDays: WINDOW_DAYS,
        upcomingList: lines,
        tenantName: branding.tenantName,
      };
      // alpha.83 — subject/cuerpo personalizables per-tenant desde /admin/emails,
      // primero en el idioma del admin y si no en el de referencia (misma
      // precedencia que el hub).
      const override = await fetchEmailOverride(
        this.prisma as unknown as TemplateOverridePrisma,
        tenantId,
        DIGEST_TEMPLATE_KEY,
        locale,
      );
      // El cuerpo se renderiza DESDE el catálogo en los dos idiomas: el default
      // español de esta key es espejo byte a byte del copy que este worker
      // redactaba a mano, así que composer y catálogo no pueden divergir.
      const def = resolveTransactionalDefault(DIGEST_TEMPLATE_KEY, locale)!;
      let subject = interpolate(def.subject ?? '', vars);
      let bodyText = interpolate(def.body, vars);
      let title = resolveFixedEmailCopy('title.subscriptions_digest', locale);
      if (override) {
        const applied = applyEmailOverride(override, vars, subject);
        subject = applied.subject;
        bodyText = applied.bodyText;
        title = applied.subject;
      }
      const { html, text } = renderBrandedEmail(branding, {
        lang: toHubTemplateLang(locale),
        title,
        bodyHtml: textToHtmlParagraphs(bodyText),
        bodyText,
      });

      for (const to of recipients) {
        const r = await this.smtp.send(config, { to, subject, text, html }, branding.tenantName);
        if (!r.ok) {
          this.logger.warn(
            { tenantId, to, err: r.error },
            'subscriptions daily: digest admin falló',
          );
        }
      }
    }
  }

  private async sendMemberWarnings(
    service: ReturnType<ModuleRegistryService['getPaymentConnectionsService']>,
    config: SmtpConfig,
    tenantId: string,
    branding: EmailBranding,
  ): Promise<void> {
    const [toWarn, cancelUrl] = await Promise.all([
      service.listSubscribersToWarn(tenantId, WINDOW_DAYS),
      service.getCancelPortalUrl(tenantId),
    ]);
    // El aviso lo lee el SUSCRIPTOR, así que va en su idioma. Un fetch de
    // idiomas por lote y un fetch de override por idioma distinto (no por
    // email): el volumen diario es bajo, pero no hace falta castigarlo.
    const localeOf = await this.localesByEmail(
      tenantId,
      toWarn.map((s) => s.userEmail),
    );
    const overrideByLocale = new Map<string, RawEmailOverride | null>();
    let sent = 0;
    for (const s of toWarn) {
      const locale = localeOf.get(s.userEmail) ?? HUB_DEFAULT_LOCALE;
      // alpha.83 — override per-tenant del aviso, primero en el idioma del
      // suscriptor y si no en el de referencia (misma precedencia que el hub).
      if (!overrideByLocale.has(locale)) {
        overrideByLocale.set(
          locale,
          await fetchEmailOverride(
            this.prisma as unknown as TemplateOverridePrisma,
            tenantId,
            RENEWAL_TEMPLATE_KEY,
            locale,
          ),
        );
      }
      const override = overrideByLocale.get(locale) ?? null;
      const vars = {
        plan: s.productName ?? '',
        renewalDate: fmtDate(s.currentPeriodEnd, locale),
        amount:
          s.unitAmount != null
            ? `${(s.unitAmount / 100).toFixed(2)} ${(s.currency ?? 'eur').toUpperCase()}`
            : '',
        cancelUrl: cancelUrl ?? '',
        tenantName: branding.tenantName,
      };
      // Cuerpo renderizado DESDE el catálogo en los dos idiomas: el default
      // español de esta key es espejo byte a byte del texto que este worker
      // redactaba a mano, así que composer y catálogo son el MISMO texto.
      const def = resolveTransactionalDefault(RENEWAL_TEMPLATE_KEY, locale)!;
      let subject = interpolate(def.subject ?? '', vars);
      let bodyText = interpolate(def.body, vars);
      if (override) {
        const applied = applyEmailOverride(override, vars, subject);
        subject = applied.subject;
        bodyText = applied.bodyText;
      }
      const { html, text } = renderBrandedEmail(branding, {
        lang: toHubTemplateLang(locale),
        title: subject,
        bodyHtml: textToHtmlParagraphs(bodyText),
        bodyText,
        // Estructural: el override no puede quitar el botón del portal, pero su
        // etiqueta sale en el idioma del suscriptor.
        ...(cancelUrl
          ? {
              cta: {
                url: cancelUrl,
                label: resolveFixedEmailCopy('cta.manage_subscription', locale),
              },
            }
          : {}),
      });
      try {
        const r = await this.smtp.send(
          config,
          { to: s.userEmail, subject, text, html },
          branding.tenantName,
        );
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

  /**
   * Aviso a quien compró un acceso con vigencia (pago único, no suscripción).
   *
   * Va aparte del aviso de renovación porque el mensaje es el contrario: aquí
   * **no se va a cobrar nada** y el acceso simplemente termina. Decirle «se te
   * cobrará el día X» a alguien que tiene que volver a comprar es mandarle a
   * esperar un cobro que no llega — que es justo lo que hizo que 50 de estos
   * accesos caducaran sin que nadie se enterara.
   */
  private async sendTimedAccessWarnings(
    config: SmtpConfig,
    tenantId: string,
    branding: EmailBranding,
  ): Promise<void> {
    const mirror = this.registry.getOrderMirrorService();
    const toWarn = await mirror.listTimedAccessToWarn(tenantId, WINDOW_DAYS);
    if (toWarn.length === 0) return;

    // Lo lee el COMPRADOR: su idioma manda. Como en el aviso de renovación,
    // un fetch de idiomas por lote y un override por idioma distinto.
    const localeOf = await this.localesByEmail(
      tenantId,
      toWarn.map((a) => a.customerEmail),
    );
    const overrideByLocale = new Map<string, RawEmailOverride | null>();

    let sent = 0;
    for (const a of toWarn) {
      const locale = localeOf.get(a.customerEmail) ?? HUB_DEFAULT_LOCALE;
      if (!overrideByLocale.has(locale)) {
        overrideByLocale.set(
          locale,
          await fetchEmailOverride(
            this.prisma as unknown as TemplateOverridePrisma,
            tenantId,
            ACCESS_EXPIRING_TEMPLATE_KEY,
            locale,
          ),
        );
      }
      const override = overrideByLocale.get(locale) ?? null;
      const producto = a.products.join(', ') || resolveFixedEmailCopy('value.your_access', locale);
      const fecha = fmtDate(a.accessEndsAt, locale);
      const vars = {
        plan: producto,
        renewalDate: fecha,
        amount: '',
        cancelUrl: '',
        tenantName: branding.tenantName,
      };
      const def = resolveTransactionalDefault(ACCESS_EXPIRING_TEMPLATE_KEY, locale)!;

      let subject = interpolate(def.subject ?? '', vars);
      // El español conserva su texto propio byte a byte (saluda por nombre, que
      // el default del catálogo no hace); el inglés se renderiza DESDE el
      // catálogo para que composer y catálogo no puedan divergir.
      let bodyText =
        toHubTemplateLang(locale) === 'en'
          ? interpolate(def.body, vars)
          : `Hola${a.customerName ? ` ${a.customerName}` : ''},\n\n` +
            `Tu acceso a ${producto} termina el ${fecha}.\n\n` +
            `A diferencia de una suscripción, este acceso no se renueva solo: ` +
            `si quieres seguir, tendrás que renovarlo antes de esa fecha.\n\n` +
            `Si ya lo has renovado, puedes ignorar este mensaje.`;

      if (override) {
        const applied = applyEmailOverride(override, vars, subject);
        subject = applied.subject;
        bodyText = applied.bodyText;
      }

      const { html, text } = renderBrandedEmail(branding, {
        lang: toHubTemplateLang(locale),
        title: subject,
        bodyHtml: textToHtmlParagraphs(bodyText),
        bodyText,
      });

      try {
        const r = await this.smtp.send(
          config,
          { to: a.customerEmail, subject, text, html },
          branding.tenantName,
        );
        if (r.ok) {
          await mirror.markExpiryWarned(a.id, a.accessEndsAt);
          sent++;
        } else {
          this.logger.warn(
            { tenantId, to: a.customerEmail, err: r.error },
            'aviso caducidad: envío falló',
          );
        }
      } catch (err) {
        this.logger.warn(
          {
            tenantId,
            to: a.customerEmail,
            err: err instanceof Error ? err.message : String(err),
          },
          'aviso caducidad: excepción',
        );
      }
      await new Promise((res) => setTimeout(res, 300));
    }

    this.logger.log(
      { tenantId, sent, total: toWarn.length },
      'subscriptions daily: avisos de caducidad de acceso',
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

/**
 * Fecha larga en el idioma del destinatario. Antes cableaba `es-ES`, así que un
 * email inglés decía «24 de julio de 2026» en mitad de una frase en inglés.
 */
function fmtDate(d: Date, locale: string): string {
  return new Date(d).toLocaleDateString(emailDateLocale(locale), {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

function describeUpcoming(u: UpcomingRenewal, locale: string): string {
  const plan = u.productName ?? resolveFixedEmailCopy('value.subscription', locale);
  const amount =
    u.unitAmount != null
      ? ` (${(u.unitAmount / 100).toFixed(2)} ${(u.currency ?? 'eur').toUpperCase()})`
      : '';
  return `${plan}${amount} · ${u.userEmail} · ${fmtDate(u.currentPeriodEnd, locale)}`;
}
