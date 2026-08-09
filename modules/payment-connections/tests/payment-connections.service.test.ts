/**
 * Tests unit de PaymentConnectionsService — sin red, sin DB real, sin Stripe SDK.
 *
 * Estrategia:
 *  - Prisma mockeado con mapas in-memory.
 *  - StripeReadAdapter stub determinista (por api key).
 *  - ConfigPort stub in-memory (simula tenant_setting cifrado).
 *  - UserDirectoryPort stub (simula el match contra la tabla user).
 *
 * Cobertura priorizada:
 *  - addConnection: valida key (ok / inválida), rechaza provider no-stripe,
 *    rechaza displayName duplicado, persiste fila VERIFIED + guarda secret.
 *  - reconcile: separa matched/unmatched con email normalizado (incluye email
 *    en MAYÚSCULAS para cubrir el bug de normalización), cuenta los sin email,
 *    propaga truncated.
 *  - verifyConnection: ok → VERIFIED; fallo → ERROR persistido + throw.
 *  - disconnectConnection: borra fila + secret.
 *  - listConnections: solo del tenant.
 *  - findUserSubscriptions: agrega matches por email de las conexiones VERIFIED,
 *    salta no-VERIFIED y adapters sin el método, aísla fallos (failures) y
 *    normaliza el email.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PaymentConnectionsService,
  normalizeEmail,
  classifySubscriptionStatus,
  type ConfigPort,
  type UserDirectoryPort,
  type DidactaUserRecord,
  type PaymentCredentials,
} from '../src/payment-connections.service.js';
import {
  PaymentConnectionAlreadyExistsError,
  PaymentConnectionNotFoundError,
  PaymentConnectionProviderNotSupportedError,
  PaymentPortalUnavailableError,
  StripeReadKeyInvalidError,
} from '../src/errors.js';
import type { StripeReadAdapter, StripeSubscriberRecord } from '../src/stripe-reader.client.js';

// ---------- Mocks ----------

interface ConnectionRow {
  id: string;
  tenantId: string;
  provider: string;
  displayName: string;
  status: string;
  publicMetadata: unknown;
  lastVerifiedAt: Date | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Filtro in-memory que cubre los operadores que usa el servicio (eq, null, not, lt, contains). */
