/**
 * Cambio de nivel de la membresía (MembershipService.changePlan / preview /
 * opciones) y su reconciliación por webhook (SubscriptionsService) — sin red,
 * sin base real y sin el SDK de Stripe.
 *
 * Cubre:
 *  - SUBIR: `always_invoice` + lo cobrado; la fila cambia de plan, precio e
 *    importe; UN aviso `plan_changed` con niveles de origen y destino.
 *  - BAJAR: `create_prorations`, sin cobro hoy.
 *  - PRUEBA GRATIS: sin prorrateo (`none`) y sin vista previa en Stripe.
 *  - Si Stripe rechaza el cobro, la fila no cambia y no se avisa.
 *  - Bloqueos: sin membresía, impago, baja o pausa programadas, mismo plan,
 *    otra moneda, plan de un nivel apagado o de un plan sin nivel.
 *  - Clave de idempotencia por fila y `updatedAt`.
 *  - Opciones: solo en aulas con niveles, misma moneda, en orden de nivel.
 *  - Webhook `customer.subscription.updated` con otro `planId` en la metadata:
 *    aplica el cambio una vez; si ya lo aplicó la cuenta, no avisa otra vez.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Stripe from 'stripe';
import { MembershipService } from '../src/membership.service.js';
import { SubscriptionsService } from '../src/subscriptions.service.js';
import {
  MembershipPlanChangeNotAllowedError,
  MembershipPlanChangePaymentFailedError,
} from '../src/errors.js';
import type {
  ChangeSubscriptionPriceParams,
  SubscriptionsStripeAdapter,
} from '../src/stripe-subscriptions.client.js';
import { planChangeDirection, monthlyEquivalent } from '../src/plan-change.js';

const T = 'tenant-1';
const U = 'user-1';

type Row = Record<string, unknown>;

/** `where` de Prisma reducido a lo que usan estas consultas. */
function matches(row: Row, where: Row = {}): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'NOT') {
      if (matches(row, cond as Row)) return false;
      continue;
    }
    const val = row[k];
    if (cond === null) {
      if (val !== null && val !== undefined) return false;
    } else if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { not?: unknown; in?: unknown[] };
      if ('in' in c && !c.in!.includes(val)) return false;
      if ('not' in c) {
        if (c.not === null ? val === null || val === undefined : val === c.not) return false;
      }
    } else if (val !== cond) {
      return false;
    }
  }
  return true;
}

class Table {
  rows: Row[] = [];
  constructor(private readonly prefix: string) {}
  private seq = 0;
  findMany = async (args: { where?: Row } = {}) =>
    this.rows.filter((r) => matches(r, args.where)).map((r) => ({ ...r }));
  findFirst = async (args: { where?: Row } = {}) => {
    const r = this.rows.find((x) => matches(x, args.where));
    return r ? { ...r } : null;
  };
  findFirstOrThrow = async (args: { where?: Row } = {}) => {
    const r = await this.findFirst(args);
    if (!r) throw new Error('not found');
    return r;
  };
  findUnique = async (args: { where: Row }) => this.findFirst(args);
  count = async (args: { where?: Row } = {}) =>
    this.rows.filter((r) => matches(r, args.where)).length;
  create = async (args: { data: Row }) => {
    const row = { id: `${this.prefix}_${++this.seq}`, ...args.data };
    this.rows.push(row);
    return { ...row };
  };
  update = async (args: { where: Row; data: Row }) => {
    const row = this.rows.find((r) => matches(r, args.where));
    if (!row) throw new Error('not found');
    Object.assign(row, args.data, { updatedAt: new Date(Date.now() + 1) });
    return { ...row };
  };
  updateMany = async (args: { where: Row; data: Row }) => {
    const hits = this.rows.filter((r) => matches(r, args.where));
    for (const r of hits) Object.assign(r, args.data, { updatedAt: new Date(Date.now() + 1) });
    return { count: hits.length };
  };
}

