/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable } from '@nestjs/common';
import type { NotificationHubService, TenantConfigService } from '@didacta/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationRealtimePublisher } from './notifications/realtime/notification-realtime.publisher';
import { SmtpAdapterService, type SmtpConfig } from './smtp-adapter.service';
import { TenantSmtpResolverService } from './tenant-smtp-resolver.service';
import {
  resolveEmailBranding,
  renderBrandedEmail,
  textToHtmlParagraphs,
  type BrandingPrisma,
  type EmailBranding,
} from '../common/branded-email';
import {
  HUB_DEFAULT_LOCALE,
  interpolate,
  resolveFixedEmailCopy,
  resolveHubDefault,
  toHubTemplateLang,
} from './notifications/email-template-catalog';

/**
 * Implementación real del NotificationHub: persiste cada notificación en
 * la tabla `notification` y dispatcha al adapter del canal correspondiente.
 *
 * Estado de los adapters:
 * - **IN_APP**: implementado. La notificación se persiste y queda visible
 *   en `/notificaciones` para el alumno hasta que la marca como leída.
 * - **EMAIL**: implementado **per-tenant** desde PR #A2. Lee la config SMTP
 *   cifrada de `tenant_setting` (módulo `notifications`, key `smtp`) vía
 *   `TenantConfigService` y envía con `nodemailer`. Si el tenant no
 *   configuró SMTP, la notificación queda con `failedAt` y
 *   `failureReason='smtp_not_configured'` y se loguea — NO rompe el flujo.
 * - **WEBHOOK**: aún sin adapter (defer hasta caso real).
 *
 * El método `send` es siempre exitoso desde el punto de vista del caller
 * (no rethrow): los fallos del adapter se persisten en `failedAt` +
 * `failureReason` para que se puedan reintentar/auditar después.
 */
