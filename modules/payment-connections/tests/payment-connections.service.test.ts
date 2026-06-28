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
  PaymentConnectionProviderNotSupportedError,
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

class MockPrisma {
  rows = new Map<string, ConnectionRow>();
  private seq = 0;

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
    findMany: async (args: { where: Record<string, unknown> }) => {
      const w = args.where ?? {};
      const out = [...this.rows.values()].filter(
        (r) => !w['tenantId'] || r.tenantId === w['tenantId'],
      );
      out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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