function buildPrisma() {
  return {
    modSubscriptionsTier: new Table('tier'),
    modSubscriptionsPlan: new Table('plan'),
    modSubscriptionsSubscription: new Table('sub'),
    modSubscriptionsWebhookEvent: new Table('evt'),
    modSubscriptionsInvoice: new Table('inv'),
  };
}

function fakeStripe() {
  const calls: ChangeSubscriptionPriceParams[] = [];
  let fail = false;
  let invoice: { amountPaid: number; total: number } | null = null;
  const adapter = {
    createProduct: vi.fn(async () => 'prod_x'),
    createRecurringPrice: vi.fn(
      async (p: { metadata: Record<string, string> }) => `price_${p.metadata['planId']}`,
    ),
    changeSubscriptionPrice: vi.fn(async (p: ChangeSubscriptionPriceParams) => {
      calls.push(p);
      if (fail) throw new MembershipPlanChangePaymentFailedError('card_declined');
      return {
        id: p.subscriptionId,
        status: 'active',
        currentPeriodEnd: 1_900_000_000,
        priceId: p.priceId,
        latestInvoice:
          p.prorationBehavior === 'always_invoice' && invoice
            ? {
                id: 'in_1',
                status: 'paid',
                amountPaid: invoice.amountPaid,
                total: invoice.total,
                currency: 'eur',
                billingReason: 'subscription_update',
              }
            : null,
      };
    }),
    previewSubscriptionPriceChange: vi.fn(async () => ({
      amountDue: 1333,
      total: 1333,
      currency: 'eur',
    })),
  } as unknown as SubscriptionsStripeAdapter;
  return {
    adapter,
    calls,
    failNext: () => {
      fail = true;
    },
    chargeNext: (amountPaid: number) => {
      invoice = { amountPaid, total: amountPaid };
    },
  };
}

let prisma: ReturnType<typeof buildPrisma>;
let stripe: ReturnType<typeof fakeStripe>;
let events: Array<{ name: string; payload: Record<string, unknown> }>;
let svc: MembershipService;
let basico: Row;
let pro: Row;
let gratis: Row;
let planBasico: Row;
let planPro: Row;
let planProAnual: Row;

async function seed() {
  basico = await prisma.modSubscriptionsTier.create({
    data: {
      tenantId: T,
      name: 'Básico',
      isFree: false,
      active: true,
      sortOrder: 0,
      accessGroupId: 'g_b',
      createdAt: new Date(),
    },
  });
  pro = await prisma.modSubscriptionsTier.create({
    data: {
      tenantId: T,
      name: 'Pro',
      isFree: false,
      active: true,
      sortOrder: 1,
      accessGroupId: 'g_p',
      createdAt: new Date(),
    },
  });
  gratis = await prisma.modSubscriptionsTier.create({
    data: {
      tenantId: T,
      name: 'Gratis',
      isFree: true,
      active: true,
      sortOrder: 2,
      accessGroupId: 'g_g',
      createdAt: new Date(),
    },
  });
  const plan = (data: Row) =>
    prisma.modSubscriptionsPlan.create({
      data: {
        tenantId: T,
        currency: 'eur',
        compareAtCents: null,
        trialDays: 0,
        active: true,
        isFeatured: false,
        sortOrder: 0,
        stripeProductId: null,
        stripePriceId: null,
        currencyOptions: null,
        ...data,
      },
    });
  planBasico = await plan({
    name: 'Básico · Mensual',
    tierId: basico.id,
    intervalMonths: 1,
    amountCents: 1000,
    stripePriceId: 'price_basico',
  });
  planPro = await plan({
    name: 'Pro · Mensual',
    tierId: pro.id,
    intervalMonths: 1,
    amountCents: 3000,
  });
  planProAnual = await plan({
    name: 'Pro · Anual',
    tierId: pro.id,
    intervalMonths: 12,
    amountCents: 30000,
  });
}

