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
    first_name: 'Cliente',
    last_name: 'De Ejemplo',
    email: 'cliente@example.com',
  },
  line_items: [{ name: 'Membresía 2026 - Anual', product_id: 7 }],
};

function fakeFetch(handlers: {
  customers?: (email: string) => FakeResp;
  subsByStatus?: (status: string, page: number) => FakeResp;
  subsByCustomer?: (customer: string, status: string) => FakeResp;
  ordersByCustomer?: (customer: string, page: number) => FakeResp;
  ordersBySearch?: (search: string, page: number) => FakeResp;
}): typeof fetch {
  const fn = async (input: string | URL): Promise<Response> => {
    const url = new URL(input.toString());
    const qs = url.searchParams;
    if (url.pathname.endsWith('/customers')) {
      return (handlers.customers?.(qs.get('email') ?? '') ?? resp(200, [])) as unknown as Response;
    }
    if (url.pathname.endsWith('/orders')) {
      const page = Number(qs.get('page') ?? '1');
      if (qs.get('customer')) {
        return (handlers.ordersByCustomer?.(qs.get('customer')!, page) ??
          resp(200, [])) as unknown as Response;
      }
      return (handlers.ordersBySearch?.(qs.get('search') ?? '', page) ??
        resp(200, [])) as unknown as Response;
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

    const subs = await adapter.findSubscriptionsByEmail('cliente@example.com');
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      subscriptionId: '15203',
      status: 'active',
      email: 'cliente@example.com',
      productName: 'Membresía 2026 - Anual',
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

    const subs = await adapter.findSubscriptionsByEmail('cliente@example.com');
    expect(subs.map((s) => s.subscriptionId)).toEqual(['15203']);
  });

  it('dedup: la misma sub por email de cuenta (path A) y por facturación (path B) sale una vez', async () => {
    const fetchFn = fakeFetch({
      customers: (email) =>
        email === 'cliente@example.com' ? resp(200, [{ id: 42 }]) : resp(200, []),
      subsByCustomer: (customer, status) =>
        customer === '42' && status === 'active' ? resp(200, [SUB_BILLING]) : resp(200, []),
      subsByStatus: (status, page) =>
        status === 'active' && page === 1 ? resp(200, [SUB_BILLING], 1) : resp(200, [], 1),
    });
    const adapter = new WooCommerceReadSdkAdapter(CREDS, fetchFn);

    const subs = await adapter.findSubscriptionsByEmail('cliente@example.com');
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

/**
 * Compras PUNTUALES. Son las que justifican a quien compró un "acceso lifetime":
 * no dejan suscripción viva, así que sin esto el aprobador ve "sin suscripción"
 * y rechaza a un cliente que sí pagó.
 */
const EMAIL = 'lifetime@example.com';

/** Pedido de invitado (customer_id 0) con el email buscado en facturación. */
const ORDER_GUEST = {
  id: 8801,
  number: '8801',
  status: 'completed',
  currency: 'EUR',
  total: '997.00',
  date_created_gmt: '2023-04-11T09:15:00',
  billing: { email: EMAIL },
  line_items: [{ name: 'Acceso Lifetime' }, { name: 'Bonus: plantillas' }],
};

describe('WooCommerceReadSdkAdapter · findPurchasesByEmail', () => {
  it('devuelve los pedidos del cliente registrado (path A) con importe en céntimos', async () => {
    const fetchFn = fakeFetch({
      customers: (email) => (email === EMAIL ? resp(200, [{ id: 42 }]) : resp(200, [])),
      ordersByCustomer: (customer, page) =>
        customer === '42' && page === 1 ? resp(200, [ORDER_GUEST], 1) : resp(200, [], 1),
    });
    const adapter = new WooCommerceReadSdkAdapter(CREDS, fetchFn);

    const purchases = await adapter.findPurchasesByEmail(EMAIL);
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({
      orderId: '8801',
      orderNumber: '8801',
      status: 'completed',
      total: 99_700,
      currency: 'EUR',
      createdAt: '2023-04-11T09:15:00Z',
      products: ['Acceso Lifetime', 'Bonus: plantillas'],
    });
  });

  it('encuentra la compra de INVITADO por billing.email (path B) sin cuenta WP', async () => {
    const fetchFn = fakeFetch({
      customers: () => resp(200, []),
      ordersBySearch: (search, page) =>
        search === EMAIL && page === 1 ? resp(200, [ORDER_GUEST], 1) : resp(200, [], 1),
    });
    const adapter = new WooCommerceReadSdkAdapter(CREDS, fetchFn);

    const purchases = await adapter.findPurchasesByEmail(EMAIL);
    expect(purchases.map((p) => p.orderId)).toEqual(['8801']);
  });

  it('`search` es difuso: descarta las filas cuyo billing.email no es exacto', async () => {
    const OTHER = { ...ORDER_GUEST, id: 9999, billing: { email: 'otro@x.com' } };
    const fetchFn = fakeFetch({
      customers: () => resp(200, []),
      ordersBySearch: (_s, page) =>
        page === 1 ? resp(200, [OTHER, ORDER_GUEST], 1) : resp(200, []),
    });
    const adapter = new WooCommerceReadSdkAdapter(CREDS, fetchFn);

    const purchases = await adapter.findPurchasesByEmail(EMAIL);
    expect(purchases.map((p) => p.orderId)).toEqual(['8801']);
  });

  it('dedup: el mismo pedido por ambos paths sale una sola vez', async () => {
    const fetchFn = fakeFetch({
      customers: () => resp(200, [{ id: 42 }]),
      ordersByCustomer: (_c, page) => (page === 1 ? resp(200, [ORDER_GUEST], 1) : resp(200, [], 1)),
      ordersBySearch: (_s, page) => (page === 1 ? resp(200, [ORDER_GUEST], 1) : resp(200, [], 1)),
    });
    const adapter = new WooCommerceReadSdkAdapter(CREDS, fetchFn);

    const purchases = await adapter.findPurchasesByEmail(EMAIL);
    expect(purchases).toHaveLength(1);
  });

  it('incluye TODOS los estados (un reembolsado también le interesa al aprobador)', async () => {
    const REFUNDED = { ...ORDER_GUEST, id: 8802, number: '8802', status: 'refunded' };
    const fetchFn = fakeFetch({
      customers: () => resp(200, []),
      ordersBySearch: (_s, page) =>
        page === 1 ? resp(200, [ORDER_GUEST, REFUNDED], 1) : resp(200, [], 1),
    });
    const adapter = new WooCommerceReadSdkAdapter(CREDS, fetchFn);

    const purchases = await adapter.findPurchasesByEmail(EMAIL);
    expect(purchases.map((p) => p.status).sort()).toEqual(['completed', 'refunded']);
  });

  it('pagina hasta agotar X-WP-TotalPages', async () => {
    const p2 = { ...ORDER_GUEST, id: 8803, number: '8803' };
    const fetchFn = fakeFetch({
      customers: () => resp(200, []),
      ordersBySearch: (_s, page) => (page === 1 ? resp(200, [ORDER_GUEST], 2) : resp(200, [p2], 2)),
    });
    const adapter = new WooCommerceReadSdkAdapter(CREDS, fetchFn);

    const purchases = await adapter.findPurchasesByEmail(EMAIL);
    expect(purchases.map((p) => p.orderId).sort()).toEqual(['8801', '8803']);
  });

  it('sin pedidos → vacío (no revienta el lookup)', async () => {
    const adapter = new WooCommerceReadSdkAdapter(CREDS, fakeFetch({}));
    await expect(adapter.findPurchasesByEmail('nadie@x.com')).resolves.toEqual([]);
  });
});