function matchWhere(r: Record<string, unknown>, w: Record<string, unknown>): boolean {
  for (const [k, cond] of Object.entries(w)) {
    const v = r[k];
    if (cond === null) {
      if (v !== null && v !== undefined) return false;
    } else if (cond && typeof cond === 'object') {
      const c = cond as Record<string, unknown>;
      if ('not' in c && v === c['not']) return false;
      if ('lt' in c && !(v instanceof Date && v < (c['lt'] as Date))) return false;
      if ('lte' in c && !(v instanceof Date && v <= (c['lte'] as Date))) return false;
      if ('gt' in c && !(v instanceof Date && v > (c['gt'] as Date))) return false;
      if ('contains' in c && !String(v ?? '').includes(String(c['contains']))) return false;
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}

class MockPrisma {
  rows = new Map<string, ConnectionRow>();
  subscribers = new Map<string, Record<string, unknown>>();
  history = new Map<string, Record<string, unknown>>();
  private seq = 0;

  modPaymentConnectionsSubscriber = {
    upsert: async (args: {
      where: { tenantId_connectionId_subscriptionId: Record<string, string> };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const { tenantId, connectionId, subscriptionId } =
        args.where.tenantId_connectionId_subscriptionId;
      const key = `${tenantId}::${connectionId}::${subscriptionId}`;
      const existing = this.subscribers.get(key);
      if (existing) {
        Object.assign(existing, args.update, { updatedAt: new Date() });
        return { ...existing };
      }
      this.seq += 1;
      const row = {
        id: `subr_${this.seq}`,
        renewalUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...args.create,
      };
      this.subscribers.set(key, row);
      return { ...row };
    },
    findMany: async (args: { where?: Record<string, unknown>; take?: number; skip?: number }) => {
      const out = [...this.subscribers.values()].filter((r) => matchWhere(r, args.where ?? {}));
      const skip = args.skip ?? 0;
      const take = args.take ?? out.length;
      return out.slice(skip, skip + take).map((r) => ({ ...r }));
    },
    count: async (args: { where?: Record<string, unknown> }) =>
      [...this.subscribers.values()].filter((r) => matchWhere(r, args.where ?? {})).length,
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const r of this.subscribers.values()) {
        if (matchWhere(r, args.where)) {
          Object.assign(r, args.data);
          count += 1;
        }
      }
      return { count };
    },
    groupBy: async (args: { by: string[]; where?: Record<string, unknown> }) => {
      const field = args.by[0]!;
      const rows = [...this.subscribers.values()].filter((r) => matchWhere(r, args.where ?? {}));
      const m = new Map<unknown, number>();
      for (const r of rows) m.set(r[field], (m.get(r[field]) ?? 0) + 1);
      return [...m.entries()].map(([k, v]) => ({ [field]: k, _count: { _all: v } }));
    },
    findFirst: async (args: { where?: Record<string, unknown> }) => {
      const out = [...this.subscribers.values()].filter((r) => matchWhere(r, args.where ?? {}));
      return out[0] ? { ...out[0] } : null;
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      for (const r of this.subscribers.values()) {
        if (r['id'] === args.where.id) {
          Object.assign(r, args.data, { updatedAt: new Date() });
          return { ...r };
        }
      }
      throw new Error('subscriber not found');
    },
  };

  modPaymentConnectionsSyncHistory = {
    create: async (args: { data: Record<string, unknown> }) => {
      this.seq += 1;
      const row = { id: `sh_${this.seq}`, startedAt: new Date(), completedAt: null, ...args.data };
      this.history.set(row.id as string, row);
      return { ...row };
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.history.get(args.where.id);
      if (row) Object.assign(row, args.data);
      return { ...(row ?? {}) };
    },
    findFirst: async (args: { where?: Record<string, unknown> }) => {
      const rows = [...this.history.values()].filter((r) => matchWhere(r, args.where ?? {}));
      rows.sort(
        (a, b) =>
          ((b['completedAt'] as Date)?.getTime() ?? 0) -
          ((a['completedAt'] as Date)?.getTime() ?? 0),
      );
      return rows[0] ? { ...rows[0] } : null;
    },
  };

  modPaymentConnectionsConnection = {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const w = args.where;
      for (const r of this.rows.values()) {
        const idOk = !w['id'] || r.id === w['id'];
        const tenantOk = !w['tenantId'] || r.tenantId === w['tenantId'];
        const providerOk = !w['provider'] || r.provider === w['provider'];
        const nameOk = !w['displayName'] || r.displayName === w['displayName'];
        if (idOk && tenantOk && providerOk && nameOk) return { ...r };
      }
      return null;
    },
    findMany: async (args: { where?: Record<string, unknown>; distinct?: string[] }) => {
      const w = args.where ?? {};
      let out = [...this.rows.values()].filter(
        (r) =>
          (!w['tenantId'] || r.tenantId === w['tenantId']) &&
          (!w['status'] || r.status === w['status']),
      );
      out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (args.distinct?.includes('tenantId')) {
        const seen = new Set<string>();
        out = out.filter((r) => (seen.has(r.tenantId) ? false : (seen.add(r.tenantId), true)));
      }
      return out.map((r) => ({ ...r }));
    },
    create: async (args: { data: Record<string, unknown> }) => {
      this.seq += 1;
      const now = new Date();
      const row: ConnectionRow = {
        id: `conn_${this.seq}`,
        tenantId: args.data['tenantId'] as string,
        provider: args.data['provider'] as string,
        displayName: args.data['displayName'] as string,
        status: (args.data['status'] as string) ?? 'PENDING',
        publicMetadata: args.data['publicMetadata'] ?? null,
        lastVerifiedAt: (args.data['lastVerifiedAt'] as Date) ?? null,
        lastSyncedAt: null,
        lastError: null,
        lastErrorAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.set(row.id, row);
      return { ...row };
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.rows.get(args.where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, args.data, { updatedAt: new Date() });
      return { ...row };
    },
    delete: async (args: { where: { id: string } }) => {
      const row = this.rows.get(args.where.id);
      this.rows.delete(args.where.id);
      return row ? { ...row } : null;
    },
  };
}

class MockConfig implements ConfigPort {
  store = new Map<string, unknown>();
  private k(t: string, m: string, key: string) {
    return `${t}::${m}::${key}`;
  }
  async get<T>(tenantId: string, moduleName: string, key: string): Promise<T | undefined> {
    return this.store.get(this.k(tenantId, moduleName, key)) as T | undefined;
  }
  async set<T>(tenantId: string, moduleName: string, key: string, value: T): Promise<void> {
    this.store.set(this.k(tenantId, moduleName, key), value);
  }
  async delete(tenantId: string, moduleName: string, key: string): Promise<void> {
    this.store.delete(this.k(tenantId, moduleName, key));
  }
}

const TENANT = '11111111-1111-1111-1111-111111111111';
const VALID_KEY = 'rk_test_valid';
const BAD_KEY = 'rk_test_bad';

const SUBSCRIBERS: StripeSubscriberRecord[] = [
  // Email en MAYÚSCULAS: debe casar con el usuario 'match@x.com' tras normalizar.
  sub('sub_1', 'Match@X.com', 'active'),
  sub('sub_2', 'nobody@x.com', 'active'),
  sub('sub_3', null, 'trialing'),
];

function sub(id: string, email: string | null, status: string): StripeSubscriberRecord {
  return {
    subscriptionId: id,
    status,
    customerId: `cus_${id}`,
    email,
    name: email ? email.split('@')[0]! : null,
    priceId: 'price_1',
    productId: 'prod_1',
    productName: 'Plan Pro',
    unitAmount: 1999,
    currency: 'eur',
    interval: 'month',
    currentPeriodEnd: 1900000000,
    created: 1800000000,
  };
}

function makeAdapter(opts: { truncated?: boolean } = {}): StripeReadAdapter {
  return {
    retrieveAccount: async () => ({
      id: 'acct_123',
      email: 'owner@x.com',
      country: 'ES',
      businessName: 'Mi Academia',
    }),
    listActiveSubscriptions: async () => ({
      subscribers: SUBSCRIBERS,
      truncated: opts.truncated ?? false,
    }),
  };
}

function badAdapter(): StripeReadAdapter {
  return {
    retrieveAccount: async () => {
      throw new StripeReadKeyInvalidError('Invalid API Key provided');
    },
    listActiveSubscriptions: async () => ({ subscribers: [], truncated: false }),
  };
}

const users: UserDirectoryPort = {
  async findByNormalizedEmails(_tenantId: string, emails: string[]): Promise<DidactaUserRecord[]> {
    const known: DidactaUserRecord = {
      id: 'user_1',
      email: 'match@x.com',
      name: 'Persona Match',
      status: 'ACTIVE',
      avatarUrl: null,
    };
    return emails.includes('match@x.com') ? [known] : [];
  },
};

function buildService(adapterOverrides?: Record<string, StripeReadAdapter>) {
  const prisma = new MockPrisma();
  const config = new MockConfig();
  const adapters: Record<string, StripeReadAdapter> = adapterOverrides ?? {
    [VALID_KEY]: makeAdapter(),
    [BAD_KEY]: badAdapter(),
  };
  const factory = (_provider: string, credentials: PaymentCredentials): StripeReadAdapter =>
    adapters[(credentials as { apiKey?: string }).apiKey ?? ''] ?? badAdapter();
  const service = new PaymentConnectionsService(prisma as never, config, factory, users);
  return { service, prisma, config };
}

// ---------- Tests ----------

describe('normalizeEmail', () => {
  it('baja a minúsculas y recorta; null/empty → null', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });
});

