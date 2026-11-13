/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@didacta/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from '../module-context.factory';
import { ModuleRegistryService } from '../module-registry.service';
import { ReferralsCreditFailedError } from '@didacta/mod-referrals';

/**
 * Puente mod.subscriptions → mod.referrals (composición en el host: el emisor
 * no importa al receptor).
 *
 *   - `subscriptions.membership.activated` con `attribution.referralCode` →
 *     `ReferralsService.attribute` (idempotente, anti-auto-referido).
 *   - `subscriptions.invoice.paid` → `ReferralsService.accrueCommission`
 *     (solo devenga si la sub está atribuida y el cobro entra en el ámbito).
 *
 * TODO es best-effort: un fallo del programa de referidos JAMÁS afecta al
 * fulfillment de la membresía ni a la facturación — se loguea y sigue.
 */

interface MembershipActivatedPayload {
  subscriptionId: string;
  planId?: string | null;
  userId: string;
  userCreated?: boolean;
  stripeSubscriptionId?: string;
  attribution?: { referralCode?: string } | null;
}

interface InvoicePaidPayload {
  subscriptionId: string;
  stripeInvoiceId: string;
  amount: number;
  currency: string;
}

interface SubscriptionCanceledPayload {
  subscriptionId: string;
  planId?: string | null;
  userId: string;
}

interface InvoicePartiallyRefundedPayload {
  subscriptionId: string;
  stripeInvoiceId: string;
  amountRefunded: number;
  amountTotal: number;
}

interface InvoiceRefundedPayload {
  subscriptionId: string;
  stripeInvoiceId: string;
  amountRefunded: number;
  currency: string;
}

@Injectable()
export class ReferralsSubscriptionsBridge implements OnModuleInit {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const eventBus = this.factory.getEventBus();

    eventBus.subscribe<MembershipActivatedPayload>(
      'subscriptions.membership.activated',
      async (event: DomainEvent<MembershipActivatedPayload>) => {
        await this.onMembershipActivated(event);
      },
    );
    eventBus.subscribe<InvoicePaidPayload>(
      'subscriptions.invoice.paid',
      async (event: DomainEvent<InvoicePaidPayload>) => {
        await this.onInvoicePaid(event);
      },
    );
    eventBus.subscribe<SubscriptionCanceledPayload>(
      'subscriptions.subscription.canceled',
      async (event: DomainEvent<SubscriptionCanceledPayload>) => {
        await this.onSubscriptionCanceled(event);
      },
    );
    eventBus.subscribe<InvoicePartiallyRefundedPayload>(
      'subscriptions.invoice.partially_refunded',
      async (event: DomainEvent<InvoicePartiallyRefundedPayload>) => {
        const tenantId = event.metadata.tenantId;
        try {
          await this.registry
            .getReferralsService()
            .applyRefund(
              tenantId,
              event.data.stripeInvoiceId,
              { refundedCents: event.data.amountRefunded, totalCents: event.data.amountTotal },
              'Devolución parcial del cobro en Stripe',
            );
        } catch (err) {
          this.logger.error(
            { tenantId, err: err instanceof Error ? err.message : String(err) },
            'referrals: fallo al recortar la comisión de una devolución parcial',
          );
        }
      },
    );
    eventBus.subscribe<InvoiceRefundedPayload>(
      'subscriptions.invoice.refunded',
      async (event: DomainEvent<InvoiceRefundedPayload>) => {
        await this.onInvoiceRefunded(event);
      },
    );

