/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent, NotificationValue } from '@didacta/core-kernel';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ModuleContextFactory } from '../module-context.factory';

/**
 * Puente mod.referrals → NotificationHub: avisa al referidor cuando gana una
 * comisión y cuando el admin registra su liquidación (in-app + email, con las
 * plantillas `referrals.commission.earned` / `referrals.payout.recorded` del
 * catálogo — personalizables en /admin/emails y sujetas a las preferencias
 * del usuario, categoría SYSTEM).
 *
 * Best-effort: un fallo del hub jamás afecta al devengo ni a la liquidación.
 */

interface CommissionCreatedPayload {
  commissionId: string;
  referralId: string;
  referrerUserId: string;
  amountCents: number;
  baseAmountCents?: number;
  currency: string;
  sourceInvoiceId: string;
}

interface PayoutRecordedPayload {
  payoutId: string;
  referrerUserId: string;
  totalCents: number;
  currency: string;
  commissionCount: number;
  externalReference?: string;
}

/**
 * Importe SIN formatear: viaja como descriptor y lo formatea el hub, que es
 * quien conoce el idioma del referente. Aquí estaba cableado
 * `Intl.NumberFormat('es-ES')`, así que un referente con `locale = en-US` leía
 * «You earned a commission of 1.234,50 €!» — separadores y posición del
 * símbolo en español dentro de una frase inglesa.
 */
function moneyValue(cents: number, currency: string): NotificationValue {
  return { hubValue: 'money', cents, currency };
}

@Injectable()
export class ReferralsNotificationsBridge implements OnModuleInit {
  constructor(
    private readonly factory: ModuleContextFactory,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const eventBus = this.factory.getEventBus();

    eventBus.subscribe<CommissionCreatedPayload>(
      'referrals.commission.created',
      async (event: DomainEvent<CommissionCreatedPayload>) => {
        await this.notify(event.metadata.tenantId, event.data.referrerUserId, {
          templateKey: 'referrals.commission.earned',
          variables: {
            amount: moneyValue(event.data.amountCents, event.data.currency),
            baseAmount:
              event.data.baseAmountCents !== undefined
                ? moneyValue(event.data.baseAmountCents, event.data.currency)
                : '',
          },
        });
      },
    );
    eventBus.subscribe<PayoutRecordedPayload>(
      'referrals.payout.recorded',
      async (event: DomainEvent<PayoutRecordedPayload>) => {
        await this.notify(event.metadata.tenantId, event.data.referrerUserId, {
          templateKey: 'referrals.payout.recorded',
          variables: {
            amount: moneyValue(event.data.totalCents, event.data.currency),
            reference: event.data.externalReference ?? '',
          },
        });
      },
    );

    this.logger.log({}, 'ReferralsNotificationsBridge: subscribed to referrals events');
  }

  private async notify(
    tenantId: string,
    userId: string,
    args: { templateKey: string; variables: Record<string, unknown> },
  ): Promise<void> {
    const hub = this.factory.getNotificationHub();
    for (const channel of ['in-app', 'email'] as const) {
      try {
        await hub.send({
          tenantId,
          channel,
          templateKey: args.templateKey,
          to: userId,
          variables: args.variables,
          category: 'SYSTEM',
        });
      } catch (err) {
        this.logger.warn(
          {
            tenantId,
            userId,
            templateKey: args.templateKey,
            channel,
            err: err instanceof Error ? err.message : String(err),
          },
          'referrals: fallo al notificar (el devengo/liquidación NO se ve afectado)',
        );
      }
    }
  }
}