describe('addConnection', () => {
  let svc: ReturnType<typeof buildService>;
  beforeEach(() => {
    svc = buildService();
  });

  it('valida la key, persiste VERIFIED y guarda el secret cifrado aparte', async () => {
    const row = await svc.service.addConnection({
      tenantId: TENANT,
      actorId: 'admin_1',
      provider: 'stripe',
      displayName: 'Stripe ES',
      credentials: { apiKey: VALID_KEY },
    });
    expect(row.status).toBe('VERIFIED');
    expect((row.publicMetadata as { accountId: string }).accountId).toBe('acct_123');
    // El secret NO está en la fila; está en config bajo la key derivada.
    const creds = await svc.config.get(
      TENANT,
      'payment-connections',
      `stripe:${row.id}:credentials`,
    );
    expect(creds).toEqual({ apiKey: VALID_KEY });
  });

  it('rechaza una key inválida (no crea fila)', async () => {
    await expect(
      svc.service.addConnection({
        tenantId: TENANT,
        actorId: null,
        provider: 'stripe',
        displayName: 'Stripe Malo',
        credentials: { apiKey: BAD_KEY },
      }),
    ).rejects.toBeInstanceOf(StripeReadKeyInvalidError);
    expect(svc.prisma.rows.size).toBe(0);
  });

  it('rechaza un provider no soportado', async () => {
    await expect(
      svc.service.addConnection({
        tenantId: TENANT,
        actorId: null,
        provider: 'mercadopago',
        displayName: 'Mercado Pago',
        credentials: { apiKey: 'whatever' },
      }),
    ).rejects.toBeInstanceOf(PaymentConnectionProviderNotSupportedError);
  });

  it('rechaza displayName duplicado en el mismo tenant', async () => {
    await svc.service.addConnection({
      tenantId: TENANT,
      actorId: null,
      provider: 'stripe',
      displayName: 'Stripe ES',
      credentials: { apiKey: VALID_KEY },
    });
    await expect(
      svc.service.addConnection({
        tenantId: TENANT,
        actorId: null,
        provider: 'stripe',
        displayName: 'Stripe ES',
        credentials: { apiKey: VALID_KEY },
      }),
    ).rejects.toBeInstanceOf(PaymentConnectionAlreadyExistsError);
  });
});

describe('reconcile', () => {
  it('separa matched/unmatched con email normalizado y cuenta los sin email', async () => {
    const svc = buildService();
    const row = await svc.service.addConnection({
      tenantId: TENANT,
      actorId: null,
      provider: 'stripe',
      displayName: 'Stripe ES',
      credentials: { apiKey: VALID_KEY },
    });
    const res = await svc.service.reconcile(TENANT, row.id);

    expect(res.counts.total).toBe(3);
    expect(res.counts.matched).toBe(1);
    expect(res.counts.unmatched).toBe(2);
    expect(res.counts.withoutEmail).toBe(1);
    // El sub con email en MAYÚSCULAS casa con el usuario Didacta.
    expect(res.matched[0]!.subscription.subscriptionId).toBe('sub_1');
    expect(res.matched[0]!.user.id).toBe('user_1');
    // lastSyncedAt quedó estampado.
    expect(svc.prisma.rows.get(row.id)!.lastSyncedAt).toBeInstanceOf(Date);
  });

  it('propaga truncated cuando se alcanza el tope de páginas', async () => {
    const svc = buildService({ [VALID_KEY]: makeAdapter({ truncated: true }) });
    const row = await svc.service.addConnection({
      tenantId: TENANT,
      actorId: null,
      provider: 'stripe',
      displayName: 'Stripe Grande',
      credentials: { apiKey: VALID_KEY },
    });
    const res = await svc.service.reconcile(TENANT, row.id);
    expect(res.truncated).toBe(true);
  });
});

describe('verifyConnection', () => {
  it('ok → VERIFIED; key rota → ERROR persistido + throw', async () => {
    const prisma = new MockPrisma();
    const config = new MockConfig();
    // Adapter que primero valida (add) y luego falla (verify), según la key.
    const adapters: Record<string, StripeReadAdapter> = {
      [VALID_KEY]: makeAdapter(),
    };
    const factory = (_provider: string, credentials: PaymentCredentials): StripeReadAdapter =>
      adapters[(credentials as { apiKey?: string }).apiKey ?? ''] ?? badAdapter();
    const service = new PaymentConnectionsService(prisma as never, config, factory, users);

    const row = await service.addConnection({
      tenantId: TENANT,
      actorId: null,
      provider: 'stripe',
      displayName: 'Stripe ES',
      credentials: { apiKey: VALID_KEY },
    });
    const ok = await service.verifyConnection(TENANT, row.id, null);
    expect(ok.status).toBe('VERIFIED');

    // Ahora la cuenta deja de validar: el adapter de VALID_KEY pasa a fallar.
    adapters[VALID_KEY] = badAdapter();
    await expect(service.verifyConnection(TENANT, row.id, null)).rejects.toBeInstanceOf(
      StripeReadKeyInvalidError,
    );
    expect(prisma.rows.get(row.id)!.status).toBe('ERROR');
    expect(prisma.rows.get(row.id)!.lastError).toBeTruthy();
  });
});

describe('disconnectConnection', () => {
  it('borra la fila y el secret', async () => {
    const svc = buildService();
    const row = await svc.service.addConnection({
      tenantId: TENANT,
      actorId: null,
      provider: 'stripe',
      displayName: 'Stripe ES',
      credentials: { apiKey: VALID_KEY },
    });
    await svc.service.disconnectConnection(TENANT, row.id, null);
    expect(svc.prisma.rows.size).toBe(0);
    expect(
      await svc.config.get(TENANT, 'payment-connections', `stripe:${row.id}:credentials`),
    ).toBeUndefined();
  });
});

