/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PayoutsDbPort } from '../accounts.service.js';
import { PayoutsSaleUnrecordableError } from '../errors.js';
import { idOf } from '../event-router.js';
import { RefsService, type RegisterObjectRefInput } from '../refs.service.js';
import type { PlatformStripeClient, StripeObject } from '../stripe/platform-stripe.client.js';

/**
 * Compra de un curso cobrada por la plataforma: de la sesión de checkout
 * completada a la VENTA en `mod_payouts_sale` (etapa E3).
 *
 * La venta nace en `AWAITING_FEE`: cobrada, sin reparto. El reparto necesita la
 * comisión REAL de Stripe (`balance_transaction.fee`), que llega segundos u
 * horas después del cobro; lo calcula la liquidación (E4) releyendo el cargo.
 *
 * Reglas:
 *  - Los importes se LEEN DE LA API (`GET /v1/checkout/sessions/{id}` con el
 *    PaymentIntent y su cargo expandidos), nunca del evento.
 *  - Sin cobro confirmado no hay venta: `payment_status` distinto de `paid`
 *    (pago diferido —SEPA, transferencia— que aún no ha llegado) o un cargo
 *    que no está `succeeded`. La venta se crea con `async_payment_succeeded`.
 *  - Una venta por cargo (`stripe_charge_id` único): reentregas, eventos
 *    distintos de la misma sesión y entregas simultáneas dejan UNA fila.
 *  - La cuenta conectada es la del `on_behalf_of` del cargo, y tiene que ser
 *    de este tenant. Si no, no se anota (lo recoge el conciliador) — nunca se
 *    atribuye el dinero a una cuenta que el registro no respalda.
 *  - Antes de la venta se registran los hijos de la sesión (`pi_…`, `ch_…`,
 *    `cus_…`) a nombre del tenant: los eventos posteriores del cargo
 *    (`charge.updated`, reembolsos, disputas) se atribuyen por ellos.
 */

export interface CheckoutSaleInput {
  readonly tenantId: string;
  /** `cs_…` ya atribuido al tenant por el registro. */
  readonly sessionId: string;
  /** Orden local de mod.billing, la del REGISTRO de la sesión (no la de la metadata). */
  readonly orderId: string;
}

export type CheckoutSaleOutcome =
  /** Venta anotada ahora. */
  | { readonly outcome: 'created'; readonly saleId: string; readonly chargeId: string }
  /** Ya estaba anotada (reentrega, otro evento de la misma sesión). */
  | { readonly outcome: 'exists'; readonly saleId: string; readonly chargeId: string }
  /** Sin dinero confirmado todavía (pago diferido) o sin importe. */
  | { readonly outcome: 'not_paid' }
  /** No es un pago único (una suscripción: E5). */
  | { readonly outcome: 'not_a_payment' };

interface SessionFromApi {
  readonly id: string;
  readonly mode?: string;
  readonly payment_status?: string;
  readonly livemode?: boolean;
  readonly customer?: unknown;
  readonly customer_details?: { readonly email?: string | null } | null;
  readonly payment_intent?: unknown;
  readonly line_items?: { readonly data?: ReadonlyArray<{ readonly description?: string | null }> };
}

interface ChargeFromApi {
  readonly id: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly status?: string;
  readonly paid?: boolean;
  readonly created?: number;
  readonly on_behalf_of?: unknown;
  readonly customer?: unknown;
}

