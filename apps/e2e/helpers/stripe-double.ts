/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import http from 'node:http';

/**
 * Doble de Stripe para la E2E: atiende lo justo para poner un curso a la
 * venta (crear Product y Price, y leerlos) y para el descuento por referidos
 * (leer el saldo de un cliente y abonarle: `POST
 * /v1/customers/:id/balance_transactions`, idempotente por `Idempotency-Key`
 * como Stripe), y para una compra de curso: `POST /v1/checkout/sessions` devuelve
 * una sesión cuya `url` es una página de pago de mentira servida por el propio
 * doble (`GET /pagar/:id`); el test completa el pago con el webhook firmado.
 * `POST /v1/checkout/sessions/:id/expire` la caduca si sigue abierta (400 si no).
 * El recibo pregunta por el medio de pago (`GET /v1/payment_intents/:id`): el
 * doble contesta la tarjeta de pruebas de Stripe (Visa ···· 4242).
 * Para la oferta al darse de baja atiende también la suscripción (`GET` y
 * `POST /v1/subscriptions/:id`: pausa, cupón y baja al final del periodo) y
 * `POST /v1/coupons`. Una suscripción que no conoce la inventa mensual y al
 * día (periodo de 30 días que acaba en 20); `setSubscription` la ajusta.
 * Para el CAMBIO DE NIVEL: `POST /v1/subscriptions/:id` con `items[0][price]`
 * cambia el precio de la línea y prorratea por lo que queda de periodo (con
 * `always_invoice` deja una factura pagada en `latest_invoice`; con
 * `create_prorations`, la diferencia pendiente para la próxima), y
 * `POST /v1/invoices/create_preview` devuelve esa misma cuenta sin cambiar
 * nada. `failNextPriceChange()` hace que el siguiente cambio de precio
 * responda 402 (tarjeta rechazada) sin tocar la suscripción, como Stripe con
 * `payment_behavior: error_if_incomplete`.
 * La API habla con él cuando
 * arranca con `STRIPE_TEST_API_URL` y una clave `sk_test_` (ver
 * `apps/api/src/modules/stripe-test-api.ts`). Guarda lo creado en memoria y
 * lo expone para que el test pueda comprobarlo.
 */
export interface StripeDouble {
  port: number;
  calls: Array<{ method: string; path: string; body: Record<string, string> }>;
  /** Estado de una suscripción (lo que devuelve `GET /v1/subscriptions/:id`). */
  subscription: (id: string) => Record<string, unknown>;
  /** Fija campos de una suscripción (p. ej. `current_period_end`). */
  setSubscription: (id: string, patch: Record<string, unknown>) => void;
  /** El siguiente cambio de precio de una suscripción responde 402 (tarjeta rechazada). */
  failNextPriceChange: () => void;
  /** Un objeto creado (precio, producto, factura…) por su id. */
  object: (id: string) => Record<string, unknown> | undefined;
  close: () => Promise<void>;
}

const DAY = 86_400;

/** Suscripción mensual al día, como la devuelve Stripe (forma `acacia`). */
function defaultSubscription(id: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    object: 'subscription',
    status: 'active',
    cancel_at_period_end: false,
    current_period_start: now - 10 * DAY,
    current_period_end: now + 20 * DAY,
    canceled_at: null,
    customer: `cus_doble_${id}`,
    latest_invoice: null,
    metadata: {},
    items: {
      object: 'list',
      data: [
        {
          id: `si_doble_${id}`,
          price: { id: 'price_doble', recurring: { interval: 'month', interval_count: 1 } },
        },
      ],
    },
    pause_collection: null,
    discount: null,
    discounts: [],
  };
}

function parseForm(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    out[decodeURIComponent(k!)] = decodeURIComponent(v.replace(/\+/g, ' '));
  }
  return out;
}

