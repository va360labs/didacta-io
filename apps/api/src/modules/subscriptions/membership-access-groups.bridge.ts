/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@didacta/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { MEMBERSHIP_PLAN_CHANGED_EVENT } from '@didacta/mod-subscriptions';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessGroupsService } from '../access-groups/access-groups.service';
import { ModuleContextFactory } from '../module-context.factory';
import { ModuleRegistryService } from '../module-registry.service';

/**
 * Puente membresía → mod.access-groups. El entitlement de la membresía es un
 * GRUPO de acceso: el del NIVEL del plan que se paga (Básico, Pro…) o, en un
 * aula sin niveles, el de la configuración (lo de siempre).
 *
 *   - `subscriptions.membership.activated` (compra o recovery) → assignMembers
 *     con `source=MEMBERSHIP`.
 *   - `subscriptions.subscription.activated` con planId (recovery de impago) →
 *     assignMembers (idempotente: ALREADY_MEMBER si ya está).
 *   - `subscriptions.subscription.canceled` (immediate) con planId → revoke.
 *   - `subscriptions.subscription.unpaid` con planId → revoke (refcount-safe:
 *     unenrolls solo lo que concedió el grupo).
 *   - `subscriptions.subscription.paused` con planId → revoke: empieza una pausa
 *     aceptada al darse de baja (sin cobro, sin acceso). Al volver a cobrar,
 *     `subscription.activated` (recovery) la vuelve a conceder.
 *   - `subscriptions.membership.plan_changed` (cambio de nivel desde la cuenta)
 *     → concede el grupo del nivel nuevo y DESPUÉS retira el del viejo. En ese
 *     orden: los cursos que están en los dos no se pierden ni un momento (la
 *     retirada cuenta los grants vivos de cada curso antes de desmatricular).
 *
 * El grupo se resuelve con el plan ACTUAL de la suscripción (no con el del
 * evento): un aviso que llega tarde, después de un cambio de nivel, actúa
 * sobre el nivel que se paga hoy.
 *
 * Al terminar una membresía de pago (baja o impago), si el aula tiene NIVEL
 * GRATIS encendido, la persona pasa a él (su grupo, como un alta aprobada):
 * «pasar a gratis» es darse de baja.
 *
 * Este bridge solo crea/retira membresías `MEMBERSHIP` (patrón del bridge de
 * tiers): la revocación pasa `onlySource`, así el fin de una membresía de pago
 * nunca retira lo que un admin concedió a mano (MANUAL sticky) ni lo que
 * concedió el vínculo de tier.
 *
 * Los eventos POR CURSO (courseId, sin planId) los ignora — son del
 * SubscriptionsLearningBridge. Un fallo aquí se loguea y NO se propaga cuando
 * el grupo no está configurado (la suscripción cobrada nunca debe perderse por
 * config incompleta; el admin lo ve en logs y asigna a mano).
 */

interface MembershipEventPayload {
  subscriptionId: string;
  planId?: string | null;
  courseId?: string | null;
  userId: string;
  immediate?: boolean;
  recovery?: boolean;
}

interface PlanChangedPayload {
  subscriptionId: string;
  userId: string;
  fromPlanId: string | null;
  toPlanId: string;
}

/** Estados en los que la membresía da acceso (los mismos que lo conceden). */
const ACCESS_STATUSES = new Set(['TRIALING', 'ACTIVE', 'PAST_DUE']);

@Injectable()
export class MembershipAccessGroupsBridge implements OnModuleInit {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly factory: ModuleContextFactory,
    private readonly accessGroups: AccessGroupsService,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const eventBus = this.factory.getEventBus();

    eventBus.subscribe<MembershipEventPayload>(
      'subscriptions.membership.activated',
      async (event: DomainEvent<MembershipEventPayload>) => {
        await this.grant(event);
      },
    );
    eventBus.subscribe<MembershipEventPayload>(
      'subscriptions.subscription.activated',
      async (event: DomainEvent<MembershipEventPayload>) => {
        if (!event.data.planId) return; // sub por curso → learning bridge
        await this.grant(event);
      },
    );
    eventBus.subscribe<MembershipEventPayload>(
      'subscriptions.subscription.canceled',
      async (event: DomainEvent<MembershipEventPayload>) => {
        if (!event.data.planId) return;
        if (!event.data.immediate) return; // at-period-end: espera al deleted
        await this.revoke(event);
        await this.fallBackToFreeTier(event);
      },
    );
    eventBus.subscribe<MembershipEventPayload>(
      'subscriptions.subscription.unpaid',
      async (event: DomainEvent<MembershipEventPayload>) => {
        if (!event.data.planId) return;
        await this.revoke(event);
        await this.fallBackToFreeTier(event);
      },
    );
    eventBus.subscribe<MembershipEventPayload>(
      'subscriptions.subscription.paused',
      async (event: DomainEvent<MembershipEventPayload>) => {
        if (!event.data.planId) return;
        await this.revoke(event);
      },
    );
    eventBus.subscribe<PlanChangedPayload>(
      MEMBERSHIP_PLAN_CHANGED_EVENT,
      async (event: DomainEvent<PlanChangedPayload>) => {
        await this.swap(event);
      },
    );

