/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { NotificationTerm, NotificationValue } from '@didacta/core-kernel';
import { PrismaService } from '../../prisma/prisma.service';
import { ModuleContextFactory } from '../module-context.factory';

/** Quien revisa entregas y atiende solicitudes. */
const STAFF_ROLES = ['super_admin', 'tenant_admin', 'formador'];
/** Tope de avisos al equipo por evento: un tenant con 50 admins no se inunda. */
const STAFF_FANOUT_LIMIT = 10;

interface LevelChangedPayload {
  userId: string;
  levelName: string;
}

interface ChallengeReviewedPayload {
  userId: string;
  status: 'APPROVED' | 'REJECTED';
  title: string;
  points: number;
  reviewNote: string | null;
}

interface ChallengeSubmittedPayload {
  userId: string;
  challengeId: string;
}

interface PerkHandledPayload {
  userId: string;
  status: 'APPROVED' | 'DONE' | 'REJECTED';
  perkTitle: string;
  staffNote: string | null;
}

interface PerkRequestedPayload {
  userId: string;
  perkId: string;
}

/**
 * Cómo se resolvió la solicitud → TÉRMINO del hub. La frase ya no se redacta
 * aquí: este bridge no sabe en qué idioma lee el miembro (lo resuelve el hub
 * con su `user.locale`), así que antes mandaba la frase española dentro de la
 * variable `statusText` y el catálogo inglés no la alcanzaba — el email salía
 * en inglés con el párrafo central en español.
 *
 * `Partial` porque el payload del evento es un `string` en el borde: un estado
 * que este bridge no conozca cae al camino degradado de `perkStatusValue`.
 */
const PERK_STATUS_TERM: Partial<Record<string, NotificationTerm>> = {
  APPROVED: 'gamification.perk.approved',
  DONE: 'gamification.perk.done',
  REJECTED: 'gamification.perk.rejected',
};

/**
 * CAMINO DEGRADADO NOMBRADO: un `status` que este bridge no conoce (el módulo
 * añadió uno nuevo y nadie tocó este mapa) manda cadena vacía, exactamente como
 * antes (`PERK_STATUS_TEXT[status] ?? ''`). El email sale sin el párrafo del
 * resultado pero CON el asunto, el título del beneficio y la nota del equipo:
 * el miembro se entera de que su solicitud se ha resuelto.
 */
function perkStatusValue(status: string, perkTitle: string): NotificationValue | string {
  const term = PERK_STATUS_TERM[status];
  if (!term) return '';
  return { hubValue: 'term', term, vars: { perkTitle } };
}

/**
 * Avisos de mod.gamification.
 *
 * Sin esto el sistema no cierra el círculo: alguien entrega un reto, el equipo
 * lo aprueba, y el alumno no se entera salvo que vuelva a entrar y mire. El
 * esfuerzo cae en el vacío y los puntos dejan de motivar.
 *
 * Al alumno se le avisa por dentro y por email; al equipo solo por dentro, para
 * no llenarle el correo — pero se le avisa, porque una cola de revisión que
 * nadie mira se pudre.
 *
 * Todo best-effort: un fallo aquí nunca rompe la revisión ni el asiento.
 */
@Injectable()
export class GamificationNotificationsBridge implements OnModuleInit {
  private readonly logger = new Logger(GamificationNotificationsBridge.name);

  constructor(
    private readonly factory: ModuleContextFactory,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    const bus = this.factory.getEventBus();

    bus.subscribe<LevelChangedPayload>('gamification.level.changed', async (event) => {
      await this.notifyMember(event.metadata.tenantId, event.data.userId, {
        templateKey: 'gamification.level.reached',
        variables: { levelName: event.data.levelName },
      });
    });

    bus.subscribe<ChallengeReviewedPayload>('gamification.challenge.reviewed', async (event) => {
      const approved = event.data.status === 'APPROVED';
      await this.notifyMember(event.metadata.tenantId, event.data.userId, {
        templateKey: approved
          ? 'gamification.challenge.approved'
          : 'gamification.challenge.rejected',
        variables: {
          title: event.data.title,
          points: String(event.data.points ?? ''),
          reviewNote: event.data.reviewNote ?? '',
        },
      });
    });

    bus.subscribe<PerkHandledPayload>('gamification.perk.handled', async (event) => {
      await this.notifyMember(event.metadata.tenantId, event.data.userId, {
        templateKey: 'gamification.perk.handled',
        variables: {
          perkTitle: event.data.perkTitle,
          statusText: perkStatusValue(event.data.status, event.data.perkTitle),
          staffNote: event.data.staffNote ?? '',
        },
      });
    });

    // Avisos al equipo: hay algo esperando en la cola.
    bus.subscribe<ChallengeSubmittedPayload>('gamification.challenge.submitted', async (event) => {
      await this.notifyStaff(event.metadata.tenantId, 'gamification.staff.challenge_submitted');
    });

    bus.subscribe<PerkRequestedPayload>('gamification.perk.requested', async (event) => {
      await this.notifyStaff(event.metadata.tenantId, 'gamification.staff.perk_requested');
    });

    this.logger.log('Avisos de gamificación suscritos (5 eventos)');
  }

  /** Al miembro: por dentro y por email, con plantilla editable por el tenant. */
  private async notifyMember(
    tenantId: string | undefined,
    userId: string,
    args: { templateKey: string; variables: Record<string, unknown> },
  ): Promise<void> {
    if (!tenantId) return;
    const hub = this.factory.getNotificationHub();
    for (const channel of ['in-app', 'email'] as const) {
      try {
        await hub.send({
          tenantId,
          channel,
          templateKey: args.templateKey,
          to: userId,
          variables: args.variables,
          category: 'COMMUNITY',
        });
      } catch (err) {
        this.logger.warn(
          `gamificación: fallo al avisar (${args.templateKey}/${channel}) a ${userId}: ${String(err)}`,
        );
      }
    }
  }

  /**
   * Al equipo: solo dentro de la plataforma. Usa la plantilla
   * `gamification.staff.pending`, que enmarca el aviso; el aviso EN SÍ viaja
   * como término (`term`) porque el equipo de un tenant puede tener gente en
   * los dos idiomas y quien conoce el de cada uno es el hub. Antes se pasaba la
   * frase española ya redactada y el admin anglófono leía «You have something
   * to review» seguido de «Nueva entrega de reto pendiente de revisar.».
   */
  private async notifyStaff(
    tenantId: string | undefined,
    message: NotificationTerm,
  ): Promise<void> {
    if (!tenantId) return;
    try {
      const staff = await this.prisma.user.findMany({
        where: {
          tenantId,
          deletedAt: null,
          status: 'ACTIVE',
          roles: { some: { role: { name: { in: STAFF_ROLES } } } },
        },
        select: { id: true },
        take: STAFF_FANOUT_LIMIT,
      });
      const hub = this.factory.getNotificationHub();
      for (const member of staff) {
        await hub.send({
          tenantId,
          channel: 'in-app',
          templateKey: 'gamification.staff.pending',
          to: member.id,
          variables: { message: { hubValue: 'term', term: message } },
          category: 'COMMUNITY',
        });
      }
    } catch (err) {
      this.logger.warn(`gamificación: fallo al avisar al equipo: ${String(err)}`);
    }
  }
}
