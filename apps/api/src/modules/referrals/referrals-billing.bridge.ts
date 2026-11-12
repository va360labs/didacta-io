/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@didacta/core-kernel';
import { purchaseInvoiceRef } from '@didacta/mod-referrals';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from '../module-context.factory';
import { ModuleRegistryService } from '../module-registry.service';

/**
 * Puente mod.billing → mod.referrals (composición en el host: el emisor no
 * importa al receptor). Referidos para TODO lo que se vende, no solo la
 * membresía:
 *
 *   - `billing.order.completed` con `attribution.referralCode` (el `?ref=` con
 *     el que llegó el comprador a la página de venta) →
 *     `ReferralsService.recordPurchase`: atribuye (first-touch, sin
 *     autorreferidos) y devenga la comisión PENDING sobre lo cobrado.
 *   - `billing.order.refunded` (reembolso TOTAL, o un pago diferido que falla
 *     tras completarse) → `revokeCommissionByInvoice` con la referencia de la
 *     orden. Una comisión ya PAGADA no se toca (clawback manual, igual que en
 *     la membresía).
 *
 * Vale igual con Stripe propio y con cobros de plataforma: en los dos casos
 * el evento lo emite el mismo fulfillment de mod.billing.
 *
 * TODO es best-effort: un fallo del programa de referidos JAMÁS afecta a la
 * compra ni a la matrícula — se loguea y sigue.
 */

export interface BillingOrderCompletedPayload {
  orderId: string;
  userId: string | null;
  amountPaid: number | null;
  currency: string;
  attribution?: { referralCode?: string } | null;
}

export interface BillingOrderRefundedPayload {
  orderId: string;
}

@Injectable()
export class ReferralsBillingBridge implements OnModuleInit {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const eventBus = this.factory.getEventBus();
    eventBus.subscribe<BillingOrderCompletedPayload>(
      'billing.order.completed',
      async (event: DomainEvent<BillingOrderCompletedPayload>) => {
        await this.onOrderCompleted(event);
      },
    );
    eventBus.subscribe<BillingOrderRefundedPayload>(
      'billing.order.refunded',
      async (event: DomainEvent<BillingOrderRefundedPayload>) => {
        await this.onOrderRefunded(event);
      },
    );
    this.logger.log({}, 'ReferralsBillingBridge: subscribed to billing order events');
  }

  async onOrderCompleted(event: DomainEvent<BillingOrderCompletedPayload>): Promise<void> {
    const referralCode = event.data.attribution?.referralCode?.trim();
    if (!referralCode) return; // compra sin enlace — el caso normal
    const tenantId = event.metadata.tenantId;
    const { orderId, userId, amountPaid, currency } = event.data;
    if (!userId || !amountPaid || amountPaid <= 0) return;
    try {
      const result = await this.registry.getReferralsService().recordPurchase({
        tenantId,
        referralCode: referralCode.toLowerCase(),
        buyerUserId: userId,
        orderId,
        amountCents: amountPaid,
        currency,
      });
      if (result.accrued) {
        this.logger.log(
          {
            tenantId,
            orderId,
            commissionId: result.commissionId,
            amountCents: result.amountCents,
            alreadyExisted: result.alreadyExisted,
          },
          'referrals: comisión devengada por una compra',
        );
      } else {
        this.logger.log(
          { tenantId, orderId, reason: result.reason },
          'referrals: compra con enlace sin comisión',
        );
      }
    } catch (err) {
      this.logger.error(
        { tenantId, orderId, err: err instanceof Error ? err.message : String(err) },
        'referrals: fallo al devengar una compra (la compra NO se ve afectada)',
      );
    }
  }

  async onOrderRefunded(event: DomainEvent<BillingOrderRefundedPayload>): Promise<void> {
    const tenantId = event.metadata.tenantId;
    const { orderId } = event.data;
    try {
      const result = await this.registry
        .getReferralsService()
        .revokeCommissionByInvoice(
          tenantId,
          purchaseInvoiceRef(orderId),
          'Reembolso de la compra en Stripe',
        );
      if (result.revoked) {
        this.logger.log(
          { tenantId, orderId, commissionId: result.commissionId },
          'referrals: comisión anulada por reembolso de la compra',
        );
      } else if (result.reason === 'already_paid') {
        this.logger.warn(
          { tenantId, orderId },
          'referrals: reembolso de una compra cuya comisión YA se pagó (clawback manual)',
        );
      }
    } catch (err) {
      this.logger.error(
        { tenantId, orderId, err: err instanceof Error ? err.message : String(err) },
        'referrals: fallo al anular la comisión de una compra reembolsada',
      );
    }
  }
}
