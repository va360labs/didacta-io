/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type {
  PayoutsAccountView,
  PayoutsAccountsService,
  PayoutsDbPort,
  PayoutsLogger,
} from './accounts.service.js';
import { PlatformStripeApiError } from './errors.js';
import type { PlatformStripeClient } from './stripe/platform-stripe.client.js';

/**
 * Desconexión de cobros y baja del creador (etapa E6).
 *
 * Lo mismo en los dos casos («Desconectar cobros» desde el panel, o el aula
 * archivada desde el plano de control):
 *
 *  1. La cuenta pasa a `DISCONNECTED`: el resolutor de modo de cobro deja de
 *     dar `ready` y el checkout responde 409 `PAYOUTS_NOT_READY`.
 *  2. Las suscripciones vivas del aula en la cuenta del operador pasan a
 *     `cancel_at_period_end`: nadie pierde lo que ya pagó, y nadie vuelve a
 *     pagar. Se toman del registro (`mod_payouts_object_ref`, clase
 *     `subscription`), que es donde el host anota las que crea en modo
 *     plataforma (E5); el módulo de suscripciones se entera por su
 *     `customer.subscription.updated` de siempre.
 *  3. La cuenta de Stripe NO se cierra: hacen falta 120 días para revertir
 *     disputas, lo pendiente de transferir se sigue transfiriendo y las
 *     deudas se siguen cobrando. El cierre es manual, pasado el plazo y con
 *     saldo y deuda a cero.
 */

export interface DisconnectResult {
  readonly account: PayoutsAccountView | null;
  readonly changed: boolean;
  /** Suscripciones que se han dejado para cancelar a final de periodo. */
  readonly subscriptionsScheduled: number;
  /** Suscripciones que no se pudieron tocar (se registran para revisión). */
  readonly subscriptionsFailed: number;
}

interface SubscriptionFromApi {
  readonly id: string;
  readonly status?: string;
  readonly cancel_at_period_end?: boolean;
}

/** Estados de Stripe en los que una suscripción aún cobraría. */
const LIVE_SUBSCRIPTION_STATUSES = new Set([
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'incomplete',
]);
const SILENT_LOGGER: PayoutsLogger = { warn: () => undefined };

export class PayoutsOffboardingService {
  private readonly logger: PayoutsLogger;

  constructor(
    private readonly db: PayoutsDbPort,
    private readonly stripe: PlatformStripeClient,
    private readonly accounts: Pick<PayoutsAccountsService, 'disconnect'>,
    options: { readonly logger?: PayoutsLogger } = {},
  ) {
    this.logger = options.logger ?? SILENT_LOGGER;
  }

  async disconnect(
    tenantId: string,
    context: { readonly reason: 'creator' | 'tenant_archived' },
  ): Promise<DisconnectResult> {
    const { account, changed } = await this.accounts.disconnect(tenantId);
    const subscriptions = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsObjectRef.findMany({
        where: { tenantId, kind: 'subscription' },
        select: { stripeObjectId: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    let scheduled = 0;
    let failed = 0;
    for (const { stripeObjectId } of subscriptions) {
      try {
        const sub = await this.stripe.v1<SubscriptionFromApi>(
          'GET',
          `/v1/subscriptions/${encodeURIComponent(stripeObjectId)}`,
        );
        if (
          !LIVE_SUBSCRIPTION_STATUSES.has(sub.status ?? '') ||
          sub.cancel_at_period_end === true
        ) {
          continue;
        }
        await this.stripe.v1(
          'POST',
          `/v1/subscriptions/${encodeURIComponent(stripeObjectId)}`,
          {
            cancel_at_period_end: true,
            metadata: { didacta_cancel_reason: `payouts_${context.reason}` },
          },
          { idempotencyKey: `payouts:offboarding:${stripeObjectId}` },
        );
        scheduled += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn(
          {
            tenantId,
            subscriptionId: stripeObjectId,
            err: err instanceof PlatformStripeApiError ? (err.detail ?? err.message) : String(err),
          },
          'payouts.offboarding: no se pudo dejar la suscripción para cancelar a final de periodo',
        );
      }
    }
    this.logger.log?.(
      { tenantId, reason: context.reason, changed, scheduled, failed },
      'payouts.offboarding: cobros desconectados',
    );
    return { account, changed, subscriptionsScheduled: scheduled, subscriptionsFailed: failed };
  }
}
