/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * RetentionService (oferta al darse de baja) sin red ni base: Prisma en
 * memoria, adaptador de Stripe falso y publicador que guarda los eventos.
 *
 * Lo que fija:
 *  - qué se ofrece según la configuración, el estado (local y de Stripe), el
 *    periodo del plan y lo que la persona ya usó;
 *  - pausa: Stripe con `void` hasta un día antes del primer cobro, ventana en
 *    la fila, una a la vez, deshace la reserva si Stripe falla;
 *  - descuento: cupón de un solo uso, una vez por persona (también con dos
 *    clics a la vez), la fila se va si Stripe falla;
 *  - baja: al final del periodo, con su motivo;
 *  - barrido: la pausa empieza y se avisa a los puentes UNA vez;
 *  - resumen: «X de Y se quedaron» y motivos.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { RetentionService } from '../src/retention.service.js';
import {
  RetentionAlreadyUsedError,
  RetentionConfigInvalidError,
  RetentionNotEligibleError,
  RetentionReasonInvalidError,
  StripeApiError,
  SubscriptionAlreadyLeavingError,
  SubscriptionNotFoundError,
} from '../src/errors.js';
import type {
  StripeSubscriptionDetails,
  SubscriptionsStripeAdapter,
} from '../src/stripe-subscriptions.client.js';

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const U = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-20T10:00:00Z');
const PERIOD_END = new Date('2026-12-14T17:29:11Z');

type Row = Record<string, unknown>;

