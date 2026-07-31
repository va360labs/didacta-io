/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@didacta/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from '../module-context.factory';
import { AccessGroupsService } from './access-groups.service';

interface UserTierChangedPayload {
  userId: string;
  /** Nombre del tier EFECTIVO del usuario, o null si quedó sin tier. */
  tierName: string | null;
}

/**
 * Puente entre mod.payment-connections y mod.access-groups. Al cambiar el tier
 * efectivo de un usuario (`payment_connections.user_tier.changed`, emitido por
 * el sync de pagos o por una asignación manual), reconcilia su membresía en los
 * grupos vinculados a ese tier (`linkedTierName`): lo añade al grupo del tier
 * nuevo (→ matrícula en sus cursos) y lo retira de los grupos de tiers que ya no
 * le corresponden. Solo toca membresías de origen TIER; nunca las MANUAL.
 *
 * No cruza FKs entre tablas de módulos: solo IDs lógicos vía AccessGroupsService.
 */
@Injectable()
export class AccessGroupsTiersBridge implements OnModuleInit {
  constructor(
    private readonly factory: ModuleContextFactory,
    private readonly accessGroups: AccessGroupsService,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const eventBus = this.factory.getEventBus();
    eventBus.subscribe<UserTierChangedPayload>(
      'payment_connections.user_tier.changed',
      async (event: DomainEvent<UserTierChangedPayload>) => {
        const tenantId = event.metadata.tenantId;
        const { userId, tierName } = event.data;
        try {
          await this.accessGroups.reconcileTierMembership(tenantId, userId, tierName ?? null);
        } catch (err) {
          this.logger.error(
            { tenantId, userId, tierName, error: (err as Error).message },
            'AccessGroupsTiersBridge: fallo al reconciliar la membresía por tier',
          );
        }
      },
    );
    this.logger.log(
      {},
      'AccessGroupsTiersBridge: subscribed to payment_connections.user_tier.changed',
    );
  }
}
