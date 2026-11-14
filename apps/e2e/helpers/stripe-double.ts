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
    items: {
      object: 'list',
      data: [{ price: { id: 'price_doble', recurring: { interval: 'month', interval_count: 1 } } }],
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
          type: 'one_time',
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
      } else if (req.method === 'POST' && /^\/v1\/subscriptions\/[^/]+$/.test(path)) {
        const sub = subscriptionOf(decodeURIComponent(path.split('/').pop()!));
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
