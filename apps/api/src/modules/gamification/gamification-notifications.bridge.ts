/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
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

/** Frase del aviso según cómo se resolvió la solicitud. */
const PERK_STATUS_TEXT: Record<string, string> = {
  APPROVED: 'Hemos aprobado tu solicitud de "{{perkTitle}}". Te escribimos para cuadrarlo.',
  DONE: 'Tu solicitud de "{{perkTitle}}" ya está hecha. ¡Esperamos que te haya servido!',
  REJECTED: 'Esta vez no hemos podido atender tu solicitud de "{{perkTitle}}".',
};

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
      const text = (PERK_STATUS_TEXT[event.data.status] ?? '').replace(
        '{{perkTitle}}',
        event.data.perkTitle,
      );
      await this.notifyMember(event.metadata.tenantId, event.data.userId, {
        templateKey: 'gamification.perk.handled',
        variables: {
          perkTitle: event.data.perkTitle,
          statusText: text,
          staffNote: event.data.staffNote ?? '',
        },
      });
    });

    // Avisos al equipo: hay algo esperando en la cola.
    bus.subscribe<ChallengeSubmittedPayload>('gamification.challenge.submitted', async (event) => {
      await this.notifyStaff(
        event.metadata.tenantId,
        'Nueva entrega de reto pendiente de revisar.',
      );
    });

    bus.subscribe<PerkRequestedPayload>('gamification.perk.requested', async (event) => {
      await this.notifyStaff(
        event.metadata.tenantId,
        'Alguien ha pedido un beneficio de su nivel.',
      );
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
          locale: 'es-ES',
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
   * Al equipo: solo dentro de la plataforma. Se envía sin plantilla del
   * catálogo porque es un aviso operativo, no un email al miembro.
   */
  private async notifyStaff(tenantId: string | undefined, message: string): Promise<void> {
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
          locale: 'es-ES',
          to: member.id,
          variables: { message },
          category: 'COMMUNITY',
        });
      }
    } catch (err) {
      this.logger.warn(`gamificación: fallo al avisar al equipo: ${String(err)}`);
    }
  }
}
