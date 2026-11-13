/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PayoutsDbPort } from '../accounts.service.js';
import { PayoutsSaleUnrecordableError } from '../errors.js';
import { idOf, subscriptionIdFromInvoice } from '../event-router.js';
import { RefsService, type RegisterObjectRefInput } from '../refs.service.js';
import { findInvoicePayment } from '../stripe/invoice-shape.js';
import type { PlatformStripeClient } from '../stripe/platform-stripe.client.js';
import { SUBSCRIPTION_REF_SOURCES } from './subscription.js';

/**
 * Factura de una suscripción cobrada por la plataforma → VENTA
 * `SUBSCRIPTION_INVOICE` (etapa E5). Se liquida igual que la compra de un
 * curso: la venta nace `AWAITING_FEE` y la liquidación (E4) relee el cargo,
 * aplica la comisión real de Stripe y el % del operador y transfiere el resto
 * al creador.
 *
 * Una venta por factura cobrada: el alta, cada renovación, el fin de la prueba.
 *
 * Reglas:
 *  - Los importes se LEEN DE LA API (`GET /v1/invoices/{id}` con `payments`
 *    expandido, el cargo con su `balance_transaction`), nunca del evento.
 *  - Sin dinero no hay venta: una factura que no está `paid`, o de 0 € (el alta
 *    de una prueba gratis, un cupón del 100 %), no anota nada. El impago
 *    (`invoice.payment_failed`) tampoco mueve dinero: el acceso lo gobierna
 *    `mod.subscriptions`.
 *  - El cargo se localiza con el lector tolerante (`invoice-shape.ts`): tres
 *    formas según la versión de la API.
 *  - La suscripción tiene que estar registrada a nombre de ESTE tenant (la ata
 *    `registerSubscriptionChildren` a su sesión de checkout). La cuenta
 *    conectada es la del `on_behalf_of` del cargo y tiene que ser de este
 *    tenant. Si no, no se anota (lo recoge el conciliador) — nunca se atribuye
 *    dinero a una cuenta que el registro no respalda.
 *  - Una venta por cargo (`stripe_charge_id` único): reentregas y entregas
 *    simultáneas dejan UNA fila.
 *  - Antes de la venta se registran la factura, el PaymentIntent y el cargo a
 *    nombre del tenant: `charge.updated`, reembolsos y disputas de ese cargo se
 *    atribuyen por ellos.
 *  - Con Adaptive Pricing el alumno paga en SU moneda: va a `presentment_*`
 *    (de `charge.presentment_details`); `gross`/`currency` son la divisa de
 *    liquidación (`balance_transaction`).
 */

/** Alerta: una renovación cobrada para una cuenta que no puede recibir el dinero. */
export const PAYOUTS_RENEWAL_ON_BLOCKED_ACCOUNT_ALERT = 'payouts.renewal_on_blocked_account';

/**
 * Estados de la cuenta conectada en los que una renovación se cobra (la
 * suscripción sigue viva en la cuenta del operador) pero su venta se queda
 * retenida (`HELD`, `account_not_ready`) hasta que la cuenta vuelva a poder
 * recibir transferencias. Los mismos que retiene la liquidación.
 */
const ACCOUNT_STATUSES_THAT_HOLD_RENEWALS: ReadonlySet<string> = new Set([
  'RESTRICTED',
  'REJECTED',
]);

export function accountHoldsRenewals(status: string): boolean {
  return ACCOUNT_STATUSES_THAT_HOLD_RENEWALS.has(status);
}

export interface InvoiceSaleInput {
  readonly tenantId: string;
  /** `in_…` ya atribuido al tenant por el registro. */
  readonly invoiceId: string;
}

export type InvoiceSaleOutcome =
  /** Venta anotada ahora. `accountStatus`: estado de la cuenta conectada. */
  | {
      readonly outcome: 'created';
      readonly saleId: string;
      readonly chargeId: string;
      readonly accountStatus: string;
    }
  /** Ya estaba anotada (reentrega, otro evento de la misma factura). */
  | {
      readonly outcome: 'exists';
      readonly saleId: string;
      readonly chargeId: string;
      readonly accountStatus: string;
    }
  /** Factura pagada sin importe: el alta de una prueba gratis, un cupón del 100 %. */
  | { readonly outcome: 'no_charge' }
  /** Factura no pagada (abierta, impagada) o cargo no confirmado. */
  | { readonly outcome: 'not_paid' }
  /** Factura suelta (sin suscripción): no es de este flujo. */
  | { readonly outcome: 'not_a_subscription' };

interface InvoiceFromApi {
  readonly id: string;
  readonly status?: string;
  readonly amount_paid?: number;
  readonly currency?: string;
  /** Saldo del cliente antes y después de la factura (negativo = a su favor). */
  readonly starting_balance?: number | null;
  readonly ending_balance?: number | null;
  readonly livemode?: boolean;
  readonly customer_email?: string | null;
  readonly on_behalf_of?: unknown;
  readonly lines?: { readonly data?: ReadonlyArray<InvoiceLineFromApi> };
  readonly status_transitions?: { readonly paid_at?: number | null } | null;
  readonly [key: string]: unknown;
}