    this.logger.log({}, 'MembershipAccessGroupsBridge: subscribed to membership events');
  }

  private async grant(event: DomainEvent<MembershipEventPayload>): Promise<void> {
    const tenantId = event.metadata.tenantId;
    const { userId, subscriptionId } = event.data;
    const groupId = await this.groupFor(tenantId, subscriptionId, event.data.planId ?? null);
    if (!groupId) {
      this.logger.error(
        { tenantId, userId, subscriptionId },
        'MembershipAccessGroupsBridge: membresía activada SIN grupo configurado — asignar a mano en /admin/membership',
      );
      return;
    }
    try {
      const result = await this.accessGroups.assignMembers(
        tenantId,
        groupId,
        [userId],
        'MEMBERSHIP',
      );
      this.logger.log(
        { tenantId, userId, groupId, subscriptionId, added: result.added },
        'MembershipAccessGroupsBridge: grupo concedido por membresía',
      );
    } catch (err) {
      this.logger.error(
        { tenantId, userId, groupId, subscriptionId, error: (err as Error).message },
        'MembershipAccessGroupsBridge: fallo al conceder el grupo',
      );
      throw err;
    }
  }

  private async revoke(event: DomainEvent<MembershipEventPayload>): Promise<void> {
    const tenantId = event.metadata.tenantId;
    const { userId, subscriptionId } = event.data;
    const groupId = await this.groupFor(tenantId, subscriptionId, event.data.planId ?? null);
    if (!groupId) {
      this.logger.warn(
        { tenantId, userId, subscriptionId },
        'MembershipAccessGroupsBridge: revocación sin grupo configurado — nada que revocar',
      );
      return;
    }
    await this.revokeGroup(tenantId, groupId, userId, subscriptionId);
  }

  /**
   * Cambio de nivel: concede el grupo del plan que se paga AHORA y retira el
   * del plan de antes, si es otro. Idempotente (conceder y retirar lo son): un
   * reintento del aviso deja lo mismo.
   */
  private async swap(event: DomainEvent<PlanChangedPayload>): Promise<void> {
    const tenantId = event.metadata.tenantId;
    const { userId, subscriptionId, fromPlanId, toPlanId } = event.data;
    const tiers = this.registry.getMembershipTiersService();
    const sub = await this.prisma.modSubscriptionsSubscription.findFirst({
      where: { id: subscriptionId, tenantId },
      select: { planId: true, status: true },
    });
    const target = await tiers.accessGroupForPlan(tenantId, sub?.planId ?? toPlanId);
    const previous = fromPlanId ? await tiers.accessGroupForPlan(tenantId, fromPlanId) : null;
    if (target && (!sub || ACCESS_STATUSES.has(sub.status))) {
      await this.accessGroups.assignMembers(tenantId, target, [userId], 'MEMBERSHIP');
    }
    if (previous && previous !== target) {
      await this.revokeGroup(tenantId, previous, userId, subscriptionId);
    }
    this.logger.log(
      { tenantId, userId, subscriptionId, from: previous, to: target },
      'MembershipAccessGroupsBridge: cambio de nivel — grupos cambiados',
    );
  }

  private async revokeGroup(
    tenantId: string,
    groupId: string,
    userId: string,
    subscriptionId: string,
  ): Promise<void> {
    try {
      // Solo membresías MEMBERSHIP: si el miembro es MANUAL (p.ej. anterior al
      // backfill conservador de F6, o promocionado por el admin) o TIER, la
      // revocación es no-op — ese acceso no lo concedió esta membresía.
      const result = await this.accessGroups.revokeMember(tenantId, groupId, userId, {
        onlySource: 'MEMBERSHIP',
      });
      this.logger.log(
        { tenantId, userId, groupId, subscriptionId, revoked: result.revoked },
        'MembershipAccessGroupsBridge: grupo revocado por fin de membresía',
      );
    } catch (err) {
      this.logger.error(
        { tenantId, userId, groupId, subscriptionId, error: (err as Error).message },
        'MembershipAccessGroupsBridge: fallo al revocar el grupo',
      );
      throw err;
    }
  }

  /**
   * Fin de una membresía de pago con nivel gratis encendido: la persona se
   * queda en el gratis (como si la hubieran aprobado en el registro gratis,
   * `MANUAL`). Si ya volvió a pagar mientras tanto, no se hace nada.
   */
  private async fallBackToFreeTier(event: DomainEvent<MembershipEventPayload>): Promise<void> {
    const tenantId = event.metadata.tenantId;
    const { userId, subscriptionId } = event.data;
    const free = await this.registry.getMembershipTiersService().findFreeTier(tenantId);
    if (!free?.active || !free.accessGroupId) return;
    const stillPaying = await this.prisma.modSubscriptionsSubscription.findFirst({
      where: {
        tenantId,
        userId,
        planId: { not: null },
        status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED'] },
      },
      select: { id: true },
    });
    if (stillPaying) return;
    try {
      await this.accessGroups.assignMembers(tenantId, free.accessGroupId, [userId], 'MANUAL');
      this.logger.log(
        { tenantId, userId, subscriptionId, groupId: free.accessGroupId },
        'MembershipAccessGroupsBridge: fin de la membresía de pago — pasa al nivel gratis',
      );
    } catch (err) {
      // El nivel gratis es un extra: su fallo no debe impedir la retirada.
      this.logger.warn(
        { tenantId, userId, subscriptionId, error: (err as Error).message },
        'MembershipAccessGroupsBridge: no se pudo pasar al nivel gratis',
      );
    }
  }

  /** Grupo del plan que la suscripción paga HOY (o el del evento si no está). */
  private async groupFor(
    tenantId: string,
    subscriptionId: string,
    eventPlanId: string | null,
  ): Promise<string | null> {
    const sub = await this.prisma.modSubscriptionsSubscription.findFirst({
      where: { id: subscriptionId, tenantId },
      select: { planId: true },
    });
    return this.registry
      .getMembershipTiersService()
      .accessGroupForPlan(tenantId, sub?.planId ?? eventPlanId);
  }
}
