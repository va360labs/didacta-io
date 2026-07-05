import { Injectable } from '@nestjs/common';
import type { NotificationHubService, TenantConfigService } from '@didacta/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationRealtimePublisher } from './notifications/realtime/notification-realtime.publisher';
import { SmtpAdapterService, type SmtpConfig } from './smtp-adapter.service';
import { TenantSmtpResolverService } from './tenant-smtp-resolver.service';

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
    locale: string;
    to: string;
    variables: Record<string, unknown>;
  }): Promise<void> {
    const channel = this.mapChannel(notification.channel);
    const rendered = await this.renderForTenant(
      notification.tenantId,
      notification.templateKey,
      channel,
      notification.locale,
      notification.variables,
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

    const result = await this.smtp.send(config, {
      to: recipientEmail,
      subject: args.subject,
      text: args.body,
    });

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
      (locale !== 'es-ES'
        ? await this.prisma.notificationTemplate.findUnique({
            where: {
              tenantId_key_channel_locale: { tenantId, key, channel, locale: 'es-ES' },
            },
          })
        : null);

    if (override) {
      return {
        subject: override.subject ? interpolate(override.subject, variables) : null,
        body: interpolate(override.body, variables),
      };
    }
    return renderTemplate(key, variables);
  }
}

interface RenderedTemplate {
  subject: string | null;
  body: string;
}

interface TemplateDef {
  subject: string | null;
  body: string;
}

const TEMPLATES: Record<string, TemplateDef> = {
  'enrollment.created': {
    subject: 'Te matriculaste en {{course}}',
    body: 'Acabas de matricularte en el curso "{{course}}". ¡A aprender! Puedes continuar desde tu panel.',
  },
  'course.completed': {
    subject: '¡Curso completado!',
    body: 'Felicitaciones, completaste el curso "{{course}}". Tu certificado se está generando y estará disponible en tu sección de certificados.',
  },
  'certificate.issued': {
    subject: 'Tu certificado de "{{course}}" está listo',
    body: 'Ya puedes descargar el certificado número {{number}} desde Mis certificados.',
  },
  'attempt.passed': {
    subject: 'Aprobaste el quiz de "{{course}}"',
    body: 'Tu intento del quiz "{{quiz}}" obtuvo {{scorePercent}}% — ¡aprobaste!',
  },
  'attempt.failed': {
    subject: 'Resultado de quiz: no aprobado',
    body: 'Tu intento del quiz "{{quiz}}" obtuvo {{scorePercent}}%, por debajo del umbral del {{passThreshold}}%. Puedes reintentarlo si el quiz lo permite.',
  },
  'attempt.graded': {
    subject: 'El formador corrigió tu quiz',
    body: 'Tu intento del quiz "{{quiz}}" fue corregido manualmente. Resultado: {{scorePercent}}% ({{result}}).',
  },
  'admin.smtp.test': {
    subject: 'Prueba de SMTP — Didacta',
    body: 'Si recibiste este correo, la configuración SMTP de tu tenant en Didacta funciona correctamente.\n\nTenant: {{tenantSlug}}\nFecha: {{timestamp}}',
  },
  'community.mention': {
    subject: 'Te mencionaron en la comunidad',
    body: '@{{handle}} te mencionó en un {{#commentId}}comentario{{/commentId}}{{#postId}}post{{/postId}}. Entra a la app para ver el hilo completo.',
  },
  'community.digest.weekly': {
    subject:
      'Tu resumen semanal de la comunidad ({{mentionsCount}} menciones · {{repliesCount}} respuestas)',
    body: 'Esta semana en la comunidad:\n\n· {{mentionsCount}} mención(es) nueva(s)\n· {{repliesCount}} respuesta(s) en hilos donde participaste\n\nEntra a Didacta y revisa /comunidad/menciones para verlas todas. Desde el resumen anterior: {{sinceIso}}.',
  },
  // Aviso masivo (broadcast) a toda la comunidad. Passthrough: el worker compone
  // el asunto y el cuerpo (mensaje + enlace de baja en email) y los pasa como vars.
  'community.broadcast': {
    subject: '{{subject}}',
    body: '{{body}}',
  },
  // Aviso de desbloqueo de una clase programada por fecha (MEJ-009). Lo dispara
  // el LessonUnlockNotifierWorker cuando la lección cruza su publishAt.
  'lesson.unlocked': {
    subject: 'Ya está disponible: {{lessonTitle}}',
    body: 'La clase "{{lessonTitle}}" del curso "{{courseTitle}}" ya está disponible. Entra a Didacta para verla.',
  },
};

function renderTemplate(key: string, variables: Record<string, unknown>): RenderedTemplate {
  const template = TEMPLATES[key];
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

function interpolate(text: string, variables: Record<string, unknown>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
    const v = variables[name];
    return v === undefined || v === null ? '' : String(v);
  });
}