describe('findUserSubscriptions', () => {
  const FLAKY_KEY = 'rk_test_flaky';
  const SUB_PAID = sub('sub_paid', 'buyer@x.com', 'active'); // planName 'Plan Pro', 1999 eur

  /** Adapter de lectura con (o sin) findSubscriptionsByEmail; valida en el add. */
  function emailAdapter(
    find?: (email: string) => Promise<StripeSubscriberRecord[]>,
  ): StripeReadAdapter {
    const base: StripeReadAdapter = {
      retrieveAccount: async () => ({ id: 'acct', email: null, country: null, businessName: null }),
      listActiveSubscriptions: async () => ({ subscribers: [], truncated: false }),
    };
    return find ? { ...base, findSubscriptionsByEmail: find } : base;
  }

  async function addStripe(svc: ReturnType<typeof buildService>, displayName: string, key: string) {
    return svc.service.addConnection({
      tenantId: TENANT,
      actorId: null,
      provider: 'stripe',
      displayName,
      credentials: { apiKey: key },
    });
  }

  it('agrega los matches de una conexión VERIFIED y mapea los campos (email normalizado)', async () => {
    const find = vi.fn(async (_email: string) => [SUB_PAID]);
    const svc = buildService({ [VALID_KEY]: emailAdapter(find) });
    const row = await addStripe(svc, 'Stripe ES', VALID_KEY);

    const { matches, failures } = await svc.service.findUserSubscriptions(TENANT, 'BUYER@x.com');

    expect(failures).toEqual([]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      provider: 'stripe',
      connectionId: row.id,
      connectionName: 'Stripe ES',
      planName: 'Plan Pro',
      status: 'active',
      unitAmount: 1999,
      currency: 'eur',
      subscriptionId: 'sub_paid',
    });
    // El email se normaliza (minúsculas + trim) antes de pasarlo al adapter.
    expect(find).toHaveBeenCalledWith('buyer@x.com');
  });

  it('salta las conexiones que no están VERIFIED (no las consulta)', async () => {
    const find = vi.fn(async () => [SUB_PAID]);
    const svc = buildService({ [VALID_KEY]: emailAdapter(find) });
    const row = await addStripe(svc, 'Stripe ES', VALID_KEY);
    svc.prisma.rows.get(row.id)!.status = 'PENDING'; // ya no VERIFIED

    const { matches, failures } = await svc.service.findUserSubscriptions(TENANT, 'buyer@x.com');

    expect(matches).toEqual([]);
    expect(failures).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });

  it('salta los adapters sin findSubscriptionsByEmail sin romper ni registrar fallo', async () => {
    const svc = buildService({ [VALID_KEY]: emailAdapter() }); // sin método
    await addStripe(svc, 'Stripe ES', VALID_KEY);

    const res = await svc.service.findUserSubscriptions(TENANT, 'buyer@x.com');

    expect(res).toEqual({ matches: [], failures: [] });
  });

  it('una conexión caída no tumba el lookup: registra el fallo y sigue con las demás', async () => {
    const good = vi.fn(async () => [SUB_PAID]);
    const svc = buildService({
      [VALID_KEY]: emailAdapter(good),
      [FLAKY_KEY]: emailAdapter(async () => {
        throw new Error('cuenta caída');
      }),
    });
    await addStripe(svc, 'Buena', VALID_KEY);
    await addStripe(svc, 'Caída', FLAKY_KEY);

    const { matches, failures } = await svc.service.findUserSubscriptions(TENANT, 'buyer@x.com');

    expect(matches).toHaveLength(1);
    expect(matches[0]!.connectionName).toBe('Buena');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ provider: 'stripe', connectionName: 'Caída' });
    expect(failures[0]!.message).toContain('cuenta caída');
  });

  it('email vacío → resultado vacío sin consultar ninguna cuenta', async () => {
    const find = vi.fn(async () => [SUB_PAID]);
    const svc = buildService({ [VALID_KEY]: emailAdapter(find) });
    await addStripe(svc, 'Stripe ES', VALID_KEY);

    const res = await svc.service.findUserSubscriptions(TENANT, '   ');

    expect(res).toEqual({ matches: [], failures: [] });
    expect(find).not.toHaveBeenCalled();
  });
});

/**
 * Compras PUNTUALES: el caso de los "accesos lifetime" vendidos en su día, que
 * no dejan ninguna suscripción viva. Sin esto el aprobador ve "sin suscripción"
 * y rechaza a un cliente que sí pagó.
 */