export async function recordCheckoutSale(
  deps: { readonly db: PayoutsDbPort; readonly stripe: PlatformStripeClient },
  input: CheckoutSaleInput,
): Promise<CheckoutSaleOutcome> {
  const session = await deps.stripe.v1<SessionFromApi>(
    'GET',
    `/v1/checkout/sessions/${encodeURIComponent(input.sessionId)}`,
    { expand: ['payment_intent.latest_charge', 'line_items'] },
  );
  if (session.mode !== 'payment') return { outcome: 'not_a_payment' };
  if (session.payment_status !== 'paid') return { outcome: 'not_paid' };

  const intent = session.payment_intent;
  const intentId = idOf(intent);
  if (!intentId || typeof intent !== 'object' || intent === null) {
    throw new PayoutsSaleUnrecordableError(
      `la sesión ${session.id} está pagada y no trae PaymentIntent`,
    );
  }
  const intentObject = intent as StripeObject;
  let charge = intentObject['latest_charge'] as ChargeFromApi | string | null | undefined;
  if (typeof charge === 'string') {
    charge = await deps.stripe.v1<ChargeFromApi>(
      'GET',
      `/v1/charges/${encodeURIComponent(charge)}`,
    );
  }
  if (!charge || typeof charge !== 'object' || !idOf(charge.id)) {
    throw new PayoutsSaleUnrecordableError(
      `el PaymentIntent ${intentId} está pagado y no trae cargo`,
    );
  }
  if (charge.status !== 'succeeded' || charge.paid !== true) return { outcome: 'not_paid' };
  if (!Number.isInteger(charge.amount) || (charge.amount ?? 0) <= 0 || !charge.currency) {
    return { outcome: 'not_paid' };
  }

  const onBehalfOf = idOf(charge.on_behalf_of) ?? idOf(intentObject['on_behalf_of']);
  if (!onBehalfOf) {
    throw new PayoutsSaleUnrecordableError(`el cargo ${charge.id} no lleva on_behalf_of`);
  }
  const livemode = session.livemode === true;
  const customerId = idOf(session.customer) ?? idOf(charge.customer);

  // 1) Hijos de la sesión, a nombre del tenant. Transacción aparte de la venta:
  //    si la venta no se puede anotar, los hijos siguen sirviendo para
  //    atribuir los eventos del cargo.
  const children: RegisterObjectRefInput[] = [
    {
      tenantId: input.tenantId,
      stripeObjectId: intentId,
      kind: 'payment_intent',
      source: 'billing',
      localRef: input.orderId,
      parentObjectId: session.id,
      livemode,
    },
    {
      tenantId: input.tenantId,
      stripeObjectId: charge.id,
      kind: 'charge',
      source: 'billing',
      localRef: input.orderId,
      parentObjectId: intentId,
      livemode,
    },
    ...(customerId
      ? [
          {
            tenantId: input.tenantId,
            stripeObjectId: customerId,
            kind: 'customer' as const,
            source: 'billing' as const,
            localRef: input.orderId,
            parentObjectId: session.id,
            livemode,
          },
        ]
      : []),
  ];
  await deps.db.inTenant(input.tenantId, (tx) =>
    new RefsService(tx as never).registerMany(children),
  );

  // 2) La venta.
  const chargeId = charge.id;
  const amount = charge.amount!;
  const currency = charge.currency.toLowerCase();
  const chargedAt = Number.isInteger(charge.created)
    ? new Date(charge.created! * 1000)
    : new Date();
  return deps.db.inTenant(input.tenantId, async (tx) => {
    const account = await tx.modPayoutsAccount.findFirst({
      where: { tenantId: input.tenantId, stripeAccountId: onBehalfOf },
      select: { id: true },
    });
    if (!account) {
      throw new PayoutsSaleUnrecordableError(
        `el cargo ${chargeId} es en nombre de ${onBehalfOf}, que no es una cuenta de este tenant`,
      );
    }
    const { count } = await tx.modPayoutsSale.createMany({
      data: [
        {
          tenantId: input.tenantId,
          accountId: account.id,
          sourceKind: 'ORDER',
          sourceRef: input.orderId,
          description: session.line_items?.data?.[0]?.description?.slice(0, 500) ?? null,
          buyerEmail: session.customer_details?.email ?? null,
          stripeChargeId: chargeId,
          stripePaymentIntentId: intentId,
          presentmentAmount: amount,
          presentmentCurrency: currency,
          status: 'AWAITING_FEE',
          chargedAt,
        },
      ],
      skipDuplicates: true,
    });
    const sale = await tx.modPayoutsSale.findUnique({
      where: { stripeChargeId: chargeId },
      select: { id: true, tenantId: true, sourceRef: true },
    });
    if (!sale || sale.tenantId !== input.tenantId || sale.sourceRef !== input.orderId) {
      // La venta de este cargo existe y no es de esta orden (o no se ve: es de
      // otro tenant). No puede pasar con el registro como única fuente; si
      // pasa, que no se tape.
      throw new PayoutsSaleUnrecordableError(`el cargo ${chargeId} ya figura en otra venta`);
    }
    return { outcome: count === 1 ? 'created' : 'exists', saleId: sale.id, chargeId } as const;
  });
}