async function liveSub(extra: Row = {}) {
  return prisma.modSubscriptionsSubscription.create({
    data: {
      tenantId: T,
      userId: U,
      courseId: null,
      planId: planBasico.id,
      stripeSubscriptionId: 'sub_stripe_1',
      stripeCustomerId: 'cus_1',
      stripePriceId: 'price_basico',
      status: 'ACTIVE',
      unitAmount: 1000,
      currency: 'eur',
      interval: 'month',
      cancelAtPeriodEnd: false,
      pauseStartsAt: null,
      createdAt: new Date(),
      updatedAt: new Date(1_700_000_000_000),
      ...extra,
    },
  });
}

beforeEach(async () => {
  prisma = buildPrisma();
  stripe = fakeStripe();
  events = [];
  svc = new MembershipService(prisma as never, async () => stripe.adapter, {
    publish: async (_t, _a, name, payload) => {
      events.push({ name, payload });
    },
  });
  await seed();
});

describe('dirección del cambio', () => {
  it('compara el precio AL MES: el anual de 300 € (25 €/mes) baja desde 30 €/mes', () => {
    expect(monthlyEquivalent({ amountCents: 30000, intervalMonths: 12 })).toBe(2500);
    expect(
      planChangeDirection(
        { amountCents: 3000, intervalMonths: 1 },
        { amountCents: 30000, intervalMonths: 12 },
      ),
    ).toBe('downgrade');
    expect(
      planChangeDirection(
        { amountCents: 1000, intervalMonths: 1 },
        { amountCents: 3000, intervalMonths: 1 },
      ),
    ).toBe('upgrade');
  });
});