describe('findUserPurchases', () => {
  const FLAKY_KEY = 'rk_test_flaky_p';
  const ORDER = {
    orderId: '8801',
    orderNumber: '8801',
    status: 'completed',
    total: 99_700,
    currency: 'EUR',
    createdAt: '2023-04-11T09:15:00Z',
    products: ['Acceso Lifetime'],
  };

  /** Adapter con (o sin) findPurchasesByEmail; valida en el add. */
  function purchaseAdapter(find?: (email: string) => Promise<(typeof ORDER)[]>): StripeReadAdapter {
    const base: StripeReadAdapter = {
      retrieveAccount: async () => ({ id: 'acct', email: null, country: null, businessName: null }),
      listActiveSubscriptions: async () => ({ subscribers: [], truncated: false }),
    };
    return find ? { ...base, findPurchasesByEmail: find } : base;
  }

  async function addConn(svc: ReturnType<typeof buildService>, displayName: string, key: string) {
    return svc.service.addConnection({
      tenantId: TENANT,
      actorId: null,
      provider: 'stripe',
      displayName,
      credentials: { apiKey: key },
    });
  }

  it('agrega las compras de una conexión VERIFIED con el email normalizado', async () => {
    const find = vi.fn(async (_email: string) => [ORDER]);
    const svc = buildService({ [VALID_KEY]: purchaseAdapter(find) });
    const row = await addConn(svc, 'Woo Demo', VALID_KEY);

    const { purchases, failures } = await svc.service.findUserPurchases(TENANT, ' BUYER@x.com ');

    expect(failures).toEqual([]);
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({
      connectionId: row.id,
      connectionName: 'Woo Demo',
      orderId: '8801',
      status: 'completed',
      total: 99_700,
      products: ['Acceso Lifetime'],
    });
    expect(find).toHaveBeenCalledWith('buyer@x.com');
  });

  it('ordena las compras de más reciente a más antigua', async () => {
    const OLD = { ...ORDER, orderId: '7000', createdAt: '2021-01-02T00:00:00Z' };
    const svc = buildService({ [VALID_KEY]: purchaseAdapter(async () => [OLD, ORDER]) });
    await addConn(svc, 'Woo', VALID_KEY);

    const { purchases } = await svc.service.findUserPurchases(TENANT, 'buyer@x.com');

    expect(purchases.map((p) => p.orderId)).toEqual(['8801', '7000']);
  });

  it('salta los proveedores sin findPurchasesByEmail (Stripe/PayPal) sin registrar fallo', async () => {
    const svc = buildService({ [VALID_KEY]: purchaseAdapter() });
    await addConn(svc, 'Stripe ES', VALID_KEY);

    await expect(svc.service.findUserPurchases(TENANT, 'buyer@x.com')).resolves.toEqual({
      purchases: [],
      failures: [],
    });
  });

  it('salta las conexiones que no están VERIFIED', async () => {
    const find = vi.fn(async () => [ORDER]);
    const svc = buildService({ [VALID_KEY]: purchaseAdapter(find) });
    const row = await addConn(svc, 'Woo', VALID_KEY);
    svc.prisma.rows.get(row.id)!.status = 'PENDING';

    const { purchases } = await svc.service.findUserPurchases(TENANT, 'buyer@x.com');

    expect(purchases).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });

  it('una tienda caída no tumba el lookup: registra el fallo y sigue', async () => {
    const svc = buildService({
      [VALID_KEY]: purchaseAdapter(async () => [ORDER]),
      [FLAKY_KEY]: purchaseAdapter(async () => {
        throw new Error('tienda caída');
      }),
    });
    await addConn(svc, 'Buena', VALID_KEY);
    await addConn(svc, 'Caída', FLAKY_KEY);

    const { purchases, failures } = await svc.service.findUserPurchases(TENANT, 'buyer@x.com');

    expect(purchases).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toContain('tienda caída');
  });

  it('email vacío → vacío sin consultar ninguna cuenta', async () => {
    const find = vi.fn(async () => [ORDER]);
    const svc = buildService({ [VALID_KEY]: purchaseAdapter(find) });
    await addConn(svc, 'Woo', VALID_KEY);

    await expect(svc.service.findUserPurchases(TENANT, '   ')).resolves.toEqual({
      purchases: [],
      failures: [],
    });
    expect(find).not.toHaveBeenCalled();
  });
});

describe('resolveRenewalUrlByRef', () => {
  /** Adapter que valida en el add y, opcionalmente, resuelve la factura abierta. */
  function invoiceAdapter(open?: (subId: string) => Promise<string | null>): StripeReadAdapter {
    const base: StripeReadAdapter = {
      retrieveAccount: async () => ({ id: 'acct', email: null, country: null, businessName: null }),
      listActiveSubscriptions: async () => ({ subscribers: [], truncated: false }),
    };
    return open ? { ...base, readOpenInvoiceUrl: open } : base;
  }

  async function addStripeConn(svc: ReturnType<typeof buildService>) {
    return svc.service.addConnection({
      tenantId: TENANT,
      actorId: null,
      provider: 'stripe',
      displayName: 'Stripe ES',
      credentials: { apiKey: VALID_KEY },
    });
  }

  it('Stripe: devuelve el hosted_invoice_url de la factura abierta de la suscripción', async () => {
    const open = vi.fn(async (subId: string) => `https://invoice.stripe.com/i/${subId}`);
    const svc = buildService({ [VALID_KEY]: invoiceAdapter(open) });
    const conn = await addStripeConn(svc);

    const url = await svc.service.resolveRenewalUrlByRef(TENANT, conn.id, 'stripe', 'sub_9');

    expect(url).toBe('https://invoice.stripe.com/i/sub_9');
    expect(open).toHaveBeenCalledWith('sub_9');
  });

  it('provider no-stripe → null sin cargar credenciales ni adapter', async () => {
    const svc = buildService();
    expect(
      await svc.service.resolveRenewalUrlByRef(TENANT, 'conn_x', 'paypal', 'sub_9'),
    ).toBeNull();
  });

  it('Stripe sin readOpenInvoiceUrl en el adapter → null', async () => {
    const svc = buildService({ [VALID_KEY]: invoiceAdapter() });
    const conn = await addStripeConn(svc);
    expect(await svc.service.resolveRenewalUrlByRef(TENANT, conn.id, 'stripe', 'sub_9')).toBeNull();
  });

  it('si el adapter lanza, degrada a null (best-effort, no rompe el envío)', async () => {
    const svc = buildService({
      [VALID_KEY]: invoiceAdapter(async () => {
        throw new Error('stripe caído');
      }),
    });
    const conn = await addStripeConn(svc);
    expect(await svc.service.resolveRenewalUrlByRef(TENANT, conn.id, 'stripe', 'sub_9')).toBeNull();
  });
});

/**
 * Tabla CANÓNICA de clasificación de estados. Es el contrato compartido entre la
 * copia backend (este módulo) y la copia web (apps/web/src/lib/payment-connections.ts,
 * que NO puede importar el módulo). El mismo objeto se asserta en el test web; si
 * cualquiera de las dos copias diverge, su test falla → guardia de paridad.
 */
export const SUBSCRIPTION_STATUS_TABLE: Record<
  string,
  { category: string; label: string; entitled: boolean }
> = {
  active: { category: 'active', label: 'Activa', entitled: true },
  trialing: { category: 'active', label: 'En prueba', entitled: true },
  past_due: { category: 'past_due', label: 'Pago atrasado (impago)', entitled: true },
  unpaid: { category: 'unpaid', label: 'Impago — suspendida', entitled: false },
  'on-hold': { category: 'past_due', label: 'En espera (impago)', entitled: true },
  paused: { category: 'paused', label: 'Pausada', entitled: false },
  'pending-cancel': { category: 'canceled', label: 'Baja programada', entitled: true },
  canceled: { category: 'canceled', label: 'Dada de baja', entitled: false },
  cancelled: { category: 'canceled', label: 'Dada de baja', entitled: false },
  expired: { category: 'canceled', label: 'Expirada', entitled: false },
  incomplete: { category: 'incomplete', label: 'Pago no completado', entitled: false },
  incomplete_expired: { category: 'incomplete', label: 'Pago no completado', entitled: false },
  pending: { category: 'incomplete', label: 'Pendiente de pago', entitled: false },
};

