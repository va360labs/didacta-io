import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@didacta/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from '../module-context.factory';
import { calendarVariables } from './class-links';

/**
 * Puente mod.zoom-live → NotificationHub (ADR-017): confirma la inscripción a
 * una clase en directo (in-app + email, plantilla
 * `zoom.class.registration.confirmed`) y avisa a todos los inscritos cuando la
 * clase se cancela (`zoom.class.cancelled`). Plantillas personalizables en
 * /admin/emails, categoría LEARNING (respeta la matriz de preferencias del
 * usuario).
 *
 * La confirmación lleva además los enlaces de "añadir al calendario" (Google
 * y `.ics` para Outlook/Apple): inscribirse y no apuntarlo es la vía más
 * corta a perderse la clase.
 *
 * El joinUrl de Zoom NUNCA viaja por email: el enlace que se envía es la
 * página de la clase (/clase/[id]), donde el gating server-side decide.
 *
 * Best-effort: un fallo del hub jamás afecta a la inscripción ni a la
 * cancelación (el hub además no relanza errores de SMTP).
 */

interface RegistrationCreatedPayload {
  sessionId: string;
  userId: string;
  topic: string;
  /** ISO 8601 UTC. */
  startTime: string;
  /** IANA del formador (para formatear la hora al avisar). */
  timezone: string;
  courseId: string | null;
}

interface SessionCancelledPayload {
  sessionId: string;
  topic?: string;
  startTime?: string;
  timezone?: string;
  registeredUserIds?: string[];
}

function formatStartsAt(iso: string | undefined, timezone: string | undefined): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('es-ES', {
      timeZone: timezone || 'UTC',
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString();
  }
}

@Injectable()
export class ZoomLiveNotificationsBridge implements OnModuleInit {
  constructor(
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const eventBus = this.factory.getEventBus();

    eventBus.subscribe<RegistrationCreatedPayload>(
      'zoom.session.registration.created',
      async (event: DomainEvent<RegistrationCreatedPayload>) => {
        await this.notify(event.metadata.tenantId, event.data.userId, {
          templateKey: 'zoom.class.registration.confirmed',
          variables: {
            topic: event.data.topic,
            startsAt: formatStartsAt(event.data.startTime, event.data.timezone),
            ...calendarVariables(event.data.sessionId),
          },
        });
      },
    );

    eventBus.subscribe<SessionCancelledPayload>(
      'zoom.session.cancelled',
      async (event: DomainEvent<SessionCancelledPayload>) => {
        const userIds = event.data.registeredUserIds ?? [];
        if (userIds.length === 0) return;
        const variables = {
          topic: event.data.topic ?? '',
          startsAt: formatStartsAt(event.data.startTime, event.data.timezone),
        };
        // Secuencial a propósito: el hub hace SMTP por destinatario y no
        // queremos ráfagas paralelas contra el servidor de correo. El
        // subscriber corre fuera del request de cancelación.
        for (const userId of userIds) {
          await this.notify(event.metadata.tenantId, userId, {
            templateKey: 'zoom.class.cancelled',
            variables,
          });
        }
      },
    );

    this.logger.log({}, 'ZoomLiveNotificationsBridge: subscribed to zoom-live events');
  }

  private async notify(
    tenantId: string,
    userId: string,
    args: { templateKey: string; variables: Record<string, unknown> },
  ): Promise<void> {
    const hub = this.factory.getNotificationHub();
    for (const channel of ['in-app', 'email'] as const) {
      try {
        await hub.send({
          tenantId,
          channel,
          templateKey: args.templateKey,
          locale: 'es-ES',
          to: userId,
          variables: args.variables,
          category: 'LEARNING',
        });
      } catch (err) {
        this.logger.warn(
          {
            tenantId,
            userId,
            templateKey: args.templateKey,
            channel,
            err: err instanceof Error ? err.message : String(err),
          },
          'zoom-live: fallo al notificar (la inscripción/cancelación NO se ve afectada)',
        );
      }
    }
  }
}
