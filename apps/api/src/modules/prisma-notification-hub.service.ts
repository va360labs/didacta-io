import { Injectable } from '@nestjs/common';
import type { NotificationHubService } from '@learnship/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Implementación real del NotificationHub: persiste cada notificación en
 * la tabla `notification` y dispatcha al adapter del canal correspondiente.
 *
 * Estado de los adapters:
 * - **IN_APP**: implementado. La notificación se persiste y queda visible
 *   en `/notificaciones` para el alumno hasta que la marca como leída.
 * - **EMAIL**: stub que loguea. Cuando llegue SMTP en Fase 1.B se
 *   reemplaza este branch por un cliente nodemailer/resend/ses sin tocar
 *   ni el contrato ni el resto del codebase.
 * - **WEBHOOK**: aún sin adapter (defer hasta que haya un caso real).
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
  ) {}

  async send(notification: {
    tenantId: string;
    channel: 'email' | 'in-app' | 'webhook';
    templateKey: string;
    locale: string;
    to: string; // userId para in-app/email; URL para webhook
    variables: Record<string, unknown>;
  }): Promise<void> {
    const channel = this.mapChannel(notification.channel);
    const rendered = renderTemplate(notification.templateKey, notification.variables);

    const created = await this.prisma.notification.create({
      data: {
        tenantId: notification.tenantId,
        userId: notification.to,
        channel,
        templateKey: notification.templateKey,
        subject: rendered.subject ?? null,
        body: rendered.body,
        metadata: notification.variables as never,
        // Para IN_APP: entregar = persistir, así que sentAt se rellena ya.
        sentAt: channel === 'IN_APP' ? new Date() : null,
      },
    });

    if (channel === 'IN_APP') {
      // Nada más que hacer: el alumno la verá al hacer GET /me/notifications.
      return;
    }

    if (channel === 'EMAIL') {
      // Adapter stub: log estructurado. Reemplazar por SMTP/Resend cuando
      // exista la infra. Si quisiéramos simular fallos para pruebas, podríamos
      // condicionar por tenantId o por una env var.
      this.logger.log(
        {
          notificationId: created.id,
          tenantId: notification.tenantId,
          userId: notification.to,
          subject: rendered.subject,
        },
        '[email-stub] notificación serializada — pendiente adapter SMTP',
      );
      await this.prisma.notification.update({
        where: { id: created.id },
        data: { sentAt: new Date() },
      });
      return;
    }

    // WEBHOOK: no implementado todavía.
    await this.prisma.notification.update({
      where: { id: created.id },
      data: { failedAt: new Date(), failureReason: 'webhook_adapter_not_implemented' },
    });
    this.logger.warn(
      { notificationId: created.id, channel },
      'NotificationHub: canal webhook aún sin adapter',
    );
  }

  private mapChannel(channel: 'email' | 'in-app' | 'webhook'): 'EMAIL' | 'IN_APP' | 'WEBHOOK' {
    if (channel === 'email') return 'EMAIL';
    if (channel === 'webhook') return 'WEBHOOK';
    return 'IN_APP';
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

/**
 * Catálogo de plantillas en memoria (v0.1). Sustituible por una tabla
 * `notification_template` por tenant cuando un cliente quiera personalizar
 * los textos. Por ahora, el código define la versión canónica en español.
 *
 * Cualquier `{{variable}}` se sustituye por `variables[variable]?.toString()`.
 * Si la variable no viene, se reemplaza por cadena vacía sin error.
 */
const TEMPLATES: Record<string, TemplateDef> = {
  'enrollment.created': {
    subject: 'Te matriculaste en {{course}}',
    body: 'Acabás de matricularte en el curso "{{course}}". ¡A aprender! Podés continuar desde tu panel.',
  },
  'course.completed': {
    subject: '¡Curso completado!',
    body: 'Felicitaciones, completaste el curso "{{course}}". Tu certificado se está generando y estará disponible en tu sección de certificados.',
  },
  'certificate.issued': {
    subject: 'Tu certificado de "{{course}}" está listo',
    body: 'Ya podés descargar el certificado número {{number}} desde Mis certificados.',
  },
  'attempt.passed': {
    subject: 'Aprobaste el quiz de "{{course}}"',
    body: 'Tu intento del quiz "{{quiz}}" obtuvo {{scorePercent}}% — ¡aprobaste!',
  },
  'attempt.failed': {
    subject: 'Resultado de quiz: no aprobado',
    body: 'Tu intento del quiz "{{quiz}}" obtuvo {{scorePercent}}%, por debajo del umbral del {{passThreshold}}%. Podés reintentarlo si el quiz lo permite.',
  },
  'attempt.graded': {
    subject: 'El formador corrigió tu quiz',
    body: 'Tu intento del quiz "{{quiz}}" fue corregido manualmente. Resultado: {{scorePercent}}% ({{result}}).',
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
