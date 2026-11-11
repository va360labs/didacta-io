/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  PaymentConnectionsService,
  PaymentTiersService,
  type PaymentReadAdapterFactory,
  type StripeSubscriberRecord,
} from '@didacta/mod-payment-connections';
import { PaymentConnectionsController } from '../src/modules/payment-connections/payment-connections.controller';

/**
 * `POST /modules/payment-connections/user-tiers/sync` — el único camino por el
 * que una pasarela externa (Stripe / PayPal / WooCommerce conectadas en solo
 * lectura) acaba dando ACCESO en Didacta:
 *
 *   suscripción → tier derivado → `payment_connections.user_tier.changed`
 *   → mod.access-groups mete al usuario en el grupo vinculado → matrículas.
 *
 * El fallo: recibía tier cualquier suscripción que la pasarela listara, y la
 * pasarela lista también los impagos (`past_due`, `on-hold`). Quien dejaba de
 * pagar conservaba el tier —y el grupo, y los cursos— sin límite.
 *
 * Aquí va la cadena entera con los dos servicios REALES del módulo; lo único
 * doblado es Prisma, la pasarela y el bus. Lo que se mira es lo que de verdad
 * mueve el acceso: el tier efectivo y el evento que se publica.
 */

const T = '11111111-1111-1111-1111-111111111111';
const ADMIN = { sub: 'admin-1', tenantId: T, roles: ['super_admin'] } as never;

const USERS = [
  { id: 'u-ana', email: 'ana@x.test' },
  { id: 'u-beto', email: 'beto@x.test' },
  { id: 'u-carla', email: 'carla@x.test' },
];

