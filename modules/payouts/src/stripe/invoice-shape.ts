/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { idOf } from '../event-router.js';
import type { PlatformStripeClient } from './platform-stripe.client.js';

/**
 * ¿Con qué cobro se pagó una factura? Lector TOLERANTE a las formas que ha
 * tenido la API de Stripe (etapa E5).
 *
 * La factura de una suscripción no lleva el cargo en el mismo sitio según la
 * versión de la API con la que se lea (o con la que llegue el evento: Stripe
 * los manda con la versión de la cuenta o la del endpoint, no con la del SDK):
 *
 *  - **A** — hasta `2025-03-31.basil`: `invoice.charge` y
 *    `invoice.payment_intent`, en la raíz.
 *  - **B** — desde `basil`: ya no están; los cobros cuelgan de
 *    `invoice.payments.data[].payment` (`{ type: 'payment_intent',
 *    payment_intent }` o `{ type: 'charge', charge }`). Solo viene si se pide
 *    `expand[]=payments`.
 *  - **C** — la factura llegó sin `payments` (un evento, o una lectura sin
 *    expandir): `GET /v1/invoice_payments?invoice=…`.
 *
 * Se prueban en ese orden y gana la primera que da un cobro. Las tres están
 * grabadas del sandbox de la plataforma (`tests/fixtures/invoices-2026-11-12.json`).
 *
 * El cargo tampoco dice ya de qué factura es (`charge.invoice` desapareció en
 * `basil`): `findInvoiceOfCharge` lo pregunta a `GET /v1/invoice_payments`
 * filtrando por el PaymentIntent.
 */

/** Cobro de una factura: el PaymentIntent, el cargo o los dos. */
export interface InvoicePaymentRef {
  readonly paymentIntentId: string | null;
  readonly chargeId: string | null;
  /** Por qué camino se encontró (diagnóstico y tests). */
  readonly via: 'invoice.charge' | 'invoice.payments' | 'invoice_payments';
}

interface InvoicePaymentItem {
  readonly status?: unknown;
  readonly is_default?: unknown;
  readonly invoice?: unknown;
  readonly payment?: {
    readonly type?: unknown;
    readonly payment_intent?: unknown;
    readonly charge?: unknown;
  } | null;
}

/**
 * Formas A y B, sin llamar a nadie. `null` si la factura no trae el cobro (la
 * forma C la resuelve `findInvoicePayment`).
 */
export function invoicePaymentFromObject(
  invoice: Readonly<Record<string, unknown>>,
): InvoicePaymentRef | null {
  // A — la raíz de la factura (API anterior a `basil`).
  const rootCharge = idOf(invoice['charge']);
  const rootIntent = idOf(invoice['payment_intent']);
  if (rootCharge || rootIntent) {
    return { paymentIntentId: rootIntent, chargeId: rootCharge, via: 'invoice.charge' };
  }
  // B — `invoice.payments` (expandido).
  const payments = invoice['payments'] as { data?: unknown } | null | undefined;
  const fromList = pickPayment(Array.isArray(payments?.data) ? payments.data : []);
  return fromList ? { ...fromList, via: 'invoice.payments' } : null;
}

/** Formas A → B → C. `null` si Stripe no tiene ningún cobro para la factura. */
export async function findInvoicePayment(
  stripe: PlatformStripeClient,
  invoice: Readonly<Record<string, unknown>>,
): Promise<InvoicePaymentRef | null> {
  const local = invoicePaymentFromObject(invoice);
  if (local) return local;
  const invoiceId = idOf(invoice['id']);
  if (!invoiceId) return null;
  // C — preguntar por la factura.
  const list = await stripe.v1<{ data?: unknown[] }>('GET', '/v1/invoice_payments', {
    invoice: invoiceId,
    limit: 10,
  });
  const found = pickPayment(Array.isArray(list.data) ? list.data : []);
  return found ? { ...found, via: 'invoice_payments' } : null;
}

/**
 * ¿De qué factura es este cargo? `charge.invoice` (API anterior a `basil`) o,
 * si no, `GET /v1/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=…`.
 * `null` si el cargo no es de ninguna factura (una compra suelta).
 */
export async function findInvoiceOfCharge(
  stripe: PlatformStripeClient,
  charge: Readonly<{ invoice?: unknown; payment_intent?: unknown }>,
): Promise<string | null> {
  const direct = idOf(charge.invoice);
  if (direct) return direct;
  const intentId = idOf(charge.payment_intent);
  if (!intentId) return null;
  const list = await stripe.v1<{ data?: InvoicePaymentItem[] }>('GET', '/v1/invoice_payments', {
    payment: { type: 'payment_intent', payment_intent: intentId },
    limit: 1,
  });
  return idOf(list.data?.[0]?.invoice);
}

/**
 * De la lista de pagos de una factura, el que la pagó: el `paid`, y entre
 * varios, el `is_default`. Los cancelados o abiertos (intentos fallidos) no
 * cuentan.
 */
function pickPayment(
  items: readonly unknown[],
): { paymentIntentId: string | null; chargeId: string | null } | null {
  const paid = (items as InvoicePaymentItem[]).filter((item) => item?.status === 'paid');
  const ordered = [...paid.filter((p) => p.is_default === true), ...paid];
  for (const item of ordered) {
    const payment = item.payment;
    if (!payment) continue;
    if (payment.type === 'payment_intent') {
      const intentId = idOf(payment.payment_intent);
      if (intentId) return { paymentIntentId: intentId, chargeId: null };
    }
    if (payment.type === 'charge') {
      const chargeId = idOf(payment.charge);
      if (chargeId) return { paymentIntentId: null, chargeId };
    }
  }
  return null;
}
