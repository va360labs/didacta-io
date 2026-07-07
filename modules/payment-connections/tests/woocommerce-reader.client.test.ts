import { describe, it, expect } from 'vitest';
import { WooCommerceReadSdkAdapter } from '../src/woocommerce-reader.client.js';

/**
 * Tests del lector WooCommerce con `fetch` mockeado (sin red).
 *
 * Regresión: `findSubscriptionsByEmail` resolvía SOLO por email de CUENTA WP
 * (`/customers?email=`). Eso deja fuera las compras de invitado (customer_id 0)
 * y las suscripciones cuyo email de FACTURACIÓN ≠ email de la cuenta — que el
 * buscador de WooCommerce sí encuentra. El fix añade un barrido por
 * billing.email. Estos tests fijan ambos paths + dedup.
 */

interface FakeResp {
  ok: boolean;
  status: number;
  headers: { get: (k: string) => string | null };
  json: () => Promise<unknown>;
}
function resp(status: number, body: unknown, totalPages = 1): FakeResp {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'x-wp-totalpages' ? String(totalPages) : null),
    },
    json: async () => body,
  };
}

const CREDS = { storeUrl: 'https://tienda.example', consumerKey: 'ck', consumerSecret: 'cs' };

/** Suscripción activa cuyo email de FACTURACIÓN es el buscado (el caso reportado). */
const SUB_BILLING = {
  id: 15203,
  status: 'active',
  customer_id: 42,
  currency: 'EUR',
  total: '327.00',
  billing_period: 'year',
  billing: {
    first_name: 'Antonio',
    last_name: 'Hernández Morgado',
    email: 'va360.respect108@passmail.net',
  },
  line_items: [{ name: 'VA360 2026 - Anual', product_id: 7 }],
};

function fakeFetch(handlers: {
  customers?: (email: string) => FakeResp;
  subsByStatus?: (status: string, page: number) => FakeResp;
  subsByCustomer?: (customer: string, status: string) => FakeResp;
}): typeof fetch {
  const fn = async (input: string | URL): Promise<Response> => {
    const url = new URL(input.toString());
    const qs = url.searchParams;
    if (url.pathname.endsWith('/customers')) {
      return (handlers.customers?.(qs.get('email') ?? '') ?? resp(200, [])) as unknown as Response;
    }
    if (url.pathname.endsWith('/subscriptions')) {
      if (qs.get('customer')) {
        return (handlers.subsByCustomer?.(qs.get('customer')!, qs.get('status') ?? '') ??
          resp(200, [])) as unknown as Response;
      }
      return (handlers.subsByStatus?.(qs.get('status') ?? '', Number(qs.get('page') ?? '1')) ??
        resp(200, [])) as unknown as Response;
    }
    throw new Error(`URL no esperada en el mock: ${url.toString()}`);
  };
  return fn as unknown as typeof fetch;
}

describe('WooCommerceReadSdkAdapter · findSubscriptionsByEmail', () => {
  it('la encuentra por email de FACTURACIÓN aunque no exista cuenta WP con ese email', async () => {
    // Bug reportado: /customers?email= no devuelve cliente, pero la suscripción
    // tiene ese email como billing.email.
    const fetchFn = fakeFetch({
      customers: () => resp(200, []),
      subsByStatus: (status, page) =>
        status === 'active' && page === 1 ? resp(200, [SUB_BILLING], 1) : resp(200, [], 1),
    });
    const adapter = new WooCommerceReadSdkAdapter(CREDS, fetchFn);

    const subs = await adapter.findSubscriptionsByEmail('va360.respect108@passmail.net');
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      subscriptionId: '15203',
      status: 'active',
      email: 'va360.respect108@passmail.net',
      productName: 'VA360 2026 - Anual',
    });
  });

  it('filtra por billing.email exacto (ignora subs de otros emails con el mismo estado)', async () => {
    const OTHER = {
      ...SUB_BILLING,
      id: 999,
      billing: { ...SUB_BILLING.billing, email: 'otro@x.com' },
    };
    const fetchFn = fakeFetch({
      customers: () => resp(200, []),
      subsByStatus: (status, page) =>
        status === 'active' && page === 1 ? resp(200, [OTHER, SUB_BILLING], 1) : resp(200, [], 1),
    });
    const adapter = new WooCommerceReadSdkAdapter(CREDS, fetchFn);

    const subs = await adapter.findSubscriptionsByEmail('va360.respect108@passmail.net');
    expect(subs.map((s) => s.subscriptionId)).toEqual(['15203']);
  });

  it('dedup: la misma sub por email de cuenta (path A) y por facturación (path B) sale una vez', async () => {
    const fetchFn = fakeFetch({
      customers: (email) =>
        email === 'va360.respect108@passmail.net' ? resp(200, [{ id: 42 }]) : resp(200, []),
      subsByCustomer: (customer, status) =>
        customer === '42' && status === 'active' ? resp(200, [SUB_BILLING]) : resp(200, []),
      subsByStatus: (status, page) =>
        status === 'active' && page === 1 ? resp(200, [SUB_BILLING], 1) : resp(200, [], 1),
    });
    const adapter = new WooCommerceReadSdkAdapter(CREDS, fetchFn);

    const subs = await adapter.findSubscriptionsByEmail('va360.respect108@passmail.net');
    expect(subs).toHaveLength(1);
    expect(subs[0]!.subscriptionId).toBe('15203');
  });

  it('sin coincidencias por ningún path → devuelve vacío', async () => {
    const fetchFn = fakeFetch({
      customers: () => resp(200, []),
      subsByStatus: () => resp(200, [SUB_BILLING], 1), // billing.email distinto del buscado
    });
    const adapter = new WooCommerceReadSdkAdapter(CREDS, fetchFn);

    const subs = await adapter.findSubscriptionsByEmail('nadie@x.com');
    expect(subs).toEqual([]);
  });
});
