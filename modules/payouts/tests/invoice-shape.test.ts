/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Lector tolerante del cobro de una factura (`stripe/invoice-shape.ts`) con
 * las respuestas REALES del sandbox de la plataforma: la misma factura de
 * 29 € leída con la API anterior a `basil` (forma A), con la de la plataforma
 * y `payments` expandido (B) y sin expandir (C, que obliga a preguntar a
 * `GET /v1/invoice_payments`).
 */

import { describe, expect, it } from 'vitest';
import {
  findInvoiceOfCharge,
  findInvoicePayment,
  invoicePaymentFromObject,
} from '../src/stripe/invoice-shape.js';
import { InMemoryPlatformStripeClient } from '../src/stripe/platform-stripe.fake.js';
import facturas from './fixtures/invoices-2026-11-12.json';

const INVOICE = 'in_1UatoiGVFsqqzpBiAvOm3OUe';
const PI = 'pi_3UatojGVFsqqzpBi1aY1ywxE';
const CHARGE = 'ch_3UatojGVFsqqzpBi1wnKzuX2';

type Obj = Record<string, unknown>;
const formaA = facturas.formaA_invoice_acacia as Obj;
const formaB = facturas.formaB_invoice_endive_expand_payments as Obj;
const formaC = facturas.formaC_invoice_endive_sin_payments as Obj;

function fakeWithInvoicePayments(): InMemoryPlatformStripeClient {
  const fake = new InMemoryPlatformStripeClient();
  const list = facturas.invoice_payments_por_factura as { data: Array<Obj> };
  fake.on('GET', '/v1/invoice_payments', (req) => {
    const byInvoice = req.params['invoice'];
    const byPayment = req.params['payment'] as Obj | undefined;
    const data = list.data.filter((item) => {
      if (byInvoice !== undefined) return item['invoice'] === byInvoice;
      const payment = item['payment'] as Obj;
      return (
        byPayment?.['type'] === payment['type'] &&
        byPayment?.['payment_intent'] === payment['payment_intent']
      );
    });
    return { object: 'list', data, has_more: false };
  });
  return fake;
}

describe('las tres formas reales de la factura de 29 €', () => {
  it('las grabaciones son la misma factura, cobrada en nombre del creador', () => {
    for (const forma of [formaA, formaB, formaC]) {
      expect(forma).toMatchObject({
        id: INVOICE,
        status: 'paid',
        amount_paid: 2900,
        currency: 'eur',
        on_behalf_of: 'acct_1Uatj9GgKZOTeRsE',
      });
    }
    // A trae el cargo en la raíz; B y C, no (API desde `basil`).
    expect(formaA).toMatchObject({ charge: CHARGE, payment_intent: PI });
    expect(formaB).not.toHaveProperty('charge');
    expect(formaB).not.toHaveProperty('payment_intent');
    expect(formaC).not.toHaveProperty('payments');
  });

  it('A — invoice.charge (y payment_intent) en la raíz', async () => {
    const fake = new InMemoryPlatformStripeClient();
    expect(await findInvoicePayment(fake, formaA)).toEqual({
      paymentIntentId: PI,
      chargeId: CHARGE,
      via: 'invoice.charge',
    });
    expect(fake.calls).toEqual([]);
  });

  it('B — invoice.payments.data[].payment.payment_intent, sin llamar a nadie', async () => {
    const fake = new InMemoryPlatformStripeClient();
    expect(invoicePaymentFromObject(formaB)).toEqual({
      paymentIntentId: PI,
      chargeId: null,
      via: 'invoice.payments',
    });
    expect(await findInvoicePayment(fake, formaB)).toMatchObject({ paymentIntentId: PI });
    expect(fake.calls).toEqual([]);
  });

  it('C — sin payments: GET /v1/invoice_payments?invoice=…', async () => {
    const fake = fakeWithInvoicePayments();
    expect(invoicePaymentFromObject(formaC)).toBeNull();
    expect(await findInvoicePayment(fake, formaC)).toEqual({
      paymentIntentId: PI,
      chargeId: null,
      via: 'invoice_payments',
    });
    expect(fake.calls.map((c) => [c.method, c.path, c.params['invoice']])).toEqual([
      ['GET', '/v1/invoice_payments', INVOICE],
    ]);
  });

  it('el cargo real (API de la plataforma) ya no dice de qué factura es', () => {
    const charge = (facturas.payment_intent_de_la_factura as Obj)['latest_charge'] as Obj;
    expect(charge['id']).toBe(CHARGE);
    expect(charge).not.toHaveProperty('invoice');
  });

  it('cargo → factura: charge.invoice si lo trae; si no, invoice_payments por el PaymentIntent', async () => {
    const fake = fakeWithInvoicePayments();
    expect(await findInvoiceOfCharge(fake, { invoice: INVOICE, payment_intent: PI })).toBe(INVOICE);
    expect(fake.calls).toEqual([]);
    expect(await findInvoiceOfCharge(fake, { payment_intent: PI })).toBe(INVOICE);
    expect(fake.calls[0]!.params).toEqual({
      payment: { type: 'payment_intent', payment_intent: PI },
      limit: 1,
    });
    // Un PaymentIntent que no es de ninguna factura (compra suelta).
    expect(await findInvoiceOfCharge(fake, { payment_intent: 'pi_3CompraSuelta' })).toBeNull();
    expect(await findInvoiceOfCharge(fake, {})).toBeNull();
  });
});

describe('qué pago cuenta', () => {
  it('solo el pagado: un intento fallido anterior en la lista no se confunde con el cobro', () => {
    const payments = (formaB['payments'] as { data: Obj[] }).data;
    const conIntentoFallido = {
      ...formaB,
      payments: {
        object: 'list',
        data: [
          {
            ...payments[0],
            id: 'inpay_fallido',
            status: 'canceled',
            is_default: false,
            payment: { type: 'payment_intent', payment_intent: 'pi_3IntentoFallido' },
          },
          ...payments,
        ],
      },
    };
    expect(invoicePaymentFromObject(conIntentoFallido)).toMatchObject({ paymentIntentId: PI });
  });

  it('un pago con `type: charge` (cobro fuera de banda) da el cargo', () => {
    expect(
      invoicePaymentFromObject({
        id: 'in_x',
        payments: {
          data: [
            { status: 'paid', is_default: true, payment: { type: 'charge', charge: 'ch_3X' } },
          ],
        },
      }),
    ).toEqual({ paymentIntentId: null, chargeId: 'ch_3X', via: 'invoice.payments' });
  });

  it('la factura de 0 € de una prueba gratis no tiene ningún cobro', async () => {
    const alta = facturas.prueba_7_dias_factura_alta_0 as Obj;
    expect(alta).toMatchObject({
      status: 'paid',
      amount_paid: 0,
      billing_reason: 'subscription_create',
    });
    expect(invoicePaymentFromObject(alta)).toBeNull();
    const fake = new InMemoryPlatformStripeClient();
    fake.on('GET', '/v1/invoice_payments', () => ({ object: 'list', data: [], has_more: false }));
    expect(await findInvoicePayment(fake, alta)).toBeNull();
  });
});