describe('MembershipService.changePlan', () => {
  it('SUBIR: always_invoice, cobra la diferencia, la fila pasa al plan nuevo y avisa una vez', async () => {
    const sub = await liveSub();
    stripe.chargeNext(1333);
    const res = await svc.changePlan(T, U, planPro.id as string);

    expect(stripe.calls).toHaveLength(1);
    expect(stripe.calls[0]).toMatchObject({
      subscriptionId: 'sub_stripe_1',
      priceId: `price_${planPro.id}`,
      prorationBehavior: 'always_invoice',
      metadata: { planId: planPro.id, tierId: pro.id },
      idempotencyKey: `plan-change:${sub.id}:${planBasico.id}:${planPro.id}:1700000000000`,
    });
    expect(res.direction).toBe('upgrade');
    expect(res.charged).toEqual({ amountCents: 1333, currency: 'eur' });
    expect(res.subscription).toMatchObject({
      planId: planPro.id,
      unitAmount: 3000,
      stripePriceId: `price_${planPro.id}`,
      interval: 'month',
    });
    expect(events).toEqual([
      {
        name: 'subscriptions.membership.plan_changed',
        payload: expect.objectContaining({
          subscriptionId: sub.id,
          userId: U,
          fromPlanId: planBasico.id,
          toPlanId: planPro.id,
          fromTierId: basico.id,
          toTierId: pro.id,
          direction: 'upgrade',
          via: 'account',
        }),
      },
    ]);
  });

  it('BAJAR: create_prorations y nada cobrado hoy', async () => {
    await liveSub({ planId: planPro.id, unitAmount: 3000, stripePriceId: 'price_pro' });
    const res = await svc.changePlan(T, U, planBasico.id as string);
    expect(stripe.calls[0]!.prorationBehavior).toBe('create_prorations');
    expect(res.direction).toBe('downgrade');
    expect(res.charged).toBeNull();
    expect(res.subscription.planId).toBe(planBasico.id);
  });

  it('pasar al ANUAL más barato al mes cuenta como bajar (la diferencia queda a favor)', async () => {
    await liveSub({ planId: planPro.id, unitAmount: 3000 });
    const res = await svc.changePlan(T, U, planProAnual.id as string);
    expect(stripe.calls[0]!.prorationBehavior).toBe('create_prorations');
    expect(res.subscription).toMatchObject({ interval: 'year', unitAmount: 30000 });
  });

  it('EN PRUEBA: sin prorrateo y sin vista previa en Stripe', async () => {
    await liveSub({ status: 'TRIALING' });
    const preview = await svc.previewPlanChange(T, U, planPro.id as string);
    expect(preview).toMatchObject({ trialing: true, amountDueNow: 0, creditCents: 0 });
    expect(stripe.adapter.previewSubscriptionPriceChange).not.toHaveBeenCalled();
    await svc.changePlan(T, U, planPro.id as string);
    expect(stripe.calls[0]!.prorationBehavior).toBe('none');
  });

  it('si Stripe rechaza el cobro, la fila no cambia y no se avisa', async () => {
    await liveSub();
    stripe.failNext();
    await expect(svc.changePlan(T, U, planPro.id as string)).rejects.toBeInstanceOf(
      MembershipPlanChangePaymentFailedError,
    );
    const sub = await prisma.modSubscriptionsSubscription.findFirst({ where: { userId: U } });
    expect(sub).toMatchObject({ planId: planBasico.id, unitAmount: 1000 });
    expect(events).toEqual([]);
  });

  it.each([
    ['sin membresía', null, 'no_membership'],
    ['con impago', { status: 'PAST_DUE' }, 'not_active'],
    ['en pausa', { status: 'PAUSED' }, 'not_active'],
    ['con la baja programada', { cancelAtPeriodEnd: true }, 'cancel_scheduled'],
    ['con una pausa programada', { pauseStartsAt: new Date() }, 'pause_scheduled'],
  ])('%s → %s sin tocar Stripe', async (_que, extra, reason) => {
    if (extra) await liveSub(extra as Row);
    await expect(svc.changePlan(T, U, planPro.id as string)).rejects.toMatchObject({
      code: 'MEMBERSHIP_PLAN_CHANGE_NOT_ALLOWED',
      reason,
    });
    expect(stripe.calls).toHaveLength(0);
  });

  it('al mismo plan, a otra moneda, a un nivel apagado o a un plan sin nivel → no', async () => {
    await liveSub();
    await expect(svc.changePlan(T, U, planBasico.id as string)).rejects.toMatchObject({
      reason: 'same_plan',
    });
    const usd = await prisma.modSubscriptionsPlan.create({
      data: {
        tenantId: T,
        tierId: pro.id,
        name: 'Pro · USD',
        intervalMonths: 1,
        amountCents: 3000,
        currency: 'usd',
        active: true,
      },
    });
    await expect(svc.changePlan(T, U, usd.id as string)).rejects.toMatchObject({
      reason: 'currency_mismatch',
    });
    const suelto = await prisma.modSubscriptionsPlan.create({
      data: {
        tenantId: T,
        tierId: null,
        name: 'Suelto',
        intervalMonths: 1,
        amountCents: 500,
        currency: 'eur',
        active: true,
      },
    });
    await expect(svc.changePlan(T, U, suelto.id as string)).rejects.toMatchObject({
      reason: 'target_unavailable',
    });
    await prisma.modSubscriptionsTier.update({ where: { id: pro.id }, data: { active: false } });
    await expect(svc.changePlan(T, U, planPro.id as string)).rejects.toBeInstanceOf(
      MembershipPlanChangeNotAllowedError,
    );
    expect(stripe.calls).toHaveLength(0);
  });
});