    this.logger.log({}, 'ReferralsSubscriptionsBridge: subscribed to subscriptions events');
  }

  private async onMembershipActivated(
    event: DomainEvent<MembershipActivatedPayload>,
  ): Promise<void> {
    const referralCode = event.data.attribution?.referralCode?.trim();
    if (!referralCode) return; // alta sin atribución — el caso normal
    const tenantId = event.metadata.tenantId;
    try {
      const result = await this.registry.getReferralsService().attribute({
        tenantId,
        referralCode: referralCode.toLowerCase(),
        referredUserId: event.data.userId,
        stripeSubscriptionId:
          event.data.stripeSubscriptionId ?? `local:${event.data.subscriptionId}`,
        subscriptionId: event.data.subscriptionId,
        planId: event.data.planId ?? null,
      });
      if (result.attributed) {
        this.logger.log(
          {
            tenantId,
            referralId: result.referralId,
            referrerUserId: result.referrerUserId,
            alreadyExisted: result.alreadyExisted,
          },
          'referrals: alta atribuida',
        );
      } else {
        // Auto-referidos y códigos inválidos quedan auditados en logs (AC de
        // UC-R202): no son errores, son atribuciones legítimamente denegadas.
        this.logger.warn(
          { tenantId, userId: event.data.userId, referralCode, reason: result.reason },
          'referrals: alta SIN atribuir',
        );
      }
    } catch (err) {
      this.logger.error(
        { tenantId, err: err instanceof Error ? err.message : String(err) },
        'referrals: fallo al atribuir (la membresía NO se ve afectada)',
      );
    }
  }

  /**
   * Baja de la membresía: el descuento de referidos sin usar vuelve a la
   * cartera del alumno. Best-effort: la baja jamás falla por esto.
   */
  private async onSubscriptionCanceled(
    event: DomainEvent<SubscriptionCanceledPayload>,
  ): Promise<void> {
    if (!event.data.planId) return; // suscripción a un curso, no la membresía
    const tenantId = event.metadata.tenantId;
    try {
      const result = await this.registry.getReferralsService().returnUnusedCredit(tenantId, {
        userId: event.data.userId,
        subscriptionId: event.data.subscriptionId,
      });
      if (result.returned) {
        this.logger.log(
          { tenantId, payoutId: result.payoutId, amountCents: result.amountCents },
          'referrals: saldo de descuento sin usar devuelto a la cartera',
        );
      }
    } catch (err) {
      this.logger.error(
        { tenantId, err: err instanceof Error ? err.message : String(err) },
        'referrals: fallo al devolver el saldo sin usar',
      );
      // Stripe no confirmó la retirada: la liquidación queda PENDING y el
      // reintento del evento repite la MISMA llamada (misma clave).
      if (err instanceof ReferralsCreditFailedError) throw err;
    }
  }

  private async onInvoiceRefunded(event: DomainEvent<InvoiceRefundedPayload>): Promise<void> {
    const tenantId = event.metadata.tenantId;
    try {
      const result = await this.registry
        .getReferralsService()
        .revokeCommissionByInvoice(
          tenantId,
          event.data.stripeInvoiceId,
          'Reembolso del cobro en Stripe',
        );
      if (result.revoked) {
        this.logger.log(
          {
            tenantId,
            commissionId: result.commissionId,
            stripeInvoiceId: event.data.stripeInvoiceId,
          },
          'referrals: comisión revocada por reembolso',
        );
      } else if (result.reason === 'already_paid') {
        // Ya cobrada: queda un ajuste negativo que se descuenta de lo siguiente.
        this.logger.log(
          {
            tenantId,
            stripeInvoiceId: event.data.stripeInvoiceId,
            adjustmentId: result.adjustmentId,
          },
          'referrals: reembolso con la comisión ya cobrada: ajuste por devolución',
        );
      }
    } catch (err) {
      this.logger.error(
        { tenantId, err: err instanceof Error ? err.message : String(err) },
        'referrals: fallo al revocar por reembolso',
      );
    }
  }

  private async onInvoicePaid(event: DomainEvent<InvoicePaidPayload>): Promise<void> {
    const tenantId = event.metadata.tenantId;
    try {
      const result = await this.registry.getReferralsService().accrueCommission({
        tenantId,
        subscriptionId: event.data.subscriptionId,
        stripeInvoiceId: event.data.stripeInvoiceId,
        amountCents: event.data.amount,
        currency: event.data.currency,
      });
      if (result.accrued) {
        this.logger.log(
          {
            tenantId,
            commissionId: result.commissionId,
            amountCents: result.amountCents,
            alreadyExisted: result.alreadyExisted,
          },
          'referrals: comisión devengada',
        );
      } else if (result.reason !== 'not_attributed') {
        // 'not_attributed' es el caso masivo (cobros sin referido) — silencioso.
        this.logger.log(
          { tenantId, subscriptionId: event.data.subscriptionId, reason: result.reason },
          'referrals: cobro sin devengo',
        );
      }
    } catch (err) {
      this.logger.error(
        { tenantId, err: err instanceof Error ? err.message : String(err) },
        'referrals: fallo al devengar (la facturación NO se ve afectada)',
      );
    }
  }
}