/** Igualdad, null, {in}, {not}, {lt,lte,gt,gte} y OR — lo que usa el servicio. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(cond as Row[]).some((c) => matches(row, c))) return false;
      continue;
    }
    const v = row[k];
    if (cond === null) {
      if (v !== null && v !== undefined) return false;
      continue;
    }
    if (cond instanceof Date) {
      if (!(v instanceof Date) || v.getTime() !== cond.getTime()) return false;
      continue;
    }
    if (typeof cond === 'object') {
      const c = cond as Row;
      if ('in' in c && !(c['in'] as unknown[]).includes(v)) return false;
      if ('not' in c) {
        if (c['not'] === null ? v === null || v === undefined : v === c['not']) return false;
      }
      const num = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
      if ('lte' in c && !(v != null && num(v) <= num(c['lte']))) return false;
      if ('lt' in c && !(v != null && num(v) < num(c['lt']))) return false;
      if ('gte' in c && !(v != null && num(v) >= num(c['gte']))) return false;
      if ('gt' in c && !(v != null && num(v) > num(c['gt']))) return false;
      continue;
    }
    if (v !== cond) return false;
  }
  return true;
}

class MemPrisma {
  subs: Row[] = [];
  exits: Row[] = [];
  configs = new Map<string, Row>();
  users: Row[] = [];
  private seq = 0;

  modSubscriptionsRetentionConfig = {
    findUnique: async ({ where }: { where: { tenantId: string } }) =>
      this.configs.get(where.tenantId) ?? null,
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { tenantId: string };
      create: Row;
      update: Row;
    }) => {
      const cur = this.configs.get(where.tenantId);
      const base = cur ?? {
        tenantId: where.tenantId,
        pauseEnabled: false,
        pauseMaxMonths: 3,
        discountEnabled: false,
        discountPercent: 30,
        discountMonths: 3,
      };
      const next = { ...base, ...(cur ? update : create) };
      this.configs.set(where.tenantId, next);
      return next;
    },
  };

  modSubscriptionsSubscription = {
    findFirst: async ({ where }: { where: Row }) =>
      this.subs.find((s) => matches(s, where)) ?? null,
    findMany: async ({ where }: { where: Row }) => this.subs.filter((s) => matches(s, where)),
    count: async ({ where }: { where: Row }) => this.subs.filter((s) => matches(s, where)).length,
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = this.subs.filter((s) => matches(s, where));
      hit.forEach((s) => Object.assign(s, data));
      return { count: hit.length };
    },
  };

  modSubscriptionsExit = {
    findFirst: async ({ where }: { where: Row }) =>
      this.exits.find((e) => matches(e, where)) ?? null,
    findMany: async ({ where, take }: { where: Row; take?: number }) =>
      this.exits
        .filter((e) => matches(e, where))
        .sort((a, b) => (b['createdAt'] as Date).getTime() - (a['createdAt'] as Date).getTime())
        .slice(0, take ?? 10_000),
    create: async ({ data }: { data: Row }) => {
      if (
        data['discountedUserId'] &&
        this.exits.some(
          (e) =>
            e['tenantId'] === data['tenantId'] &&
            e['discountedUserId'] === data['discountedUserId'],
        )
      ) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      const row = {
        id: `exit-${++this.seq}`,
        reasonText: null,
        pauseMonths: null,
        pauseStartsAt: null,
        pauseEndsAt: null,
        discountPercent: null,
        discountMonths: null,
        discountDuration: null,
        discountEndsAt: null,
        stripeCouponId: null,
        discountedUserId: null,
        appliedAt: null,
        createdAt: new Date(NOW.getTime() + this.seq),
        ...data,
      };
      this.exits.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = this.exits.find((e) => e['id'] === where.id)!;
      Object.assign(row, data);
      return row;
    },
    deleteMany: async ({ where }: { where: Row }) => {
      const before = this.exits.length;
      this.exits = this.exits.filter((e) => !matches(e, where));
      return { count: before - this.exits.length };
    },
  };

  user = {
    findMany: async ({ where }: { where: Row }) => this.users.filter((u) => matches(u, where)),
  };
}

function sub(over: Row = {}): Row {
  return {
    id: 'sub-local-1',
    tenantId: T,
    userId: U,
    courseId: null,
    planId: 'plan-1',
    stripeSubscriptionId: 'sub_stripe_1',
    stripeCustomerId: 'cus_1',
    stripePriceId: 'price_1',
    status: 'ACTIVE',
    unitAmount: 2900,
    currency: 'eur',
    interval: 'month',
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    gracePeriodEndsAt: null,
    canceledAt: null,
    canceledReason: null,
    trialEndsAt: null,
    pauseStartsAt: null,
    pauseEndsAt: null,
    createdAt: new Date('2026-10-14T17:29:11Z'),
    updatedAt: NOW,
    ...over,
  };
}

function details(over: Partial<StripeSubscriptionDetails> = {}): StripeSubscriptionDetails {
  return {
    id: 'sub_stripe_1',
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodStart: Math.floor(new Date('2026-11-14T17:29:11Z').getTime() / 1000),
    currentPeriodEnd: Math.floor(PERIOD_END.getTime() / 1000),
    intervalMonths: 1,
    pauseCollection: null,
    hasDiscount: false,
    ...over,
  };
}

class FakeStripe {
  calls: Array<{ op: string; args: unknown }> = [];
  details = details();
  failPause = false;
  failDiscount = false;
  failRetrieve = false;
  adapter = {
    retrieveSubscription: async (id: string) => {
      this.calls.push({ op: 'retrieve', args: id });
      if (this.failRetrieve) throw new StripeApiError('caído');
      return this.details;
    },
    pauseCollection: async (args: unknown) => {
      this.calls.push({ op: 'pause', args });
      if (this.failPause) throw new StripeApiError('rechazado');
      return this.details;
    },
    applyRetentionDiscount: async (args: unknown) => {
      this.calls.push({ op: 'discount', args });
      if (this.failDiscount) throw new StripeApiError('rechazado');
      return { couponId: 'coupon_ret_1', discountEnd: 1_802_539_751 };
    },
  } as unknown as SubscriptionsStripeAdapter;
}

let prisma: MemPrisma;
let stripe: FakeStripe;
let events: Array<{ name: string; payload: Record<string, unknown> }>;
let cancels: string[];
let svc: RetentionService;

beforeEach(() => {
  prisma = new MemPrisma();
  stripe = new FakeStripe();
  events = [];
  cancels = [];
  svc = new RetentionService(
    prisma as never,
    async () => stripe.adapter,
    { publish: async (_t, _a, name, payload) => void events.push({ name, payload }) },
    async (tenantId, userId, subscriptionId) => {
      cancels.push(subscriptionId);
      const row = prisma.subs.find((s) => s['id'] === subscriptionId)!;
      row['cancelAtPeriodEnd'] = true;
      return row as never;
    },
    { now: () => NOW },
  );
  prisma.subs.push(sub());
  prisma.users.push({ id: U, tenantId: T, name: 'Lucía Prueba', email: 'lucia@example.com' });
});

async function configure(over: Row = {}) {
  await svc.updateConfig(T, {
    pauseEnabled: true,
    pauseMaxMonths: 3,
    discountEnabled: true,
    discountPercent: 30,
    discountMonths: 3,
    ...over,
  });
}

describe('configuración', () => {
  it('sin fila: todo apagado; guardar respeta los límites', async () => {
    expect(await svc.getConfig(T)).toEqual({
      pauseEnabled: false,
      pauseMaxMonths: 3,
      discountEnabled: false,
      discountPercent: 30,
      discountMonths: 3,
    });
    await expect(svc.updateConfig(T, { discountPercent: 95 })).rejects.toBeInstanceOf(
      RetentionConfigInvalidError,
    );
    const saved = await svc.updateConfig(T, { pauseEnabled: true, pauseMaxMonths: 2 });
    expect(saved.pauseEnabled).toBe(true);
    expect(saved.pauseMaxMonths).toBe(2);
    expect(saved.discountEnabled).toBe(false);
  });
});

describe('getOffer', () => {
  it('apagado: solo los motivos, sin preguntar a Stripe', async () => {
    const offer = await svc.getOffer(T, U, 'sub-local-1');
    expect(offer.canLeave).toBe(true);
    expect(offer.reasons).toHaveLength(6);
    expect(offer.pause).toBeNull();
    expect(offer.discount).toBeNull();
    expect(stripe.calls).toHaveLength(0);
  });

  it('mensual al día: pausa 1–3 meses desde el fin de lo pagado y 30 % durante 3 meses', async () => {
    await configure();
    const offer = await svc.getOffer(T, U, 'sub-local-1');
    expect(offer.pause?.months).toEqual([1, 2, 3]);
    expect(offer.pause?.startsAt.toISOString()).toBe(PERIOD_END.toISOString());
    expect(offer.pause?.endsAtByMonths[2]?.toISOString()).toBe('2027-02-14T17:29:11.000Z');
    expect(offer.discount).toMatchObject({
      percent: 30,
      months: 3,
      duration: 'repeating',
      amountCents: 2900,
      discountedAmountCents: 2030,
      currency: 'eur',
    });
    expect(offer.accessEndsAt?.toISOString()).toBe(PERIOD_END.toISOString());
  });

  it('anual: sin pausa; el descuento va a la siguiente renovación', async () => {
    await configure();
    stripe.details = details({ intervalMonths: 12 });
    const offer = await svc.getOffer(T, U, 'sub-local-1');
    expect(offer.pause).toBeNull();
    expect(offer.discount).toMatchObject({ duration: 'once', months: null });
  });

  it('en prueba: descuento sí, pausa no (no hay nada pagado que pausar)', async () => {
    await configure();
    prisma.subs[0]!['status'] = 'TRIALING';
    stripe.details = details({ status: 'trialing' });
    const offer = await svc.getOffer(T, U, 'sub-local-1');
    expect(offer.pause).toBeNull();
    expect(offer.discount).not.toBeNull();
  });

  it('con impago, ya en pausa en Stripe, con descuento o con la baja puesta en Stripe: nada', async () => {
    await configure();
    prisma.subs[0]!['status'] = 'PAST_DUE';
    expect((await svc.getOffer(T, U, 'sub-local-1')).discount).toBeNull();
    prisma.subs[0]!['status'] = 'ACTIVE';
    stripe.details = details({
      pauseCollection: { behavior: 'void', resumesAt: 1 },
      hasDiscount: true,
    });
    const o2 = await svc.getOffer(T, U, 'sub-local-1');
    expect(o2.pause).toBeNull();
    expect(o2.discount).toBeNull();
    stripe.details = details({ cancelAtPeriodEnd: true });
    const o3 = await svc.getOffer(T, U, 'sub-local-1');
    expect(o3.pause).toBeNull();
    expect(o3.discount).toBeNull();
  });

  it('si Stripe no contesta, no se ofrece nada pero la baja sigue disponible', async () => {
    await configure();
    stripe.failRetrieve = true;
    const offer = await svc.getOffer(T, U, 'sub-local-1');
    expect(offer.canLeave).toBe(true);
    expect(offer.pause).toBeNull();
    expect(offer.discount).toBeNull();
  });

  it('suscripción ajena o de otra aula: 404 sin decir cuál', async () => {
    await expect(svc.getOffer(T, U2, 'sub-local-1')).rejects.toBeInstanceOf(
      SubscriptionNotFoundError,
    );
    await expect(svc.getOffer(T2, U, 'sub-local-1')).rejects.toBeInstanceOf(
      SubscriptionNotFoundError,
    );
  });
});

describe('leave → pausa', () => {
  it('pausa en Stripe hasta un día antes del primer cobro; ventana en la fila; evento', async () => {
    await configure();
    const r = await svc.leave(T, U, 'sub-local-1', {
      reason: 'no_time',
      reasonText: '  Estoy de exámenes  ',
      choice: 'pause',
      pauseMonths: 2,
    });
    expect(r.outcome).toBe('PAUSED');
    const pause = stripe.calls.find((c) => c.op === 'pause')!.args as Record<string, unknown>;
    expect(pause).toEqual({
      subscriptionId: 'sub_stripe_1',
      resumesAt: Math.floor(new Date('2027-02-13T17:29:11Z').getTime() / 1000),
      idempotencyKey: `retention-pause:sub-local-1:${PERIOD_END.getTime()}`,
    });
    expect(r.subscription.status).toBe('ACTIVE'); // hasta que acabe lo pagado
    expect(r.subscription.pauseStartsAt?.toISOString()).toBe(PERIOD_END.toISOString());
    expect(r.subscription.pauseEndsAt?.toISOString()).toBe('2027-02-14T17:29:11.000Z');
    expect(r.exit).toMatchObject({
      outcome: 'PAUSED',
      reason: 'no_time',
      reasonText: 'Estoy de exámenes',
      pauseMonths: 2,
      offeredPause: true,
      offeredDiscount: true,
    });
    expect(events.map((e) => e.name)).toEqual(['subscriptions.retention.paused']);
  });

  it('meses no ofrecidos, segunda pausa o pausa usada este año: no', async () => {
    await configure({ pauseMaxMonths: 2 });
    await expect(
      svc.leave(T, U, 'sub-local-1', { reason: 'no_time', choice: 'pause', pauseMonths: 3 }),
    ).rejects.toBeInstanceOf(RetentionNotEligibleError);
    await svc.leave(T, U, 'sub-local-1', { reason: 'no_time', choice: 'pause', pauseMonths: 1 });
    // ya con pausa aceptada: otra no
    await expect(
      svc.leave(T, U, 'sub-local-1', { reason: 'no_time', choice: 'pause', pauseMonths: 1 }),
    ).rejects.toBeInstanceOf(RetentionNotEligibleError);
    // otra suscripción de la misma persona, pausa hace menos de un año → ya usada
    prisma.subs.push(sub({ id: 'sub-local-2', stripeSubscriptionId: 'sub_stripe_2' }));
    await expect(
      svc.leave(T, U, 'sub-local-2', { reason: 'no_time', choice: 'pause', pauseMonths: 1 }),
    ).rejects.toBeInstanceOf(RetentionAlreadyUsedError);
  });

  it('si Stripe rechaza la pausa, la reserva se deshace y no queda salida', async () => {
    await configure();
    stripe.failPause = true;
    await expect(
      svc.leave(T, U, 'sub-local-1', { reason: 'too_expensive', choice: 'pause', pauseMonths: 1 }),
    ).rejects.toBeInstanceOf(StripeApiError);
    expect(prisma.subs[0]!['pauseStartsAt']).toBeNull();
    expect(prisma.exits).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

describe('leave → descuento', () => {
  it('cupón de un solo uso con la clave de la salida; fin del descuento guardado', async () => {
    await configure();
    const r = await svc.leave(T, U, 'sub-local-1', { reason: 'too_expensive', choice: 'discount' });
    expect(r.outcome).toBe('DISCOUNTED');
    const call = stripe.calls.find((c) => c.op === 'discount')!.args as Record<string, unknown>;
    expect(call).toMatchObject({
      subscriptionId: 'sub_stripe_1',
      percentOff: 30,
      duration: 'repeating',
      durationInMonths: 3,
      name: '-30% · 3m',
      idempotencyKey: `retention-discount:${r.exit.id}`,
    });
    expect(r.exit).toMatchObject({
      discountPercent: 30,
      discountMonths: 3,
      discountDuration: 'repeating',
      stripeCouponId: 'coupon_ret_1',
      discountedUserId: U,
    });
    expect(r.exit.appliedAt).not.toBeNull();
    expect((await svc.activeDiscounts(T, ['sub-local-1'])).get('sub-local-1')).toMatchObject({
      percent: 30,
      months: 3,
    });
    expect(events.map((e) => e.name)).toEqual(['subscriptions.retention.discounted']);
    expect(events[0]!.payload).toMatchObject({ amountCents: 2900, discountedAmountCents: 2030 });
  });

  it('una vez por persona y aula (aunque sea otra suscripción)', async () => {
    await configure();
    await svc.leave(T, U, 'sub-local-1', { reason: 'too_expensive', choice: 'discount' });
    prisma.subs.push(sub({ id: 'sub-local-2', stripeSubscriptionId: 'sub_stripe_2' }));
    // La oferta ya no lo trae…
    expect((await svc.getOffer(T, U, 'sub-local-2')).discount).toBeNull();
    // …y pedirlo igual da «ya usado».
    await expect(
      svc.leave(T, U, 'sub-local-2', { reason: 'too_expensive', choice: 'discount' }),
    ).rejects.toBeInstanceOf(RetentionAlreadyUsedError);
    expect(stripe.calls.filter((c) => c.op === 'discount')).toHaveLength(1);
  });

  it('dos clics a la vez: un solo cupón', async () => {
    await configure();
    const results = await Promise.allSettled([
      svc.leave(T, U, 'sub-local-1', { reason: 'too_expensive', choice: 'discount' }),
      svc.leave(T, U, 'sub-local-1', { reason: 'too_expensive', choice: 'discount' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(RetentionAlreadyUsedError);
    expect(stripe.calls.filter((c) => c.op === 'discount')).toHaveLength(1);
  });

  it('si Stripe falla, la fila se borra y puede volver a intentarlo', async () => {
    await configure();
    stripe.failDiscount = true;
    await expect(
      svc.leave(T, U, 'sub-local-1', { reason: 'too_expensive', choice: 'discount' }),
    ).rejects.toBeInstanceOf(StripeApiError);
    expect(prisma.exits).toHaveLength(0);
    stripe.failDiscount = false;
    const r = await svc.leave(T, U, 'sub-local-1', { reason: 'too_expensive', choice: 'discount' });
    expect(r.outcome).toBe('DISCOUNTED');
  });
});

describe('leave → baja', () => {
  it('cancela al final del periodo, guarda el motivo y lo que se le ofreció', async () => {
    await configure();
    const r = await svc.leave(T, U, 'sub-local-1', {
      reason: 'missing_topics',
      reasonText: 'Falta un módulo de esmaltes',
      choice: 'cancel',
    });
    expect(r.outcome).toBe('CANCELED');
    expect(cancels).toEqual(['sub-local-1']);
    expect(r.exit).toMatchObject({
      reason: 'missing_topics',
      offeredPause: true,
      offeredDiscount: true,
      outcome: 'CANCELED',
    });
    expect(events[0]).toMatchObject({
      name: 'subscriptions.retention.canceled',
      payload: { accessEndsAt: PERIOD_END.toISOString() },
    });
  });

  it('sin oferta configurada también pide motivo; motivo inventado: 400', async () => {
    await expect(
      svc.leave(T, U, 'sub-local-1', { reason: 'caro', choice: 'cancel' }),
    ).rejects.toBeInstanceOf(RetentionReasonInvalidError);
    const r = await svc.leave(T, U, 'sub-local-1', { reason: 'other', choice: 'cancel' });
    expect(r.exit).toMatchObject({ offeredPause: false, offeredDiscount: false });
  });

  it('en pausa: se puede dar de baja, sin ofertas y sin prometer acceso', async () => {
    await configure();
    prisma.subs[0]!['status'] = 'PAUSED';
    prisma.subs[0]!['pauseStartsAt'] = PERIOD_END;
    const offer = await svc.getOffer(T, U, 'sub-local-1');
    expect(offer).toMatchObject({
      canLeave: true,
      pause: null,
      discount: null,
      accessEndsAt: null,
    });
    const r = await svc.leave(T, U, 'sub-local-1', { reason: 'no_time', choice: 'cancel' });
    expect(r.outcome).toBe('CANCELED');
    expect(events.at(-1)).toMatchObject({
      name: 'subscriptions.retention.canceled',
      payload: { accessEndsAt: null },
    });
  });

  it('ya con la baja programada: 409', async () => {
    prisma.subs[0]!['cancelAtPeriodEnd'] = true;
    await expect(
      svc.leave(T, U, 'sub-local-1', { reason: 'no_time', choice: 'cancel' }),
    ).rejects.toBeInstanceOf(SubscriptionAlreadyLeavingError);
  });
});

describe('barrido: la pausa empieza', () => {
  it('ACTIVE → PAUSED al llegar el inicio, una sola vez, y avisa a los puentes', async () => {
    await configure();
    await svc.leave(T, U, 'sub-local-1', { reason: 'no_time', choice: 'pause', pauseMonths: 1 });
    events = [];
    const before = new Date(PERIOD_END.getTime() - 60_000);
    expect(await svc.findTenantsWithDuePauses(before)).toEqual([]);
    const after = new Date(PERIOD_END.getTime() + 60_000);
    expect(await svc.findTenantsWithDuePauses(after)).toEqual([T]);
    expect(await svc.startDuePausesForTenant(T, after)).toHaveLength(1);
    expect(prisma.subs[0]!['status']).toBe('PAUSED');
    expect(await svc.startDuePausesForTenant(T, after)).toHaveLength(0);
    expect(events.map((e) => e.name)).toEqual(['subscriptions.subscription.paused']);
    expect(events[0]!.payload).toMatchObject({ subscriptionId: 'sub-local-1', planId: 'plan-1' });
  });

  it('con la baja programada no empieza ninguna pausa', async () => {
    prisma.subs[0]!['pauseStartsAt'] = PERIOD_END;
    prisma.subs[0]!['pauseEndsAt'] = new Date('2027-01-14T17:29:11Z');
    prisma.subs[0]!['cancelAtPeriodEnd'] = true;
    expect(await svc.startDuePausesForTenant(T, new Date('2026-12-20T00:00:00Z'))).toHaveLength(0);
  });
});

describe('resumen para la creadora', () => {
  it('cuenta quién se quedó, los motivos (de más a menos) y las últimas salidas', async () => {
    await configure();
    prisma.users.push({ id: U2, tenantId: T, name: 'Marcos Prueba', email: 'marcos@example.com' });
    prisma.subs.push(sub({ id: 'sub-local-2', userId: U2, stripeSubscriptionId: 'sub_stripe_2' }));
    prisma.subs.push(sub({ id: 'sub-local-3', userId: U2, stripeSubscriptionId: 'sub_stripe_3' }));
    await svc.leave(T, U, 'sub-local-1', { reason: 'no_time', choice: 'pause', pauseMonths: 1 });
    await svc.leave(T, U2, 'sub-local-2', { reason: 'too_expensive', choice: 'discount' });
    await svc.leave(T, U2, 'sub-local-3', { reason: 'too_expensive', choice: 'cancel' });
    const s = await svc.summary(T);
    expect(s).toMatchObject({ total: 3, stayed: 2, paused: 1, discounted: 1, canceled: 1 });
    expect(s.reasons).toEqual([
      { reason: 'too_expensive', count: 2 },
      { reason: 'no_time', count: 1 },
    ]);
    expect(s.pausesScheduled).toBe(1);
    expect(s.recent[0]).toMatchObject({ outcome: 'CANCELED', userName: 'Marcos Prueba' });
    // Otra aula no ve nada.
    expect((await svc.summary(T2)).total).toBe(0);
  });
});