describe('MembershipService.getPlanChangeOptions', () => {
  it('ofrece los planes de los niveles de pago en su orden y dice cuál es el gratis', async () => {
    await liveSub();
    await prisma.modSubscriptionsPlan.create({
      data: {
        tenantId: T,
        tierId: pro.id,
        name: 'Pro · USD',
        intervalMonths: 1,
        amountCents: 3000,
        currency: 'usd',
        active: true,
      },
    });
    const res = await svc.getPlanChangeOptions(T, U);
    expect(res.blockedReason).toBeNull();
    expect(res.subscription).toMatchObject({ tierName: 'Básico', planId: planBasico.id });
    expect(res.options.map((o) => [o.planName, o.direction])).toEqual([
      ['Pro · Mensual', 'upgrade'],
      ['Pro · Anual', 'upgrade'],
    ]);
    expect(res.freeTier).toEqual({ id: gratis.id, name: 'Gratis' });
  });

  it('aula SIN niveles de pago: sin opciones (la cuenta sigue como siempre)', async () => {
    prisma.modSubscriptionsTier.rows = [];
    await liveSub({ planId: 'plan_de_siempre' });
    const res = await svc.getPlanChangeOptions(T, U);
    expect(res.options).toEqual([]);
    expect(res.freeTier).toBeNull();
  });

  it('con la baja programada lo dice (y no esconde las opciones)', async () => {
    await liveSub({ cancelAtPeriodEnd: true });
    const res = await svc.getPlanChangeOptions(T, U);
    expect(res.blockedReason).toBe('cancel_scheduled');
    expect(res.options.length).toBeGreaterThan(0);
  });
});

describe('webhook customer.subscription.updated con otro plan en la metadata', () => {
  function subscriptions() {
    return new SubscriptionsService(
      prisma as never,
      async () => stripe.adapter,
      {
        publish: async (_t, _a, name, payload) => {
          events.push({ name, payload });
        },
      },
      { successUrl: () => '', cancelUrl: () => '' },
    );
  }
  function updated(planId: string, eventId: string): Stripe.Event {
    return {
      id: eventId,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_stripe_1',
          status: 'active',
          cancel_at_period_end: false,
          current_period_end: 1_900_000_000,
          trial_end: null,
          metadata: { membership: '1', tenantId: T, planId },
          items: { data: [{ price: { id: 'price_pro_stripe' } }] },
        },
      },
    } as unknown as Stripe.Event;
  }

  it('reconcilia el cambio que Stripe ya aplicó (una vez) y no repite el aviso', async () => {
    const sub = await liveSub();
    const subs = subscriptions();
    await subs.handleWebhookEvent(updated(planPro.id as string, 'evt_1'), {}, { tenantId: T });
    const row = await prisma.modSubscriptionsSubscription.findFirst({ where: { id: sub.id } });
    expect(row).toMatchObject({
      planId: planPro.id,
      stripePriceId: 'price_pro_stripe',
      unitAmount: 3000,
    });
    const changed = events.filter((e) => e.name === 'subscriptions.membership.plan_changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.payload).toMatchObject({ via: 'webhook', fromPlanId: planBasico.id });

    // Otro evento (Stripe lo reenvía) con el mismo plan: ya no hay nada que cambiar.
    await subs.handleWebhookEvent(updated(planPro.id as string, 'evt_2'), {}, { tenantId: T });
    expect(events.filter((e) => e.name === 'subscriptions.membership.plan_changed')).toHaveLength(
      1,
    );
  });

  it('cambio desde la cuenta y después el webhook: un único aviso', async () => {
    await liveSub();
    await svc.changePlan(T, U, planPro.id as string);
    await subscriptions().handleWebhookEvent(
      updated(planPro.id as string, 'evt_3'),
      {},
      { tenantId: T },
    );
    expect(events.filter((e) => e.name === 'subscriptions.membership.plan_changed')).toHaveLength(
      1,
    );
  });

  it('un planId de OTRA aula en la metadata no toca nada', async () => {
    const otro = await prisma.modSubscriptionsPlan.create({
      data: {
        tenantId: 'otra-aula',
        tierId: null,
        name: 'Ajeno',
        intervalMonths: 1,
        amountCents: 1,
        currency: 'eur',
        active: true,
      },
    });
    const sub = await liveSub();
    await subscriptions().handleWebhookEvent(
      updated(otro.id as string, 'evt_4'),
      {},
      { tenantId: T },
    );
    const row = await prisma.modSubscriptionsSubscription.findFirst({ where: { id: sub.id } });
    expect(row?.planId).toBe(planBasico.id);
    expect(events.filter((e) => e.name === 'subscriptions.membership.plan_changed')).toHaveLength(
      0,
    );
  });
});
