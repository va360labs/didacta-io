/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { DomainEvent } from '@didacta/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AccessGroupsService } from '../access-groups/access-groups.service';
import { ModuleContextFactory } from '../module-context.factory';
import { ModuleRegistryService } from '../module-registry.service';
import { withdrawRefundedPurchaseAccess, type RefundAccessDeps } from './refund-access';

/**
 * Puente entre mod.billing y mod.learning para los REEMBOLSOS: cuando se
 * devuelve íntegramente el importe de una compra, retira el acceso al curso.
 *
 * Antes de esto, devolver el dinero en Stripe no quitaba nada: el alumno
 * conservaba el curso para siempre.
 *
 * El criterio vive en `withdrawRefundedPurchaseAccess` (`refund-access.ts`):
 * otra compra viva del curso o un grupo que lo sigue dando mantienen el acceso;
 * si no, se cancela la matrícula de compra —también COMPLETED— y se revocan sus
 * certificados. Lo usa igual el script de corrección de reembolsos antiguos.
 *
 * `billing.order.refunded` solo se emite en reembolsos TOTALES (uno parcial no
 * llega hasta aquí), y la operación es idempotente, así que una reentrega del
 * webhook no hace daño.
 */
interface BillingOrderRefundedPayload {
  orderId: string;
  productId: string;
  courseId: string;
  userId: string | null;
  amountRefunded?: number;
}

@Injectable()
export class BillingRefundBridge implements OnModuleInit {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    const eventBus = this.factory.getEventBus();
    eventBus.subscribe<BillingOrderRefundedPayload>(
      'billing.order.refunded',
      async (event: DomainEvent<BillingOrderRefundedPayload>) => {
        await this.revoke(event);
      },
    );
    this.logger.log({}, 'BillingRefundBridge: subscribed to billing.order.refunded');
  }

  async revoke(event: DomainEvent<BillingOrderRefundedPayload>): Promise<void> {
    const { courseId, userId, orderId } = event.data;
    const tenantId = event.metadata.tenantId;

    const result = await withdrawRefundedPurchaseAccess(this.deps(), {
      tenantId,
      orderId,
      userId: userId ?? null,
      courseId,
    });

    this.logger.log(
      { tenantId, orderId, userId, courseId, ...result },
      result.outcome === 'withdrawn'
        ? 'BillingRefundBridge: acceso retirado tras el reembolso'
        : `BillingRefundBridge: reembolso sin acceso que retirar (${result.outcome})`,
    );
  }

  /** Los servicios reales. Los grupos, perezosos: importarlos aquí cerraría un ciclo de módulos. */
  deps(): RefundAccessDeps {
    const groups = this.moduleRef.get(AccessGroupsService, { strict: false });
    return {
      billing: this.registry.getBillingService(),
      learning: this.registry.getLearningService(),
      certificates: this.registry.getCertificatesService(),
      groups,
    };
  }
}
