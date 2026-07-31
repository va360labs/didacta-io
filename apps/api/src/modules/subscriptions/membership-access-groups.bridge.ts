/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@didacta/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AccessGroupsService } from '../access-groups/access-groups.service';
import { ModuleContextFactory } from '../module-context.factory';
import { ModuleRegistryService } from '../module-registry.service';

/**
 * Puente membresía → mod.access-groups. El entitlement de la membresía es un
 * GRUPO de acceso (config del admin, típicamente el grupo ALL_COURSES de la membresía):
 *
 *   - `subscriptions.membership.activated` (compra o recovery) → assignMembers.
 *   - `subscriptions.subscription.activated` con planId (recovery de impago) →
 *     assignMembers (idempotente: ALREADY_MEMBER si ya está).
 *   - `subscriptions.subscription.canceled` (immediate) con planId → revoke.
 *   - `subscriptions.subscription.unpaid` con planId → revoke (refcount-safe:
 *     unenrolls solo lo que concedió el grupo).
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

@Injectable()
export class MembershipAccessGroupsBridge implements OnModuleInit {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly factory: ModuleContextFactory,
    private readonly accessGroups: AccessGroupsService,
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
      },
    );
    eventBus.subscribe<MembershipEventPayload>(
      'subscriptions.subscription.unpaid',
      async (event: DomainEvent<MembershipEventPayload>) => {
        if (!event.data.planId) return;
        await this.revoke(event);
      },
    );

    this.logger.log({}, 'MembershipAccessGroupsBridge: subscribed to membership events');
  }

  private async grant(event: DomainEvent<MembershipEventPayload>): Promise<void> {
    const tenantId = event.metadata.tenantId;
    const { userId, subscriptionId } = event.data;
    const groupId = await this.configuredGroupId(tenantId);
    if (!groupId) {
      this.logger.error(
        { tenantId, userId, subscriptionId },
        'MembershipAccessGroupsBridge: membresía activada SIN grupo configurado — asignar a mano en /admin/membresia',
      );
      return;
    }
    try {
      const result = await this.accessGroups.assignMembers(tenantId, groupId, [userId]);
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
    const groupId = await this.configuredGroupId(tenantId);
    if (!groupId) {
      this.logger.warn(
        { tenantId, userId, subscriptionId },
        'MembershipAccessGroupsBridge: revocación sin grupo configurado — nada que revocar',
      );
      return;
    }
    try {
      const result = await this.accessGroups.revokeMember(tenantId, groupId, userId);
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

  private async configuredGroupId(tenantId: string): Promise<string | null> {
    const config = await this.registry.getMembershipService().getConfig(tenantId);
    return config.accessGroupId ?? null;
  }
}