export async function startStripeDouble(
  port = Number(process.env.E2E_STRIPE_DOUBLE_PORT ?? 12111),
): Promise<StripeDouble> {
  const calls: StripeDouble['calls'] = [];
  const objects = new Map<string, Record<string, unknown>>();
  /** Saldo por cliente (negativo = a su favor) y respuestas por clave de idempotencia. */
  const balances = new Map<string, number>();
  const idempotent = new Map<string, Record<string, unknown>>();
  const subscriptions = new Map<string, Record<string, unknown>>();
  const subscriptionOf = (id: string) => {
    if (!subscriptions.has(id)) subscriptions.set(id, defaultSubscription(id));
    return subscriptions.get(id)!;
  };
  let seq = 0;
  const run = Date.now().toString(36);
  let failPriceChange = false;
  /** Importe de un precio: el que dice la línea o el del precio creado aquí. */
  const amountOf = (price: Record<string, unknown> | undefined): number => {
    if (!price) return 0;
    if (typeof price['unit_amount'] === 'number') return price['unit_amount'] as number;
    const created = objects.get(String(price['id']));
    return typeof created?.['unit_amount'] === 'number' ? (created['unit_amount'] as number) : 0;
  };
  /** Prorrateo de pasar la línea a `newPriceId` ahora: (nuevo − viejo) × lo que queda. */
  const prorationOf = (sub: Record<string, unknown>, newPriceId: string) => {
    const items = sub['items'] as { data: Array<{ price: Record<string, unknown> }> };
    const oldAmount = amountOf(items.data[0]?.price);
    const newPrice = objects.get(newPriceId) ?? { id: newPriceId };
    const newAmount = amountOf(newPrice);
    const start = Number(sub['current_period_start']);
    const end = Number(sub['current_period_end']);
    const now = Math.floor(Date.now() / 1000);
    const left = end > start ? Math.max(0, Math.min(1, (end - now) / (end - start))) : 1;
    const currency = String(newPrice['currency'] ?? 'eur');
    return { amount: Math.round((newAmount - oldAmount) * left), currency, newPrice };
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = parseForm(raw);
      const path = (req.url ?? '').split('?')[0]!;
      calls.push({ method: req.method ?? 'GET', path, body });
      let obj: Record<string, unknown> | undefined;
      if (req.method === 'POST' && path === '/v1/products') {
        obj = { id: `prod_doble_${++seq}`, object: 'product', name: body.name, active: true };
      } else if (req.method === 'POST' && path === '/v1/prices') {
        obj = {
          id: `price_doble_${++seq}`,
          object: 'price',
          product: body.product,
          unit_amount: Number(body.unit_amount),
          currency: body.currency,
          active: true,
          type: body['recurring[interval]'] ? 'recurring' : 'one_time',
          recurring: body['recurring[interval]']
            ? {
                interval: body['recurring[interval]'],
                interval_count: Number(body['recurring[interval_count]'] ?? 1),
              }
            : null,
        };
      } else if (req.method === 'POST' && path === '/v1/checkout/sessions') {
        // Único entre ejecuciones: `stripe_session_id` es UNIQUE en toda la base.
        const id = `cs_doble_${run}_${++seq}`;
        obj = {
          id,
          object: 'checkout.session',
          mode: body.mode,
          status: 'open',
          url: `http://127.0.0.1:${port}/pagar/${id}`,
          metadata: Object.fromEntries(
            Object.entries(body)
              .filter(([k]) => k.startsWith('metadata['))
              .map(([k, v]) => [k.slice('metadata['.length, -1), v]),
          ),
        };
      } else if (req.method === 'POST' && /^\/v1\/checkout\/sessions\/[^/]+\/expire$/.test(path)) {
        // Como Stripe: solo se caduca una sesión abierta; si no, 400.
        const session = objects.get(decodeURIComponent(path.split('/')[4]!));
        if (session && session['status'] === 'open') {
          session['status'] = 'expired';
          obj = session;
        } else if (session) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              error: {
                message: `Only Checkout Sessions with a status in ["open"] can be expired.`,
              },
            }),
          );
          return;
        }
      } else if (req.method === 'GET' && /^\/v1\/checkout\/sessions\/[^/]+$/.test(path)) {
        obj = objects.get(decodeURIComponent(path.split('/').pop()!));
      } else if (req.method === 'GET' && path.startsWith('/pagar/')) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(
          `<!doctype html><title>Pago de prueba</title><h1>Pago de prueba</h1><p data-session="${path.slice('/pagar/'.length)}">Doble de Stripe</p>`,
        );
        return;
      } else if (req.method === 'GET' && /^\/v1\/subscriptions\/[^/]+$/.test(path)) {
        obj = subscriptionOf(decodeURIComponent(path.split('/').pop()!));
      } else if (req.method === 'POST' && path === '/v1/invoices/create_preview') {
        const sub = subscriptionOf(String(body['subscription'] ?? ''));
        const priceId = body['subscription_details[items][0][price]'] ?? '';
        const { amount, currency } = prorationOf(sub, priceId);
        obj = {
          id: `upcoming_doble_${++seq}`,
          object: 'invoice',
          amount_due: Math.max(0, amount),
          total: amount,
          currency,
        };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(obj));
        return;
      } else if (req.method === 'POST' && /^\/v1\/subscriptions\/[^/]+$/.test(path)) {
        const sub = subscriptionOf(decodeURIComponent(path.split('/').pop()!));
        const newPriceId = body['items[0][price]'];
        if (newPriceId) {
          // Cambio de nivel. Con `error_if_incomplete`, una tarjeta rechazada
          // deja la suscripción como estaba y responde 402.
          if (failPriceChange) {
            failPriceChange = false;
            res.statusCode = 402;
            res.setHeader('content-type', 'application/json');
            res.end(
              JSON.stringify({
                error: {
                  type: 'card_error',
                  code: 'card_declined',
                  message: 'Your card was declined.',
                },
              }),
            );
            return;
          }
          const { amount, currency, newPrice } = prorationOf(sub, newPriceId);
          const items = sub.items as { data: Array<Record<string, unknown>> };
          items.data[0] = { ...items.data[0], price: newPrice };
          for (const [k, v] of Object.entries(body)) {
            if (k.startsWith('metadata[')) {
              (sub.metadata as Record<string, string>)[k.slice('metadata['.length, -1)] = v;
            }
          }
          if (body['proration_behavior'] === 'always_invoice' && amount !== 0) {
            const invoice = {
              id: `in_doble_${run}_${++seq}`,
              object: 'invoice',
              status: 'paid',
              amount_paid: Math.max(0, amount),
              amount_due: Math.max(0, amount),
              total: amount,
              currency,
              billing_reason: 'subscription_update',
              subscription: sub.id,
              customer: sub.customer,
            };
            objects.set(invoice.id, invoice);
            sub.latest_invoice = invoice;
          } else if (body['proration_behavior'] === 'create_prorations') {
            sub.pending_proration = amount;
          }
        }
        if (body['pause_collection[behavior]']) {
          sub.pause_collection = {
            behavior: body['pause_collection[behavior]'],
            resumes_at: Number(body['pause_collection[resumes_at]']),
          };
        }
        if (body['cancel_at_period_end'] === 'true') sub.cancel_at_period_end = true;
        const couponId = body['discounts[0][coupon]'];
        if (couponId) {
          const coupon = objects.get(couponId) as { duration_in_months?: number } | undefined;
          const start = Math.floor(Date.now() / 1000);
          const months = coupon?.duration_in_months;
          sub.discount = {
            id: `di_doble_${++seq}`,
            coupon: coupon ?? { id: couponId },
            start,
            end: months ? start + months * 30 * DAY : null,
          };
          sub.discounts = [(sub.discount as { id: string }).id];
        }
        // Lo devuelve sin guardarlo aparte en `objects` (vive en `subscriptions`).
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(sub));
        return;
      } else if (req.method === 'POST' && path === '/v1/coupons') {
        const key = String(req.headers['idempotency-key'] ?? '');
        const repeated = key ? idempotent.get(key) : undefined;
        obj = repeated ?? {
          id: `coupon_doble_${++seq}`,
          object: 'coupon',
          percent_off: Number(body.percent_off),
          duration: body.duration,
          duration_in_months: body.duration_in_months ? Number(body.duration_in_months) : null,
          max_redemptions: body.max_redemptions ? Number(body.max_redemptions) : null,
          name: body.name ?? null,
        };
        if (key && !repeated) idempotent.set(key, obj);
      } else if (req.method === 'GET' && /^\/v1\/(prices|products)\//.test(path)) {
        obj = objects.get(path.split('/').pop()!);
      } else if (req.method === 'GET' && /^\/v1\/payment_intents\/[^/]+$/.test(path)) {
        // El medio de pago del recibo: como Stripe en modo prueba con la
        // tarjeta 4242 (`expand[]=latest_charge`).
        const id = decodeURIComponent(path.split('/').pop()!);
        obj = {
          id,
          object: 'payment_intent',
          status: 'succeeded',
          latest_charge: {
            id: `ch_doble_${id}`,
            object: 'charge',
            payment_method_details: {
              type: 'card',
              card: { brand: 'visa', last4: '4242', wallet: null },
            },
          },
        };
      } else if (req.method === 'GET' && /^\/v1\/customers\/[^/]+$/.test(path)) {
        const id = decodeURIComponent(path.split('/').pop()!);
        obj = { id, object: 'customer', balance: balances.get(id) ?? 0, currency: 'eur' };
      } else if (
        req.method === 'POST' &&
        /^\/v1\/customers\/[^/]+\/balance_transactions$/.test(path)
      ) {
        const customer = decodeURIComponent(path.split('/')[3]!);
        const key = String(req.headers['idempotency-key'] ?? '');
        const repeated = key ? idempotent.get(key) : undefined;
        if (repeated) {
          obj = repeated;
        } else {
          const amount = Number(body.amount);
          const ending = (balances.get(customer) ?? 0) + amount;
          balances.set(customer, ending);
          obj = {
            id: `cbtxn_doble_${++seq}`,
            object: 'customer_balance_transaction',
            customer,
            amount,
            currency: body.currency,
            description: body.description ?? null,
            ending_balance: ending,
            type: 'adjustment',
          };
          if (key) idempotent.set(key, obj);
        }
      }
      if (obj && req.method === 'POST') objects.set(String(obj.id), obj);
      res.setHeader('content-type', 'application/json');
      if (!obj) {
        res.statusCode = 404;
        res.end(
          JSON.stringify({
            error: { message: `doble de Stripe: ${req.method} ${path} no implementado` },
          }),
        );
        return;
      }
      res.end(JSON.stringify(obj));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port,
    calls,
    subscription: (id: string) => subscriptionOf(id),
    setSubscription: (id: string, patch: Record<string, unknown>) => {
      Object.assign(subscriptionOf(id), patch);
    },
    failNextPriceChange: () => {
      failPriceChange = true;
    },
    object: (id: string) => objects.get(id),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