describe('classifySubscriptionStatus', () => {
  it('respeta la tabla canónica de (category, label, entitled) para cada estado', () => {
    for (const [status, expected] of Object.entries(SUBSCRIPTION_STATUS_TABLE)) {
      expect({ status, ...classifySubscriptionStatus(status) }).toEqual({ status, ...expected });
    }
  });

  it('on-hold (WooCommerce) es vigente igual que past_due, para no contradecir al sync de tiers', () => {
    // WC_ACTIVE_STATUSES incluye on-hold → la reconciliación la trata como suscrita.
    expect(classifySubscriptionStatus('on-hold').entitled).toBe(true);
    expect(classifySubscriptionStatus('on-hold').label).toContain('impago');
  });

  it('es tolerante con mayúsculas/espacios y cae a "Desconocido" si no lo reconoce', () => {
    expect(classifySubscriptionStatus('  ACTIVE ').entitled).toBe(true);
    const unknown = classifySubscriptionStatus('rarísimo');
    expect(unknown.category).toBe('unknown');
    expect(unknown.entitled).toBe(false);
    expect(unknown.label).toBe('rarísimo');
  });

  // ── El idioma, que llegó con el email de decisión al aprobador ────────────
  // Esta función es el ESPEJO del enum del backend, no copy de pantalla, y sus
  // tres consumidores de siempre (el sync de suscriptores, `getMySubscription`
  // y el espejo del front) la llaman con un solo argumento. El idioma es
  // opcional para que ninguno de ellos cambie.

  it('sin idioma sigue devolviendo el español, byte a byte', () => {
    for (const [status, expected] of Object.entries(SUBSCRIPTION_STATUS_TABLE)) {
      expect(classifySubscriptionStatus(status)).toEqual(classifySubscriptionStatus(status, 'es'));
      expect(classifySubscriptionStatus(status).label).toBe(expected.label);
    }
  });

  it('en inglés cambia SOLO la etiqueta: categoría y `entitled` son los mismos', () => {
    for (const status of Object.keys(SUBSCRIPTION_STATUS_TABLE)) {
      const es = classifySubscriptionStatus(status, 'es');
      const en = classifySubscriptionStatus(status, 'en');
      expect(en.category, status).toBe(es.category);
      expect(en.entitled, status).toBe(es.entitled);
      expect(en.label, `${status} sin traducir`).not.toBe(es.label);
      expect(en.label.trim().length, status).toBeGreaterThan(0);
    }
  });

  it('CAMINO DEGRADADO: un estado desconocido pinta el valor CRUDO en los dos idiomas', () => {
    // Nunca un identificador interno: ante un estado nuevo del proveedor, al
    // aprobador le sirve más «paused_indefinitely» que «Unknown».
    for (const lang of ['es', 'en'] as const) {
      expect(classifySubscriptionStatus('paused_indefinitely', lang).label).toBe(
        'paused_indefinitely',
      );
    }
    // Y con el status vacío sí gana la etiqueta, en su idioma.
    expect(classifySubscriptionStatus('', 'es').label).toBe('Desconocido');
    expect(classifySubscriptionStatus('', 'en').label).toBe('Unknown');
  });
});

describe('listConnections', () => {
  it('devuelve solo las del tenant, más recientes primero', async () => {
    const svc = buildService();
    await svc.service.addConnection({
      tenantId: TENANT,
      actorId: null,
      provider: 'stripe',
      displayName: 'A',
      credentials: { apiKey: VALID_KEY },
    });
    await svc.service.addConnection({
      tenantId: TENANT,
      actorId: null,
      provider: 'stripe',
      displayName: 'B',
      credentials: { apiKey: VALID_KEY },
    });
    const list = await svc.service.listConnections(TENANT);
    expect(list.length).toBe(2);
  });
});

