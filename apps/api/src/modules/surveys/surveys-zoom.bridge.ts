/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@didacta/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from '../module-context.factory';
import { ModuleRegistryService } from '../module-registry.service';

/**
 * Puente mod.zoom-live → mod.surveys (composición en el host: el emisor no
 * importa al receptor). Al terminar una clase (`zoom.session.ended`) crea la
 * encuesta post-clase (idempotente por sesión) y avisa a los inscritos por
 * in-app + email (plantilla `surveys.post_class.invitation`, personalizable en
 * /admin/emails).
 *
 * El enlace del email apunta a la página de la clase (/clase/[id]), donde vive
 * el panel de la encuesta — no hay URL propia de encuesta.
 *
 * TODO es best-effort: un fallo aquí JAMÁS afecta al cierre de la clase ni al
 * webhook de Zoom — se loguea y sigue.
 */

interface SessionEndedPayload {
  sessionId: string;
  meetingId?: string;
}

/** Enlace absoluto a la clase, o '' si WEB_PUBLIC_URL no está configurada. */
function classUrl(sessionId: string): string {
  const base = (process.env['WEB_PUBLIC_URL'] ?? '').trim().replace(/\/+$/, '');
  return base ? `${base}/clase/${sessionId}` : '';
}

@Injectable()
export class SurveysZoomBridge implements OnModuleInit {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const eventBus = this.factory.getEventBus();

    eventBus.subscribe<SessionEndedPayload>(
      'zoom.session.ended',
      async (event: DomainEvent<SessionEndedPayload>) => {
        try {
          await this.onSessionEnded(event.metadata.tenantId, event.data.sessionId);
        } catch (err) {
          this.logger.warn(
            {
              tenantId: event.metadata.tenantId,
              sessionId: event.data.sessionId,
              err: err instanceof Error ? err.message : String(err),
            },
            'mod.surveys: fallo creando/notificando la encuesta post-clase (la clase NO se ve afectada)',
          );
        }
      },
    );

    this.logger.log({}, 'SurveysZoomBridge: subscribed to zoom.session.ended');
  }

  private async onSessionEnded(tenantId: string, sessionId: string): Promise<void> {
    const prisma = this.factory.getPrisma();
    // Lectura acotada de mod_zoom_live_session (ADR-016, declarada en el manifest).
    const session = await prisma.modZoomSession.findFirst({
      where: { id: sessionId, tenantId },
      select: { topic: true },
    });
    if (!session) return;

    const { surveyId, created } = await this.registry.getSurveysService().createForZoomSession({
      tenantId,
      sessionId,
      topic: session.topic,
    });
    // Solo se notifica la PRIMERA vez: los webhooks de Zoom reintentan y un
    // `meeting.ended` duplicado no puede re-spamear a los inscritos.
    if (!created) return;

    const registrations = await prisma.modZoomSessionRegistration.findMany({
      where: { tenantId, sessionId },
      select: { userId: true },
    });
    if (registrations.length === 0) return;

    const variables = { topic: session.topic, surveyUrl: classUrl(sessionId) };
    // Secuencial a propósito: el hub hace SMTP por destinatario y no queremos
    // ráfagas paralelas contra el servidor de correo.
    for (const { userId } of registrations) {
      await this.notify(tenantId, userId, variables);
    }

    this.logger.log(
      { tenantId, sessionId, surveyId, recipients: registrations.length },
      'mod.surveys: encuesta post-clase creada y notificada',
    );
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
          templateKey: 'surveys.post_class.invitation',
          locale: 'es-ES',
          to: userId,
          variables,
          category: 'LEARNING',
        });
      } catch (err) {
        this.logger.warn(
          {
            tenantId,
            userId,
            channel,
            err: err instanceof Error ? err.message : String(err),
          },
          'mod.surveys: fallo al notificar la encuesta (la encuesta existe igualmente)',
        );
      }
    }
  }
}
