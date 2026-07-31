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
 * Puente entre mod.billing y mod.learning para los REEMBOLSOS: cuando se
 * devuelve íntegramente el importe de una compra, retira el acceso al curso.
 *
 * Antes de esto, devolver el dinero en Stripe no quitaba nada: el alumno
 * conservaba el curso para siempre.
 *
 * Solo cancela la matrícula de origen COMPRA. Si esa persona además es miembro
 * o tiene el curso por un grupo de acceso, ese acceso NO se toca: se le ha
 * devuelto su compra, no se le retira lo que ya tenía por otra vía.
 *
 * `billing.order.refunded` solo se emite en reembolsos TOTALES (uno parcial no
 * llega hasta aquí), y la operación es idempotente, así que una reentrega del
 * webhook no hace daño.
 */
interface BillingOrderRefundedPayload {
  orderId: string;
  productId: string;
  courseId: string;
  userId: string;
  amountRefunded?: number;
}

@Injectable()
export class BillingRefundBridge implements OnModuleInit {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
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

    const cancelled = await this.registry
      .getLearningService()
      .unenrollFromPurchase(tenantId, userId, courseId);

    this.logger.log(
      { tenantId, orderId, userId, courseId, cancelled },
      cancelled > 0
        ? 'BillingRefundBridge: acceso retirado tras el reembolso'
        : 'BillingRefundBridge: reembolso sin matrícula de compra viva (no-op)',
    );
  }
}