function sub(id: string, email: string, status: string): StripeSubscriberRecord {
  return {
    subscriptionId: id,
    status,
    customerId: `cus_${id}`,
    email,
    name: email.split('@')[0]!,
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

type Row = Record<string, unknown>;

function build(opts: { pastDueGraceDays?: number } = {}) {
  /** Lo que devuelve la pasarela; cada test lo cambia entre syncs. */
  const estado: Record<string, string> = { ana: 'active', beto: 'active', carla: 'active' };

  const connections: Row[] = [
    {
      id: 'conn_1',
      tenantId: T,
      provider: 'stripe',
      displayName: 'Stripe ES',
      status: 'VERIFIED',
      publicMetadata: {},
      createdAt: new Date(),
    },
  ];
  const subscribers = new Map<string, Row>();
  const tiers: Row[] = [];
  const userTiers = new Map<string, Row>();
  let seq = 0;

  const conManual = (ut: Row) => {
    const manual = ut['manualTierId'] ? tiers.find((t) => t['id'] === ut['manualTierId']) : null;
    return { ...ut, manualTier: manual ? { name: manual['name'] } : null };
  };

  const prisma = {
    modPaymentConnectionsConnection: {
      findMany: async ({ where }: { where: Row }) =>
        connections.filter((c) => c['tenantId'] === where['tenantId']),
      findFirst: async ({ where }: { where: Row }) =>
        connections.find((c) => c['id'] === where['id'] && c['tenantId'] === where['tenantId']) ??
        null,
      update: async () => connections[0],
    },
    modPaymentConnectionsSubscriber: {
      findMany: async ({ where }: { where: Row }) =>
        [...subscribers.values()].filter(
          (r) => r['tenantId'] === where['tenantId'] && r['connectionId'] === where['connectionId'],
        ),
      upsert: async (args: {
        where: { tenantId_connectionId_subscriptionId: Record<string, string> };
        create: Row;
        update: Row;
      }) => {
        const k = args.where.tenantId_connectionId_subscriptionId;
        const key = `${k['connectionId']}::${k['subscriptionId']}`;
        const existing = subscribers.get(key);
        if (existing) return Object.assign(existing, args.update);
        const row = { id: `subr_${++seq}`, ...args.create };
        subscribers.set(key, row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0;
        for (const r of subscribers.values()) {
          if (r['connectionId'] !== where['connectionId']) continue;
          if (!((r['lastSeenAt'] as Date) < (where['lastSeenAt'] as { lt: Date }).lt)) continue;
          if (r['statusCategory'] === 'canceled') continue;
          Object.assign(r, data);
          count += 1;
        }
        return { count };
      },
    },
    modPaymentConnectionsTier: {
      findFirst: async ({ where }: { where: Row }) =>
        tiers.find(
          (t) =>
            t['tenantId'] === where['tenantId'] &&
            (where['name'] === undefined || t['name'] === where['name']) &&
            (where['id'] === undefined || t['id'] === where['id']),
        ) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row = { id: `tier_${++seq}`, ...data };
        tiers.push(row);
        return row;
      },
    },
    modPaymentConnectionsUserTier: {
      upsert: async (args: {
        where: { tenantId_userId: { tenantId: string; userId: string } };
        create: Row;
        update: Row;
      }) => {
        const { userId } = args.where.tenantId_userId;
        const existing = userTiers.get(userId);
        if (existing) return conManual(Object.assign(existing, args.update));
        const row: Row = {
          id: `ut_${++seq}`,
          manualTierId: null,
          derivedLabel: null,
          derivedProvider: null,
          derivedConnectionId: null,
          ...args.create,
        };
        userTiers.set(userId, row);
        return conManual(row);
      },
      findMany: async ({ where }: { where: Row }) => {
        const ids = (where['userId'] as { in?: string[] } | undefined)?.in ?? null;
        const conns = (where['derivedConnectionId'] as { in?: string[] } | undefined)?.in ?? null;
        return [...userTiers.values()]
          .filter((ut) => !ids || ids.includes(ut['userId'] as string))
          .filter((ut) => !('derivedLabel' in where) || ut['derivedLabel'] !== null)
          .filter((ut) => !conns || conns.includes(ut['derivedConnectionId'] as string))
          .map(conManual);
      },
      update: async (args: { where: { tenantId_userId: { userId: string } }; data: Row }) =>
        conManual(Object.assign(userTiers.get(args.where.tenantId_userId.userId)!, args.data)),
    },
  };

  const config = {
    get: async () => ({ apiKey: 'rk_test_conectada' }),
    set: async () => undefined,
    delete: async () => undefined,
  };
  const adapterFactory: PaymentReadAdapterFactory = () => ({
    retrieveAccount: async () => ({ id: 'acct', email: null, country: null, businessName: null }),
    listActiveSubscriptions: async () => ({
      // La pasarela lista lo que tiene, impagos incluidos: es así en producción
      // (`STRIPE_ACTIVE_STATUSES`, `WC_ACTIVE_STATUSES`).
      subscribers: [
        sub('sub_ana', 'ana@x.test', estado['ana']!),
        sub('sub_beto', 'beto@x.test', estado['beto']!),
        sub('sub_carla', 'carla@x.test', estado['carla']!),
      ],
      truncated: false,
    }),
  });
  const users = {
    findByNormalizedEmails: async (_t: string, emails: string[]) =>
      USERS.filter((u) => emails.includes(u.email)).map((u) => ({
        ...u,
        name: u.id,
        status: 'ACTIVE',
        avatarUrl: null,
      })),
  };

  const connectionsSvc =
    opts.pastDueGraceDays === undefined
      ? new PaymentConnectionsService(prisma as never, config as never, adapterFactory, users)
      : new PaymentConnectionsService(
          prisma as never,
          config as never,
          adapterFactory,
          users,
          opts.pastDueGraceDays,
        );
  const tiersSvc = new PaymentTiersService(prisma as never);

  /** `user_tier.changed` publicados: lo que consume el puente de grupos. */
  const publicados: Array<{ userId: string; tierName: string | null }> = [];
  const registry = {
    getPaymentConnectionsService: () => connectionsSvc,
    getPaymentTiersService: () => tiersSvc,
  };
  const contextFactory = {
    getEventBus: () => ({
      publish: async (event: {
        name: string;
        data: { userId: string; tierName: string | null };
      }) => {
        if (event.name === 'payment_connections.user_tier.changed') publicados.push(event.data);
      },
    }),
  };
  const controller = new PaymentConnectionsController(
    registry as never,
    {} as never,
    contextFactory as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const tierDe = async (userId: string) =>
    (await tiersSvc.getUserTiers(T, [userId]))[0]?.effectiveLabel ?? null;
  const sync = async () => {
    publicados.length = 0;
    return controller.syncUserTiers(ADMIN);
  };

  return { estado, sync, tierDe, publicados, tiersSvc, tiers };
}

describe('sync de tiers — un impago no recibe ni conserva el acceso', () => {
  let t: ReturnType<typeof build>;
  beforeEach(() => {
    t = build();
  });

  it('con todos al corriente, todos reciben su tier', async () => {
    const res = await t.sync();

    expect(res).toMatchObject({ matched: 3, withheldUnpaid: 0, cleared: 0, errors: [] });
    expect(await t.tierDe('u-ana')).toBe('Plan Pro');
    expect(await t.tierDe('u-beto')).toBe('Plan Pro');
    expect(await t.tierDe('u-carla')).toBe('Plan Pro');
  });

  it('quien YA está en impago en el primer sync no recibe tier', async () => {
    t.estado['beto'] = 'past_due'; // Stripe
    t.estado['carla'] = 'on-hold'; // WooCommerce

    const res = await t.sync();

    expect(res).toMatchObject({ matched: 1, withheldUnpaid: 2 });
    expect(await t.tierDe('u-ana')).toBe('Plan Pro');
    expect(await t.tierDe('u-beto')).toBeNull();
    expect(await t.tierDe('u-carla')).toBeNull();
    // Solo se anuncia el tier de quien paga: nadie mete a los otros en el grupo.
    expect(t.publicados).toEqual([{ userId: 'u-ana', tierName: 'Plan Pro' }]);
  });

  it('quien tenía tier y deja de pagar lo PIERDE, y se avisa al puente de grupos', async () => {
    await t.sync();
    expect(await t.tierDe('u-beto')).toBe('Plan Pro');

    t.estado['beto'] = 'past_due';
    const res = await t.sync();

    expect(res).toMatchObject({ matched: 2, withheldUnpaid: 1, cleared: 1 });
    expect(await t.tierDe('u-beto')).toBeNull();
    // `tierName: null` es lo que hace que mod.access-groups lo saque del
    // grupo vinculado y cancele las matrículas que ese grupo le dio.
    expect(t.publicados).toContainEqual({ userId: 'u-beto', tierName: null });
    // Los que pagan no se enteran.
    expect(await t.tierDe('u-ana')).toBe('Plan Pro');
    expect(t.publicados).toContainEqual({ userId: 'u-ana', tierName: 'Plan Pro' });
  });

  it('en cuanto la pasarela cobra, el tier vuelve solo', async () => {
    await t.sync();
    t.estado['beto'] = 'past_due';
    await t.sync();
    expect(await t.tierDe('u-beto')).toBeNull();

    t.estado['beto'] = 'active';
    const res = await t.sync();

    expect(res).toMatchObject({ matched: 3, withheldUnpaid: 0 });
    expect(await t.tierDe('u-beto')).toBe('Plan Pro');
    expect(t.publicados).toContainEqual({ userId: 'u-beto', tierName: 'Plan Pro' });
  });

  it('el plan de un impago sigue en el catálogo de tiers aunque no se le asigne', async () => {
    t.estado['ana'] = 'past_due';
    t.estado['beto'] = 'past_due';
    t.estado['carla'] = 'past_due';

    const res = await t.sync();

    expect(res).toMatchObject({ matched: 0, withheldUnpaid: 3, tiersCreated: 1 });
    expect(t.tiers.map((x) => x['name'])).toEqual(['Plan Pro']);
  });

  it('lo que un admin asignó a mano NO lo quita un impago', async () => {
    await t.sync();
    const vip = await t.tiersSvc.createTier(T, { name: 'VIP' });
    await t.tiersSvc.assignManualTier(T, 'u-beto', vip.id, 'admin-1');

    t.estado['beto'] = 'past_due';
    await t.sync();

    expect(await t.tierDe('u-beto')).toBe('VIP');
    expect(t.publicados).toContainEqual({ userId: 'u-beto', tierName: 'VIP' });
  });

  it('con cortesía configurada, el impago reciente conserva el tier', async () => {
    const conCortesia = build({ pastDueGraceDays: 7 });
    await conCortesia.sync();

    conCortesia.estado['beto'] = 'past_due';
    const res = await conCortesia.sync();

    // Acaba de entrar en impago: dentro de los 7 días. Que la cortesía CADUCA
    // se prueba con fechas en los tests del módulo (`collectDerivedTierEntries`).
    expect(res).toMatchObject({ matched: 3, withheldUnpaid: 0, cleared: 0 });
    expect(await conCortesia.tierDe('u-beto')).toBe('Plan Pro');
  });
});