describe('dashboard: syncSubscribers / listSubscribers / subscriberSummary', () => {
  async function setup(adapter?: StripeReadAdapter) {
    const svc = buildService(adapter ? { [VALID_KEY]: adapter } : undefined);
    await svc.service.addConnection({
      tenantId: TENANT,
      actorId: null,
      provider: 'stripe',
      displayName: 'Stripe ES',
      credentials: { apiKey: VALID_KEY },
    });
    return svc;
  }

  it('materializa matched + unmatched y registra el SyncHistory', async () => {
    const svc = await setup();
    const r = await svc.service.syncSubscribers(TENANT);
    expect(r).toMatchObject({ connections: 1, upserted: 3, markedGone: 0, failures: [] });
    const { rows, total } = await svc.service.listSubscribers(TENANT);
    expect(total).toBe(3);
    expect(rows.filter((x) => x.userId === 'user_1')).toHaveLength(1); // sub_1 matched
    expect(rows.filter((x) => x.userId === null)).toHaveLength(2); // sub_2/sub_3 unmatched
  });

  it('listSubscribers filtra onlyUnmatched y por provider', async () => {
    const svc = await setup();
    await svc.service.syncSubscribers(TENANT);
    expect((await svc.service.listSubscribers(TENANT, { onlyUnmatched: true })).total).toBe(2);
    expect((await svc.service.listSubscribers(TENANT, { provider: 'stripe' })).total).toBe(3);
    expect((await svc.service.listSubscribers(TENANT, { provider: 'paypal' })).total).toBe(0);
  });

  it('subscriberSummary cuenta por categoría/proveedor + última corrida', async () => {
    const svc = await setup();
    await svc.service.syncSubscribers(TENANT);
    const s = await svc.service.subscriberSummary(TENANT);
    expect(s.total).toBe(3);
    expect(s.byCategory['active']).toBe(3); // active + trialing → categoría 'active'
    expect(s.byProvider['stripe']).toBe(3);
    expect(s.lastSyncStatus).toBe('success');
    expect(s.lastSyncedAt).toBeInstanceOf(Date);
  });

  it('churn: un suscriptor que desaparece se marca baja (si no vino truncado)', async () => {
    let only = false;
    const adapter: StripeReadAdapter = {
      retrieveAccount: async () => ({ id: 'acct', email: null, country: null, businessName: null }),
      listActiveSubscriptions: async () => ({
        subscribers: only ? [SUBSCRIBERS[0]!] : SUBSCRIBERS,
        truncated: false,
      }),
    };
    const svc = await setup(adapter);
    await svc.service.syncSubscribers(TENANT);
    await new Promise((r) => setTimeout(r, 5)); // garantiza now2 > now1 para el churn
    only = true;
    const r2 = await svc.service.syncSubscribers(TENANT);
    expect(r2.markedGone).toBe(2); // sub_2 y sub_3 desaparecen → baja
    const canceled = await svc.service.listSubscribers(TENANT, { statusCategory: 'canceled' });
    expect(canceled.total).toBe(2);
    expect(canceled.rows.every((x) => x.entitled === false)).toBe(true);
  });

  it('no marca baja si la conexión vino truncada (no se listaron todos)', async () => {
    let trunc = false;
    const adapter: StripeReadAdapter = {
      retrieveAccount: async () => ({ id: 'acct', email: null, country: null, businessName: null }),
      listActiveSubscriptions: async () => ({
        subscribers: trunc ? [SUBSCRIBERS[0]!] : SUBSCRIBERS,
        truncated: trunc,
      }),
    };
    const svc = await setup(adapter);
    await svc.service.syncSubscribers(TENANT);
    await new Promise((r) => setTimeout(r, 5));
    trunc = true; // 2ª corrida truncada con solo 1 sub → NO debe marcar bajas
    const r2 = await svc.service.syncSubscribers(TENANT);
    expect(r2.markedGone).toBe(0);
    expect((await svc.service.listSubscribers(TENANT, { statusCategory: 'active' })).total).toBe(3);
  });

  it('getSubscriber + resolveRenewalUrl (Stripe) cachea el hosted_invoice_url', async () => {
    const adapter: StripeReadAdapter = {
      retrieveAccount: async () => ({ id: 'acct', email: null, country: null, businessName: null }),
      listActiveSubscriptions: async () => ({
        subscribers: [sub('sub_pd', 'pd@x.com', 'past_due')],
        truncated: false,
      }),
      readOpenInvoiceUrl: async (subId) =>
        subId === 'sub_pd' ? 'https://invoice.example/pay' : null,
    };
    const svc = await setup(adapter);
    await svc.service.syncSubscribers(TENANT);
    const { rows } = await svc.service.listSubscribers(TENANT);
    const row = rows[0]!;
    expect((await svc.service.getSubscriber(TENANT, row.id))?.subscriptionId).toBe('sub_pd');
    expect(await svc.service.resolveRenewalUrl(TENANT, row.id)).toBe('https://invoice.example/pay');
    // Quedó cacheado en la fila.
    expect((await svc.service.getSubscriber(TENANT, row.id))?.renewalUrl).toBe(
      'https://invoice.example/pay',
    );
  });

  it('plantilla de renovación: default y personalizada', async () => {
    const svc = buildService();
    const def = await svc.service.getRenewalTemplate(TENANT);
    expect(def.subject).toBeTruthy();
    expect(def.body).toContain('{enlace}');
    await svc.service.setRenewalTemplate(
      TENANT,
      { subject: 'Hola', body: 'Renueva {enlace}' },
      'admin',
    );
    expect(await svc.service.getRenewalTemplate(TENANT)).toEqual({
      subject: 'Hola',
      body: 'Renueva {enlace}',
    });
  });

  it('listPlanCatalogLabels trae los planes del catálogo (parte B, dedup)', async () => {
    const adapter: StripeReadAdapter = {
      retrieveAccount: async () => ({ id: 'acct', email: null, country: null, businessName: null }),
      listActiveSubscriptions: async () => ({ subscribers: [], truncated: false }),
      listPlanCatalog: async () => ['Plan A', 'Cohorte Vacía', 'Plan A'],
    };
    const svc = await setup(adapter);
    const labels = await svc.service.listPlanCatalogLabels(TENANT);
    expect(labels.sort()).toEqual(['Cohorte Vacía', 'Plan A']);
  });

  it('listTenantsWithVerifiedConnections devuelve los tenants con conexión VERIFIED (distinct)', async () => {
    const svc = buildService();
    await svc.service.addConnection({
      tenantId: TENANT,
      actorId: null,
      provider: 'stripe',
      displayName: 'A',
      credentials: { apiKey: VALID_KEY },
    });
    await svc.service.addConnection({
      tenantId: TENANT,
      actorId: null,
      provider: 'stripe',
      displayName: 'B',
      credentials: { apiKey: VALID_KEY },
    });
    // 2 conexiones del mismo tenant → una sola entrada (distinct).
    expect(await svc.service.listTenantsWithVerifiedConnections()).toEqual([TENANT]);
  });
});

