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
 * como Stripe). La API habla con él cuando
 * arranca con `STRIPE_TEST_API_URL` y una clave `sk_test_` (ver
 * `apps/api/src/modules/stripe-test-api.ts`). Guarda lo creado en memoria y
 * lo expone para que el test pueda comprobarlo.
 */
export interface StripeDouble {
  port: number;
  calls: Array<{ method: string; path: string; body: Record<string, string> }>;
  close: () => Promise<void>;
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
  let seq = 0;
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
      } else if (req.method === 'GET' && /^\/v1\/(prices|products)\//.test(path)) {
        obj = objects.get(path.split('/').pop()!);
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
