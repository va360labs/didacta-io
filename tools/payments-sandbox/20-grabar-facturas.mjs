/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Graba del sandbox las respuestas REALES con las que se prueba el lector de
 * facturas de E5 (`modules/payouts/src/stripe/invoice-shape.ts`): la misma
 * factura de 29 EUR con la API anterior a `basil` (forma A), con la de la
 * plataforma y `payments` expandido (B) y sin expandir (C), y
 * `GET /v1/invoice_payments` por factura y por PaymentIntent. Quita URLs.
 * El fixture `modules/payouts/tests/fixtures/invoices-2026-11-12.json` sale de
 * aqui. Tambien quita `client_secret`.
 *
 * Uso:   node tools/payments-sandbox/20-grabar-facturas.mjs <dir-salida>
 */
import fs from 'node:fs';
import path from 'node:path';
import { stripe } from './lib.mjs';

const OUT = process.argv[2];
const NUEVA = '2026-10-28.endive';
const VIEJA = '2024-12-18.acacia';
// Factura 1 de sub_con_obo (29 €, tarjeta ES) y la suscripción con prueba.
const INV = 'in_1UatoiGVFsqqzpBiAvOm3OUe';
const SUB_TRIAL = 'sub_1UatpAGVFsqqzpBiKSXREUJZ';

// Fuera URLs que dan acceso (factura alojada, PDF, recibo) y secretos de cliente.
function sanear(v) {
  if (Array.isArray(v)) return v.map(sanear);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'client_secret') continue;
      if (typeof x === 'string' && /^https?:\/\//.test(x)) o[k] = '<url>';
      else o[k] = sanear(x);
    }
    return o;
  }
  return v;
}
const guardar = (nombre, obj) => {
  fs.writeFileSync(path.join(OUT, nombre), JSON.stringify(sanear(obj), null, 2));
  console.log('grabado', nombre);
};

const a = await stripe('GET', `/v1/invoices/${INV}`, {}, { version: VIEJA });
guardar('invoice-forma-a-charge.json', a);
const b = await stripe('GET', `/v1/invoices/${INV}`, { expand: ['payments'] }, { version: NUEVA });
guardar('invoice-forma-b-payments.json', b);
const sinPayments = await stripe('GET', `/v1/invoices/${INV}`, {}, { version: NUEVA });
guardar('invoice-forma-c-sin-payments.json', sinPayments);
const ip = await stripe('GET', '/v1/invoice_payments', { invoice: INV }, { version: NUEVA });
guardar('invoice-payments-por-factura.json', ip);
const pi = ip.data?.[0]?.payment?.payment_intent;
const ipPorPi = await stripe(
  'GET',
  '/v1/invoice_payments',
  { payment: { type: 'payment_intent', payment_intent: pi } },
  { version: NUEVA, soft: true },
);
guardar('invoice-payments-por-pi.json', ipPorPi);
const piObj = await stripe(
  'GET',
  `/v1/payment_intents/${pi}`,
  { expand: ['latest_charge.balance_transaction'] },
  { version: NUEVA },
);
guardar('payment-intent-de-factura.json', piObj);
const ses = await stripe(
  'GET',
  '/v1/checkout/sessions',
  { subscription: 'sub_1UatoiGVFsqqzpBio5vcWfRW', limit: 1 },
  { version: NUEVA },
);
guardar('sesiones-por-suscripcion-sin-checkout.json', ses);
const trial = await stripe(
  'GET',
  '/v1/invoices',
  { subscription: SUB_TRIAL, limit: 10, expand: ['data.payments'] },
  { version: NUEVA },
);
guardar('invoices-suscripcion-con-prueba.json', trial);