describe('me/subscription (self-service del usuario)', () => {
  const BASE_SUB = {
    tenantId: TENANT,
    connectionId: 'conn_me',
    provider: 'stripe',
    subscriptionId: 'sub_me',
    subscriptionCustomerId: 'cus_me',
    userId: 'user_1',
    userEmail: 'u@x.com',
    status: 'active',
    statusCategory: 'active',
    entitled: true,
    productName: 'Plan Pro',
    unitAmount: 1999,
    currency: 'eur',
    interval: 'month',
    currentPeriodEnd: new Date(),
    renewalUrl: null,
  };

  it('getMySubscription: mapea la suscripción externa del usuario y marca manageable (Stripe + customer)', async () => {
    const svc = buildService();
    svc.prisma.subscribers.set('me-1', { id: 'subr_1', ...BASE_SUB });
    const items = await svc.service.getMySubscription(TENANT, 'user_1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'subr_1',
      provider: 'stripe',
      planName: 'Plan Pro',
      status: 'active',
      statusLabel: 'Activa',
      entitled: true,
      manageable: true,
    });
  });

  it('getMySubscription: no expone la suscripción de otro usuario (aislamiento)', async () => {
    const svc = buildService();
    svc.prisma.subscribers.set('me-1', { id: 'subr_1', ...BASE_SUB });
    expect(await svc.service.getMySubscription(TENANT, 'otro_user')).toEqual([]);
  });

  it('getMySubscription: manageable=false si no es Stripe o no hay customer', async () => {
    const svc = buildService();
    svc.prisma.subscribers.set('me-1', {
      id: 'subr_pp',
      ...BASE_SUB,
      provider: 'paypal',
      subscriptionCustomerId: null,
    });
    const items = await svc.service.getMySubscription(TENANT, 'user_1');
    expect(items[0]!.manageable).toBe(false);
  });

  it('createMyBillingPortalSession: abre el Customer Portal de la suscripción del propio usuario', async () => {
    const portalAdapter: StripeReadAdapter = {
      ...makeAdapter(),
      createBillingPortalSession: async (customerId: string, returnUrl: string) =>
        `https://billing.stripe.com/p/${customerId}?ret=${encodeURIComponent(returnUrl)}`,
    };
    const svc = buildService({ [VALID_KEY]: portalAdapter });
    // La credencial de la conexión conn_me apunta a la key con adapter de portal.
    await svc.config.set(TENANT, 'payment-connections', 'stripe:conn_me:credentials', {
      apiKey: VALID_KEY,
    });
    svc.prisma.subscribers.set('me-1', { id: 'subr_1', ...BASE_SUB });

    const url = await svc.service.createMyBillingPortalSession(
      TENANT,
      'user_1',
      'subr_1',
      'https://aula.test/cuenta?tab=suscripcion',
    );
    expect(url).toContain('cus_me');
    expect(url).toContain(encodeURIComponent('https://aula.test/cuenta?tab=suscripcion'));
  });

  it('createMyBillingPortalSession: la suscripción de otro usuario → NotFound (no la abre)', async () => {
    const svc = buildService();
    svc.prisma.subscribers.set('me-1', { id: 'subr_1', ...BASE_SUB });
    await expect(
      svc.service.createMyBillingPortalSession(TENANT, 'otro_user', 'subr_1', 'https://x/cuenta'),
    ).rejects.toBeInstanceOf(PaymentConnectionNotFoundError);
  });

  it('createMyBillingPortalSession: proveedor sin portal (PayPal/Woo) → PortalUnavailable', async () => {
    const svc = buildService();
    svc.prisma.subscribers.set('me-1', { id: 'subr_pp', ...BASE_SUB, provider: 'paypal' });
    await expect(
      svc.service.createMyBillingPortalSession(TENANT, 'user_1', 'subr_pp', 'https://x/cuenta'),
    ).rejects.toBeInstanceOf(PaymentPortalUnavailableError);
  });
});

describe('avisos de suscripción (digest diario + aviso 7 días)', () => {
  const DAY = 24 * 3600 * 1000;
  function make() {
    const built = buildService();
    let i = 0;
    const add = (over: Record<string, unknown>) => {
      i += 1;
      built.prisma.subscribers.set(`seed-${i}`, {
        id: `sub-${i}`,
        tenantId: TENANT,
        connectionId: 'conn',
        provider: 'stripe',
        subscriptionId: `s${i}`,
        userEmail: `u${i}@x.com`,
        entitled: true,
        productName: 'Plan Pro',
        unitAmount: 1999,
        currency: 'eur',
        currentPeriodEnd: null,
        renewalWarnedPeriodEnd: null,
        ...over,
      });
    };
    return { service: built.service, add };
  }

  it('getSubscriptionDigest: cuenta activos y lista solo los de la ventana', async () => {
    const { service, add } = make();
    const in3 = new Date(Date.now() + 3 * DAY);
    add({ currentPeriodEnd: in3 }); // dentro de 7d
    add({ currentPeriodEnd: new Date(Date.now() + 20 * DAY) }); // fuera
    add({ currentPeriodEnd: null }); // activo sin fecha (Woo/PayPal)
    add({ entitled: false, currentPeriodEnd: in3 }); // no activo → no cuenta
    const d = await service.getSubscriptionDigest(TENANT, 7);
    expect(d.activeCount).toBe(3);
    expect(d.upcoming).toHaveLength(1);
    expect(d.upcoming[0]!.currentPeriodEnd.getTime()).toBe(in3.getTime());
  });

  it('listSubscribersToWarn: respeta ventana e idempotencia por periodo', async () => {
    const { service, add } = make();
    const in5 = new Date(Date.now() + 5 * DAY);
    add({ id: 'a', currentPeriodEnd: in5 });
    add({ id: 'b', currentPeriodEnd: in5, renewalWarnedPeriodEnd: in5 }); // ya avisado
    add({ id: 'c', currentPeriodEnd: new Date(Date.now() + 20 * DAY) }); // fuera
    const ids = (await service.listSubscribersToWarn(TENANT, 7)).map((x) => x.id);
    expect(ids).toContain('a');
    expect(ids).not.toContain('b');
    expect(ids).not.toContain('c');
  });

  it('markRenewalWarned deja fuera al suscriptor en el siguiente barrido', async () => {
    const { service, add } = make();
    const in5 = new Date(Date.now() + 5 * DAY);
    add({ id: 'x', currentPeriodEnd: in5 });
    await service.markRenewalWarned('x', in5);
    const ids = (await service.listSubscribersToWarn(TENANT, 7)).map((x) => x.id);
    expect(ids).not.toContain('x');
  });

  it('cancel portal url: set + get (persistente por tenant)', async () => {
    const { service } = make();
    expect(await service.getCancelPortalUrl(TENANT)).toBeNull();
    await service.setCancelPortalUrl(TENANT, 'https://billing.stripe.com/p/login/abc', null);
    expect(await service.getCancelPortalUrl(TENANT)).toBe('https://billing.stripe.com/p/login/abc');
    await service.setCancelPortalUrl(TENANT, null, null);
    expect(await service.getCancelPortalUrl(TENANT)).toBeNull();
  });
});