interface InvoiceLineFromApi {
  readonly description?: string | null;
  /** Desde `basil`: el precio y el producto de la línea. */
  readonly pricing?: { readonly price_details?: { readonly product?: unknown } | null } | null;
  /** Antes de `basil`. */
  readonly price?: { readonly product?: unknown } | null;
}

interface ChargeFromApi {
  readonly id: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly status?: string;
  readonly paid?: boolean;
  readonly created?: number;
  readonly on_behalf_of?: unknown;
  readonly payment_intent?: unknown;
  readonly presentment_details?: {
    readonly presentment_amount?: number;
    readonly presentment_currency?: string;
  } | null;
  readonly balance_transaction?: unknown;
}

interface BalanceTransactionFromApi {
  readonly id: string;
  readonly amount?: number;
  readonly currency?: string;
}

export async function recordInvoiceSale(
  deps: { readonly db: PayoutsDbPort; readonly stripe: PlatformStripeClient },
  input: InvoiceSaleInput,
): Promise<InvoiceSaleOutcome> {
  const invoice = await deps.stripe.v1<InvoiceFromApi>(
    'GET',
    `/v1/invoices/${encodeURIComponent(input.invoiceId)}`,
    { expand: ['payments'] },
  );
  if (invoice.status !== 'paid') return { outcome: 'not_paid' };
  if (!Number.isInteger(invoice.amount_paid) || (invoice.amount_paid ?? 0) <= 0) {
    return { outcome: 'no_charge' };
  }
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return { outcome: 'not_a_subscription' };

  const payment = await findInvoicePayment(deps.stripe, invoice);
  if (!payment) {
    throw new PayoutsSaleUnrecordableError(
      `la factura ${invoice.id} está pagada y Stripe no tiene ningún cobro suyo`,
    );
  }
  const charge = await readCharge(deps.stripe, payment);
  if (!charge || !idOf(charge.id)) {
    throw new PayoutsSaleUnrecordableError(`la factura ${invoice.id} está pagada y no trae cargo`);
  }
  if (charge.status !== 'succeeded' || charge.paid !== true) return { outcome: 'not_paid' };
  if (!Number.isInteger(charge.amount) || (charge.amount ?? 0) <= 0 || !charge.currency) {
    return { outcome: 'not_paid' };
  }
  const onBehalfOf = idOf(charge.on_behalf_of) ?? idOf(invoice.on_behalf_of);
  if (!onBehalfOf) {
    throw new PayoutsSaleUnrecordableError(`el cargo ${charge.id} no lleva on_behalf_of`);
  }
  const chargeId = charge.id;
  const intentId = payment.paymentIntentId ?? idOf(charge.payment_intent);
  const livemode = invoice.livemode === true;

  // 1) La suscripción tiene que ser de este tenant; y los hijos de la factura,
  //    a su nombre. Transacción aparte de la venta: si la venta no se puede
  //    anotar, los hijos siguen sirviendo para atribuir los eventos del cargo.
  const subscriptionRef = await deps.db.inTenant(input.tenantId, async (tx) => {
    const refs = new RefsService(tx as never);
    const ref = await refs.find(subscriptionId);
    if (
      !ref ||
      ref.tenantId !== input.tenantId ||
      ref.kind !== 'subscription' ||
      !SUBSCRIPTION_REF_SOURCES.has(ref.source)
    ) {
      return null;
    }
    const source = ref.source as RegisterObjectRefInput['source'];
    const base = { tenantId: input.tenantId, source, localRef: ref.localRef, livemode };
    await refs.registerMany([
      {
        ...base,
        stripeObjectId: invoice.id,
        kind: 'invoice',
        parentObjectId: subscriptionId,
      },
      ...(intentId
        ? [
            {
              ...base,
              stripeObjectId: intentId,
              kind: 'payment_intent' as const,
              parentObjectId: invoice.id,
            },
          ]
        : []),
      {
        ...base,
        stripeObjectId: chargeId,
        kind: 'charge',
        parentObjectId: intentId ?? invoice.id,
      },
    ]);
    return ref;
  });
  if (!subscriptionRef) {
    throw new PayoutsSaleUnrecordableError(
      `la suscripción ${subscriptionId} de la factura ${invoice.id} no está registrada a este tenant`,
    );
  }

  // 2) La venta. Mismo criterio de importes que la compra de un curso.
  const presented = charge.presentment_details;
  const presentedAmount = presented?.presentment_amount;
  const presentedCurrency = presented?.presentment_currency;
  const hasPresentment =
    Number.isInteger(presentedAmount) && (presentedAmount ?? 0) > 0 && !!presentedCurrency;
  const presentmentAmount = hasPresentment ? presentedAmount! : charge.amount!;
  const presentmentCurrency = (hasPresentment ? presentedCurrency! : charge.currency).toLowerCase();
  const bt =
    charge.balance_transaction && typeof charge.balance_transaction === 'object'
      ? (charge.balance_transaction as BalanceTransactionFromApi)
      : null;
  const settled =
    bt && idOf(bt.id) && Number.isInteger(bt.amount) && bt.currency
      ? {
          stripeBalanceTransactionId: bt.id,
          gross: bt.amount!,
          currency: bt.currency.toLowerCase(),
        }
      : {};
  const customerCreditApplied = creditAppliedInPresentment(
    invoice,
    presentmentAmount,
    presentmentCurrency,
  );
  const chargedAt = Number.isInteger(charge.created)
    ? new Date(charge.created! * 1000)
    : new Date();
  const description = await describeInvoice(deps.stripe, invoice);

  return deps.db.inTenant(input.tenantId, async (tx) => {
    const account = await tx.modPayoutsAccount.findFirst({
      where: { tenantId: input.tenantId, stripeAccountId: onBehalfOf },
      select: { id: true, status: true },
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
          sourceKind: 'SUBSCRIPTION_INVOICE',
          sourceRef: invoice.id,
          description,
          buyerEmail: invoice.customer_email ?? null,
          stripeChargeId: chargeId,
          stripePaymentIntentId: intentId,
          stripeInvoiceId: invoice.id,
          presentmentAmount,
          presentmentCurrency,
          customerCreditApplied,
          ...settled,
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
    if (!sale || sale.tenantId !== input.tenantId || sale.sourceRef !== invoice.id) {
      throw new PayoutsSaleUnrecordableError(`el cargo ${chargeId} ya figura en otra venta`);
    }
    return {
      outcome: count === 1 ? 'created' : 'exists',
      saleId: sale.id,
      chargeId,
      accountStatus: String(account.status),
    } as const;
  });
}

/**
 * Saldo a favor del cliente que Stripe gastó en esta factura (el descuento por
 * referidos): `ending_balance − starting_balance` cuando el saldo de partida
 * era a favor (negativo), nunca más de lo que había. Va en la divisa de la
 * factura; si el alumno pagó en otra, se pasa en la proporción de lo cobrado.
 */
export function creditAppliedInPresentment(
  invoice: Pick<InvoiceFromApi, 'starting_balance' | 'ending_balance' | 'amount_paid' | 'currency'>,
  presentmentAmount: number,
  presentmentCurrency: string,
): number {
  const starting = invoice.starting_balance;
  const ending = invoice.ending_balance;
  if (!Number.isInteger(starting) || (starting ?? 0) >= 0) return 0;
  if (!Number.isInteger(ending)) return 0;
  const applied = Math.min(-starting!, ending! - starting!);
  if (applied <= 0) return 0;
  const invoiceCurrency = invoice.currency?.toLowerCase();
  if (!invoiceCurrency || invoiceCurrency === presentmentCurrency) return applied;
  const paid = invoice.amount_paid ?? 0;
  if (paid <= 0) return 0;
  return Math.round((applied * presentmentAmount) / paid);
}

/** El cargo del cobro, con su `balance_transaction` expandido. */
async function readCharge(
  stripe: PlatformStripeClient,
  payment: { readonly paymentIntentId: string | null; readonly chargeId: string | null },
): Promise<ChargeFromApi | null> {
  if (payment.chargeId) {
    return stripe.v1<ChargeFromApi>('GET', `/v1/charges/${encodeURIComponent(payment.chargeId)}`, {
      expand: ['balance_transaction'],
    });
  }
  const intent = await stripe.v1<{ latest_charge?: unknown }>(
    'GET',
    `/v1/payment_intents/${encodeURIComponent(payment.paymentIntentId!)}`,
    { expand: ['latest_charge.balance_transaction'] },
  );
  const latest = intent.latest_charge;
  if (latest && typeof latest === 'object') return latest as ChargeFromApi;
  const latestId = idOf(latest);
  if (!latestId) return null;
  return stripe.v1<ChargeFromApi>('GET', `/v1/charges/${encodeURIComponent(latestId)}`, {
    expand: ['balance_transaction'],
  });
}

/**
 * Concepto de la venta: el nombre del producto de la primera línea (el del plan
 * de la membresía, el que ve el alumno en el checkout). La `description` de la
 * línea la redacta Stripe en inglés («1 × Mensual (at €29.00 / month)») y solo
 * se usa si el producto no se puede leer.
 */
async function describeInvoice(
  stripe: PlatformStripeClient,
  invoice: InvoiceFromApi,
): Promise<string | null> {
  const line = invoice.lines?.data?.[0];
  const fallback = line?.description?.slice(0, 500) ?? null;
  const productId = idOf(line?.pricing?.price_details?.product) ?? idOf(line?.price?.product);
  if (!productId) return fallback;
  try {
    const product = await stripe.v1<{ name?: unknown }>(
      'GET',
      `/v1/products/${encodeURIComponent(productId)}`,
    );
    return typeof product.name === 'string' && product.name.trim()
      ? product.name.trim().slice(0, 500)
      : fallback;
  } catch {
    return fallback;
  }
}