@Injectable()
export class PrismaNotificationHubService implements NotificationHubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    private readonly tenantConfig?: TenantConfigService,
    private readonly smtp?: SmtpAdapterService,
    /**
     * alpha.75 — si está presente, la resolución de SMTP delega en él, lo
     * que añade fallback a env globales (SMTP_HOST/PORT/USER/PASS/FROM)
     * cuando el tenant no tiene config propia. Sin él, comportamiento
     * legacy: skip si tenant no configuró SMTP.
     */
    private readonly smtpResolver?: TenantSmtpResolverService,
    /**
     * alpha.79 — si está presente, las notificaciones IN_APP se publican
     * además en Redis pub/sub para entregarlas en tiempo real (SSE). Opcional
     * y best-effort: si no está inyectado o el publish falla, la notificación
     * ya quedó persistida y el flujo no se rompe.
     */
    private readonly realtime?: NotificationRealtimePublisher,
  ) {}

  async send(notification: {
    tenantId: string;
    channel: 'email' | 'in-app' | 'webhook';
    templateKey: string;
    /**
     * Opcional: sin él, el hub resuelve el idioma del destinatario (`to` es
     * siempre un userId). Ver `resolveUserLocale` para los caminos degradados.
     */
    locale?: string;
    to: string;
    variables: Record<string, unknown>;
    category?: 'COMMUNITY' | 'LEARNING' | 'ASSESSMENTS' | 'SYSTEM';
  }): Promise<void> {
    const channel = this.mapChannel(notification.channel);

    // Respeta la preferencia del usuario cuando el caller declara la categoría.
    // Si el usuario deshabilitó este (categoría, canal), no persistimos ni
    // enviamos nada — el envío es opt-in por canal desde la matriz de su cuenta.
    if (
      notification.category &&
      !(await this.channelEnabled(
        notification.tenantId,
        notification.to,
        notification.category,
        channel,
      ))
    ) {
      return;
    }

    // Branding del tenant: el nombre queda disponible como {{tenantName}} en las
    // plantillas (para no firmar como "Didacta") y el logo/color se usan en el
    // email HTML. Best-effort: nunca rompe el envío.
    const webBaseUrl = process.env['WEB_PUBLIC_URL']?.trim() ?? '';
    const branding = await resolveEmailBranding(
      this.prisma as unknown as BrandingPrisma,
      notification.tenantId,
      webBaseUrl,
    );
    const renderVars = { tenantName: branding.tenantName, ...notification.variables };

    // El idioma lo pone el destinatario salvo que el caller lo imponga. La
    // consulta extra solo ocurre cuando el caller NO pasó locale.
    const locale =
      notification.locale ?? (await this.resolveUserLocale(notification.tenantId, notification.to));

    const rendered = await this.renderForTenant(
      notification.tenantId,
      notification.templateKey,
      channel,
      locale,
      renderVars,
    );

    const created = await this.prisma.notification.create({
      data: {
        tenantId: notification.tenantId,
        userId: notification.to,
        channel,
        templateKey: notification.templateKey,
        subject: rendered.subject ?? null,
        body: rendered.body,
        metadata: notification.variables as never,
        sentAt: channel === 'IN_APP' ? new Date() : null,
      },
    });

    if (channel === 'IN_APP') {
      // Realtime best-effort: publica el evento en Redis pub/sub para que los
      // clientes con un stream SSE abierto lo reciban al instante. NUNCA rompe
      // el flujo (el publisher tiene failsafe interno).
      await this.realtime?.publishInApp(notification.tenantId, notification.to, {
        id: created.id,
        templateKey: notification.templateKey,
        subject: rendered.subject ?? null,
        createdAt: created.createdAt,
        metadata: notification.variables,
      });
      return;
    }

    if (channel === 'EMAIL') {
      await this.sendEmail({
        notificationId: created.id,
        tenantId: notification.tenantId,
        userId: notification.to,
        subject: rendered.subject ?? '(sin asunto)',
        body: rendered.body,
        branding,
        webBaseUrl,
        locale,
      });
      return;
    }

    // WEBHOOK: no implementado todavía.
    await this.markFailed(created.id, 'webhook_adapter_not_implemented');
    this.logger.warn(
      { notificationId: created.id, channel },
      'NotificationHub: canal webhook aún sin adapter',
    );
  }

  private async sendEmail(args: {
    notificationId: string;
    tenantId: string;
    userId: string;
    subject: string;
    body: string;
    branding: EmailBranding;
    webBaseUrl: string;
    /**
     * Idioma con el que se renderizó el cuerpo. OBLIGATORIO: es el mismo que
     * ya resolvió `dispatch` (`notification.locale` o `user.locale`), y pasarlo
     * explícito evita que el envoltorio de marca salga en otro idioma que el
     * texto que envuelve.
     */
    locale: string;
  }): Promise<void> {
    if (!this.tenantConfig || !this.smtp) {
      // El hub se construyó en modo legacy (sin TenantConfig) — log y skip.
      // No debería pasar en producción tras PR #A2; lo dejamos como guardia.
      await this.markFailed(args.notificationId, 'smtp_not_configured');
      this.logger.warn(
        { notificationId: args.notificationId },
        'EMAIL skip: NotificationHub sin tenantConfig/smtp adapter inyectados',
      );
      return;
    }

    // alpha.75: prioriza el resolver (con fallback a env globales). Si no
    // está inyectado, cae al path legacy (sólo tenant_setting del tenant).
    let config: SmtpConfig;
    if (this.smtpResolver) {
      const resolved = await this.smtpResolver.resolve(args.tenantId);
      if (!resolved) {
        await this.markFailed(args.notificationId, 'smtp_not_configured');
        this.logger.log(
          { notificationId: args.notificationId, tenantId: args.tenantId },
          'EMAIL skip: el tenant no configuró SMTP y no hay fallback global',
        );
        return;
      }
      config = resolved.config;
    } else {
      const rawConfig = await this.tenantConfig.get(args.tenantId, 'notifications', 'smtp');
      if (!rawConfig) {
        await this.markFailed(args.notificationId, 'smtp_not_configured');
        this.logger.log(
          { notificationId: args.notificationId, tenantId: args.tenantId },
          'EMAIL skip: el tenant no configuró SMTP en /admin/configuracion',
        );
        return;
      }

      try {
        config = this.smtp.parseConfig(rawConfig);
      } catch (err) {
        await this.markFailed(
          args.notificationId,
          `smtp_config_invalid:${(err as Error).message.slice(0, 200)}`,
        );
        this.logger.warn(
          { notificationId: args.notificationId, tenantId: args.tenantId },
          'EMAIL skip: la config SMTP del tenant no es válida',
        );
        return;
      }
    }

    const recipientEmail = await this.resolveUserEmail(args.tenantId, args.userId);
    if (!recipientEmail) {
      await this.markFailed(args.notificationId, 'recipient_email_not_found');
      return;
    }

    // Envuelve el cuerpo renderizado en la plantilla de marca del tenant
    // (logo, color, firma con el nombre del tenant, footer "Powered by Didacta").
    // El cuerpo ya viene renderizado en el idioma del destinatario; el botón y
    // la nota del footer son ESTRUCTURALES (un override del tenant no los
    // puede quitar) y hasta ahora salían cableados en español, así que un
    // miembro con `locale = en-US` recibía un email inglés con el botón en
    // español. Mismo `locale` que el cuerpo, mismo catálogo.
    const copyVars = { tenantName: args.branding.tenantName };
    const { html, text } = renderBrandedEmail(args.branding, {
      lang: toHubTemplateLang(args.locale),
      title: args.subject,
      bodyHtml: textToHtmlParagraphs(args.body),
      bodyText: args.body,
      cta: args.webBaseUrl
        ? {
            url: args.webBaseUrl,
            label: interpolate(resolveFixedEmailCopy('cta.hub_enter', args.locale), copyVars),
          }
        : undefined,
      footerNote: interpolate(resolveFixedEmailCopy('footer.hub_member', args.locale), copyVars),
    });

    const result = await this.smtp.send(
      config,
      { to: recipientEmail, subject: args.subject, text, html },
      args.branding.tenantName,
    );

    if (result.ok) {
      await this.prisma.notification.update({
        where: { id: args.notificationId },
        data: { sentAt: new Date() },
      });
      this.logger.log(
        {
          notificationId: args.notificationId,
          tenantId: args.tenantId,
          messageId: result.messageId,
        },
        'EMAIL enviado',
      );
    } else {
      await this.markFailed(args.notificationId, `smtp_send_failed:${result.error ?? 'unknown'}`);
    }
  }

  /**
   * Idioma del destinatario para renderizar la notificación. `to` es siempre
   * un userId, así que el idioma sale de `user.locale`.
   *
   * Los TRES caminos degradados terminan en `HUB_DEFAULT_LOCALE` de forma
   * DELIBERADA — no por caída a un default implícito. Cada uno se loguea para
   * que un self-hoster pueda verlos en vez de descubrirlos por el idioma del
   * correo:
   *
   *  (a) El lookup falla o no hay fila (usuario borrado entre el evento y el
   *      envío, o userId de otro tenant): no hay a quién preguntarle el idioma.
   *  (b) La fila existe pero `locale` viene vacío: la columna tiene default en
   *      BD, así que esto solo pasa si alguien la escribió a mano en blanco.
   *  (c) El locale guardado no tiene catálogo (`pt-BR` es alcanzable HOY: lo
   *      admite `ALLOWED_LOCALES` en me.controller.ts pero no está traducido).
   *      No se resuelve aquí: se devuelve tal cual y lo absorbe
   *      `resolveHubDefault`, que mapea a español. Así el override per-tenant
   *      en `pt-BR` — si el tenant lo creó — todavía puede ganar.
   */
  private async resolveUserLocale(tenantId: string, userId: string): Promise<string> {
    let user: { locale: string; tenantId: string } | null;
    try {
      user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { locale: true, tenantId: true },
      });
    } catch (err) {
      // (a) el lookup falló — nunca rompe el envío.
      this.logger.warn(
        { userId, tenantId, err: (err as Error).message },
        `NotificationHub: no se pudo leer el idioma del destinatario, se usa ${HUB_DEFAULT_LOCALE}`,
      );
      return HUB_DEFAULT_LOCALE;
    }

    // (a) sin fila o de otro tenant.
    if (!user || user.tenantId !== tenantId) {
      this.logger.warn(
        { userId, tenantId },
        `NotificationHub: destinatario desconocido en el tenant, se usa ${HUB_DEFAULT_LOCALE}`,
      );
      return HUB_DEFAULT_LOCALE;
    }

    // (b) fila con locale vacío.
    const stored = typeof user.locale === 'string' ? user.locale.trim() : '';
    if (!stored) {
      this.logger.log(
        { userId, tenantId },
        `NotificationHub: el destinatario no tiene idioma, se usa ${HUB_DEFAULT_LOCALE}`,
      );
      return HUB_DEFAULT_LOCALE;
    }

    return stored;
  }

  private async resolveUserEmail(tenantId: string, userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, tenantId: true },
    });
    if (!user || user.tenantId !== tenantId) return null;
    return user.email;
  }

  private async markFailed(notificationId: string, reason: string): Promise<void> {
    await this.prisma.notification.update({
      where: { id: notificationId },
      data: { failedAt: new Date(), failureReason: reason.slice(0, 500) },
    });
  }

  /**
   * ¿Tiene el usuario habilitado este (categoría, canal)? La matriz de
   * preferencias es sparse: la ausencia de fila significa "activado" (default).
   * Solo persistimos filas cuando el usuario cambia algo, así que un usuario que
   * nunca tocó sus preferencias recibe por todos los canales.
   */
  private async channelEnabled(
    tenantId: string,
    userId: string,
    category: 'COMMUNITY' | 'LEARNING' | 'ASSESSMENTS' | 'SYSTEM',
    channel: 'EMAIL' | 'IN_APP' | 'WEBHOOK',
  ): Promise<boolean> {
    const pref = await this.prisma.userNotificationPreference.findUnique({
      where: {
        tenantId_userId_category_channel: { tenantId, userId, category, channel },
      },
      select: { enabled: true },
    });
    return pref?.enabled ?? true;
  }

  private mapChannel(channel: 'email' | 'in-app' | 'webhook'): 'EMAIL' | 'IN_APP' | 'WEBHOOK' {
    if (channel === 'email') return 'EMAIL';
    if (channel === 'webhook') return 'WEBHOOK';
    return 'IN_APP';
  }

  /**
   * Renderiza la notificación con prioridad:
   * 1. Override per-tenant en `notification_template` para (tenantId, key,
   *    channel, locale).
   * 2. Si no existe, override en el locale fallback es-ES (compat con
   *    tenants que solo configuran un idioma).
   * 3. Si no existe, plantilla hardcoded por defecto del producto.
   *
   * Esto permite que cada tenant personalice el copy de cada notificación
   * (subject + body con variables `{{var}}`) sin requerir redespliegue.
   */
  private async renderForTenant(
    tenantId: string,
    key: string,
    channel: 'EMAIL' | 'IN_APP' | 'WEBHOOK',
    locale: string,
    variables: Record<string, unknown>,
  ): Promise<RenderedTemplate> {
    const override =
      (await this.prisma.notificationTemplate.findUnique({
        where: {
          tenantId_key_channel_locale: { tenantId, key, channel, locale },
        },
      })) ??
      (locale !== HUB_DEFAULT_LOCALE
        ? await this.prisma.notificationTemplate.findUnique({
            where: {
              tenantId_key_channel_locale: { tenantId, key, channel, locale: HUB_DEFAULT_LOCALE },
            },
          })
        : null);

    if (override) {
      return {
        subject: override.subject ? interpolate(override.subject, variables) : null,
        body: interpolate(override.body, variables),
      };
    }
    return renderTemplate(key, locale, variables);
  }
}

interface RenderedTemplate {
  subject: string | null;
  body: string;
}

// Los defaults hardcoded del producto y la interpolación viven en el catálogo
// compartido (email-template-catalog.ts) desde alpha.83: los emails
// transaccionales usan la misma tabla de overrides y la misma sintaxis.
function renderTemplate(
  key: string,
  locale: string,
  variables: Record<string, unknown>,
): RenderedTemplate {
  const template = resolveHubDefault(key, locale);
  if (!template) {
    return {
      subject: key,
      body: `Notificación ${key}: ${JSON.stringify(variables)}`,
    };
  }
  return {
    subject: template.subject ? interpolate(template.subject, variables) : null,
    body: interpolate(template.body, variables),
  };
}
