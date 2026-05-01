/**
 * Tests unit del SubscriptionsService — sin red, sin DB real, sin Stripe SDK.
 *
 * Estrategia (paralela a billing.service.test.ts):
 *  - Prisma mockeado con mapas in-memory.
 *  - SubscriptionsStripeAdapter stub determinista.
 *  - Publisher stub que captura todos los publish().
 *
 * Cobertura priorizada:
 *  - startSubscription: rechaza price no recurring, rechaza price inactivo,
 *    rechaza si ya hay sub ACTIVE/PAST_DUE/PENDING, crea sub PENDING + emite created.
 *  - cancelSubscription: at-period-end marca cancelAtPeriodEnd, immediate marca CANCELED y emite,
 *    PENDING sin stripeId se cancela localmente, no permite cancelar sub ajena.
 *  - handleWebhookEvent: idempotencia (segundo evento mismo id no procesa),
 *    customer.subscription.created activa → emite activated,
 *    invoice.payment_failed inicia gracePeriodEndsAt + emite past_due,
 *    invoice.paid recovery (PAST_DUE→ACTIVE) emite activated con recovery=true,
 *    customer.subscription.deleted → CANCELED + emite canceled.
 *  - expireGracePeriods: PAST_DUE con gracePeriod expirado → UNPAID + emite unpaid.
 *  - listMine devuelve solo del user.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import {
  SubscriptionsService,
  type SubscriptionsEventPublisher,
  type CheckoutUrlBuilder,
} from '../src/subscriptions.service.js';
import {
  SubscriptionAlreadyActiveError,
  SubscriptionAccessDeniedError,
  SubscriptionPriceNotRecurringError,
  StripeApiError,
} from '../src/errors.js';
import type {
  SubscriptionsStripeAdapter,
  StripePriceResult,
  StripeSubscriptionView,
} from '../src/stripe-subscriptions.client.js';

// ---------- Mocks ----------

type SubStatus = 'PENDING' | 'ACTIVE' | 'PAST_DUE' | 'UNPAID' | 'CANCELED';
type InvoiceStatus = 'OPEN' | 'PAID' | 'UNCOLLECTIBLE' | 'VOID';

interface SubRow {
  id: string;
  tenantId: string;
  userId: string;
  courseId: string;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string;
  stripePriceId: string;
  status: SubStatus;
  unitAmount: number;
  currency: string;
  interval: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  gracePeriodEndsAt: Date | null;
  canceledAt: Date | null;
  canceledReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface InvoiceRow {
  id: string;
  tenantId: string;
  subscriptionId: string;
  stripeInvoiceId: string;
  status: InvoiceStatus;
  amount: number;
  currency: string;
  hostedInvoiceUrl: string | null;
  paidAt: Date | null;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface WebhookEventRow {
  stripeEventId: string;
  tenantId: string | null;
  type: string;
  subscriptionId: string | null;
  payload: unknown;
  processedAt: Date | null;
  errorMessage: string | null;
  receivedAt: Date;
}

class MockPrisma {
  subs = new Map<string, SubRow>();
  invoices = new Map<string, InvoiceRow>();
  webhookEvents = new Map<string, WebhookEventRow>();
  private subSeq = 0;
  private invSeq = 0;

  modSubscriptionsSubscription = {
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const where = args.where;
      for (const s of this.subs.values()) {
        const tenantOk = !where['tenantId'] || s.tenantId === where['tenantId'];
        const idOk = !where['id'] || s.id === where['id'];
        const userOk = !where['userId'] || s.userId === where['userId'];
        const courseOk = !where['courseId'] || s.courseId === where['courseId'];
        const statusFilter = where['status'] as { in?: SubStatus[] } | SubStatus | undefined;
        let statusOk = true;
        if (statusFilter && typeof statusFilter === 'object' && 'in' in statusFilter) {
          statusOk = statusFilter.in!.includes(s.status);
        } else if (typeof statusFilter === 'string') {
          statusOk = s.status === statusFilter;
        }
        if (tenantOk && idOk && userOk && courseOk && statusOk) return s;
      }
      return null;
    },
    findUnique: async (args: { where: { id?: string; stripeSubscriptionId?: string } }) => {
      if (args.where.id) return this.subs.get(args.where.id) ?? null;
      if (args.where.stripeSubscriptionId) {
        for (const s of this.subs.values()) {
          if (s.stripeSubscriptionId === args.where.stripeSubscriptionId) return s;
        }
      }
      return null;
    },
    findMany: async (args: { where: { tenantId: string; userId?: string }; orderBy?: unknown }) => {
      return [...this.subs.values()]
        .filter(
          (s) =>
            s.tenantId === args.where.tenantId &&
            (!args.where.userId || s.userId === args.where.userId),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
    create: async (args: { data: Omit<SubRow, 'id' | 'createdAt' | 'updatedAt'> }) => {
      this.subSeq += 1;
      const id = `sub-${this.subSeq}`;
      const row: SubRow = {
        id,
        ...args.data,
        currentPeriodEnd: args.data.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: args.data.cancelAtPeriodEnd ?? false,
        gracePeriodEndsAt: args.data.gracePeriodEndsAt ?? null,
        canceledAt: args.data.canceledAt ?? null,
        canceledReason: args.data.canceledReason ?? null,
        stripeSubscriptionId: args.data.stripeSubscriptionId ?? null,
        currency: args.data.currency ?? 'eur',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.subs.set(id, row);
      return row;
    },
    update: async (args: { where: { id: string }; data: Partial<SubRow> }) => {
      const row = this.subs.get(args.where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, args.data, { updatedAt: new Date() });
      return row;
    },
    delete: async (args: { where: { id: string } }) => {
      this.subs.delete(args.where.id);
    },
  };

  modSubscriptionsInvoice = {
    findUnique: async (args: { where: { stripeInvoiceId: string } }) => {
      for (const inv of this.invoices.values()) {
        if (inv.stripeInvoiceId === args.where.stripeInvoiceId) return inv;
      }
      return null;
    },
    findMany: async (args: {
      where: { tenantId: string; subscriptionId: string };
      orderBy?: unknown;
    }) => {
      return [...this.invoices.values()].filter(
        (i) => i.tenantId === args.where.tenantId && i.subscriptionId === args.where.subscriptionId,
      );
    },
    create: async (args: { data: Omit<InvoiceRow, 'id' | 'createdAt' | 'updatedAt'> }) => {
      this.invSeq += 1;
      const id = `inv-${this.invSeq}`;
      const row: InvoiceRow = {
        id,
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.invoices.set(id, row);
      return row;
    },
    update: async (args: { where: { id: string }; data: Partial<InvoiceRow> }) => {
      const row = this.invoices.get(args.where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, args.data, { updatedAt: new Date() });
      return row;
    },
  };

  modSubscriptionsWebhookEvent = {
    create: async (args: {
      data: Omit<
        WebhookEventRow,
        'processedAt' | 'errorMessage' | 'receivedAt' | 'tenantId' | 'subscriptionId'
      > &
        Partial<WebhookEventRow>;
    }) => {
      if (this.webhookEvents.has(args.data.stripeEventId)) {
        throw new Error(
          'Unique constraint failed on the fields: (`stripe_event_id`) of mod_subscriptions_webhook_event',
        );
      }
      const row: WebhookEventRow = {
        stripeEventId: args.data.stripeEventId,
        tenantId: args.data.tenantId ?? null,
        type: args.data.type,
        subscriptionId: args.data.subscriptionId ?? null,
        payload: args.data.payload,
        processedAt: null,
        errorMessage: null,
        receivedAt: new Date(),
      };
      this.webhookEvents.set(args.data.stripeEventId, row);
      return row;
    },
    update: async (args: { where: { stripeEventId: string }; data: Partial<WebhookEventRow> }) => {
      const row = this.webhookEvents.get(args.where.stripeEventId);
      if (!row) throw new Error('not found');
      Object.assign(row, args.data);
      return row;
    },
  };
}

class StripeStub implements SubscriptionsStripeAdapter {
  prices = new Map<string, StripePriceResult>();
  createdSessions: Array<Record<string, unknown>> = [];
  cancelCalls: Array<{ id: string; atPeriodEnd: boolean }> = [];
  shouldFailCheckout = false;
  pendingSubViewById = new Map<string, StripeSubscriptionView>();

  setPrice(id: string, recurring: 'month' | 'year' | null, active = true) {
    this.prices.set(id, {
      id,
      productId: 'prod_test',
      unitAmount: 1999,
      currency: 'eur',
      active,
      recurringInterval: recurring,
    });
  }

  async retrievePrice(priceId: string): Promise<StripePriceResult> {
    const p = this.prices.get(priceId);
    if (!p) throw new Error('price not found in stub');
    return p;
  }

  async createCheckoutSession(p: {
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
  }) {
    if (this.shouldFailCheckout) {
      throw new StripeApiError('forced failure');
    }
    this.createdSessions.push({ ...p });
    return { id: `cs_${this.createdSessions.length}`, url: 'https://stripe/checkout/x' };
  }

  async cancelSubscription(
    subscriptionId: string,
    atPeriodEnd: boolean,
  ): Promise<StripeSubscriptionView> {
    this.cancelCalls.push({ id: subscriptionId, atPeriodEnd });
    const view = this.pendingSubViewById.get(subscriptionId);
    if (view) return view;
    return {
      id: subscriptionId,
      status: atPeriodEnd ? 'active' : 'canceled',
      cancelAtPeriodEnd: atPeriodEnd,
      currentPeriodEnd: Math.floor(Date.now() / 1000) + 86400 * 7,
      canceledAt: atPeriodEnd ? null : Math.floor(Date.now() / 1000),
    };
  }

  constructWebhookEvent(): Stripe.Event {
    throw new Error('not used in unit tests');
  }
}

class PublisherStub implements SubscriptionsEventPublisher {
  events: Array<{
    tenantId: string;
    actorId: string | null;
    name: string;
    payload: Record<string, unknown>;
  }> = [];
  async publish(
    tenantId: string,
    actorId: string | null,
    name: string,
    payload: Record<string, unknown>,
  ) {
    this.events.push({ tenantId, actorId, name, payload });
  }
}

const URLS: CheckoutUrlBuilder = {
  successUrl: (courseId) => `https://app/checkout/success?course=${courseId}`,
  cancelUrl: (courseId) => `https://app/checkout/cancel?course=${courseId}`,
};

// ---------- Helpers de fixtures ----------

function buildSystem(opts?: { gracePeriodDays?: number }) {
  const prisma = new MockPrisma();
  const stripe = new StripeStub();
  const publisher = new PublisherStub();
  // Default precio recurring listo para usar.
  stripe.setPrice('price_recurring', 'month');
  stripe.setPrice('price_oneshot', null);
  stripe.setPrice('price_inactive', 'month', false);
  const service = new SubscriptionsService(
    prisma as never,
    stripe,
    publisher,
    URLS,
    opts?.gracePeriodDays ?? 3,
  );
  return { prisma, stripe, publisher, service };
}

function makeStripeSub(over: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'sub_stripe_1',
    object: 'subscription',
    status: 'active',
    current_period_end: now + 86400 * 30,
    cancel_at_period_end: false,
    customer: 'cus_test',
    metadata: { subscriptionLocalId: '' },
    ...over,
  } as unknown as Stripe.Subscription;
}

function makeStripeInvoice(over: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id: 'in_stripe_1',
    object: 'invoice',
    amount_paid: 1999,
    amount_due: 1999,
    currency: 'eur',
    period_start: Math.floor(Date.now() / 1000),
    period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
    subscription: 'sub_stripe_1',
    hosted_invoice_url: 'https://stripe/invoice/x',
    attempt_count: 1,
    next_payment_attempt: null,
    ...over,
  } as unknown as Stripe.Invoice;
}

// ---------- Tests ----------

describe('SubscriptionsService.startSubscription', () => {
  it('rechaza price no recurring', async () => {
    const { service } = buildSystem();
    await expect(
      service.startSubscription({
        tenantId: 't',
        userId: 'u',
        userEmail: 'a@b.c',
        courseId: 'c1',
        stripePriceId: 'price_oneshot',
      }),
    ).rejects.toBeInstanceOf(SubscriptionPriceNotRecurringError);
  });

  it('rechaza price inactivo', async () => {
    const { service } = buildSystem();
    await expect(
      service.startSubscription({
        tenantId: 't',
        userId: 'u',
        userEmail: 'a@b.c',
        courseId: 'c1',
        stripePriceId: 'price_inactive',
      }),
    ).rejects.toBeInstanceOf(StripeApiError);
  });

  it('rechaza si ya hay sub PENDING/ACTIVE/PAST_DUE para mismo course', async () => {
    const { service, prisma } = buildSystem();
    prisma.subs.set('existing', {
      id: 'existing',
      tenantId: 't',
      userId: 'u',
      courseId: 'c1',
      stripeSubscriptionId: 'sub_x',
      stripeCustomerId: 'cus_x',
      stripePriceId: 'price_recurring',
      status: 'ACTIVE',
      unitAmount: 1999,
      currency: 'eur',
      interval: 'month',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      gracePeriodEndsAt: null,
      canceledAt: null,
      canceledReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      service.startSubscription({
        tenantId: 't',
        userId: 'u',
        userEmail: 'a@b.c',
        courseId: 'c1',
        stripePriceId: 'price_recurring',
      }),
    ).rejects.toBeInstanceOf(SubscriptionAlreadyActiveError);
  });

  it('crea sub PENDING + checkout session + emite created', async () => {
    const { service, prisma, publisher } = buildSystem();
    const result = await service.startSubscription({
      tenantId: 't',
      userId: 'u',
      userEmail: 'a@b.c',
      courseId: 'c1',
      stripePriceId: 'price_recurring',
    });
    expect(result.url).toContain('stripe/checkout');
    expect([...prisma.subs.values()]).toHaveLength(1);
    expect([...prisma.subs.values()][0]!.status).toBe('PENDING');
    expect(
      publisher.events.find((e) => e.name === 'subscriptions.subscription.created'),
    ).toBeTruthy();
  });

  it('limpia row local si Stripe falla en createCheckout', async () => {
    const { service, prisma, stripe } = buildSystem();
    stripe.shouldFailCheckout = true;
    await expect(
      service.startSubscription({
        tenantId: 't',
        userId: 'u',
        userEmail: 'a@b.c',
        courseId: 'c1',
        stripePriceId: 'price_recurring',
      }),
    ).rejects.toBeInstanceOf(StripeApiError);
    expect([...prisma.subs.values()]).toHaveLength(0);
  });
});

describe('SubscriptionsService.cancelSubscription', () => {
  function seedActive(prisma: MockPrisma) {
    prisma.subs.set('s1', {
      id: 's1',
      tenantId: 't',
      userId: 'u',
      courseId: 'c1',
      stripeSubscriptionId: 'sub_stripe_1',
      stripeCustomerId: 'cus_x',
      stripePriceId: 'price_recurring',
      status: 'ACTIVE',
      unitAmount: 1999,
      currency: 'eur',
      interval: 'month',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      gracePeriodEndsAt: null,
      canceledAt: null,
      canceledReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it('al final del periodo: marca cancelAtPeriodEnd y NO emite canceled', async () => {
    const { service, prisma, publisher, stripe } = buildSystem();
    seedActive(prisma);
    await service.cancelSubscription('t', 'u', 's1');
    expect(prisma.subs.get('s1')!.cancelAtPeriodEnd).toBe(true);
    expect(prisma.subs.get('s1')!.status).toBe('ACTIVE');
    expect(stripe.cancelCalls[0]!.atPeriodEnd).toBe(true);
    expect(
      publisher.events.find((e) => e.name === 'subscriptions.subscription.canceled'),
    ).toBeFalsy();
  });

  it('immediate: marca CANCELED + emite canceled', async () => {
    const { service, prisma, publisher } = buildSystem();
    seedActive(prisma);
    await service.cancelSubscription('t', 'u', 's1', { immediate: true });
    expect(prisma.subs.get('s1')!.status).toBe('CANCELED');
    expect(prisma.subs.get('s1')!.canceledReason).toBe('user_request');
    const ev = publisher.events.find((e) => e.name === 'subscriptions.subscription.canceled');
    expect(ev).toBeTruthy();
    expect(ev!.payload['immediate']).toBe(true);
  });

  it('rechaza cancelar sub ajena', async () => {
    const { service, prisma } = buildSystem();
    seedActive(prisma);
    await expect(service.cancelSubscription('t', 'OTHER_USER', 's1')).rejects.toBeInstanceOf(
      SubscriptionAccessDeniedError,
    );
  });

  it('cancela PENDING sin stripeId localmente sin llamar a Stripe', async () => {
    const { service, prisma, stripe } = buildSystem();
    prisma.subs.set('s1', {
      id: 's1',
      tenantId: 't',
      userId: 'u',
      courseId: 'c1',
      stripeSubscriptionId: null,
      stripeCustomerId: '',
      stripePriceId: 'price_recurring',
      status: 'PENDING',
      unitAmount: 1999,
      currency: 'eur',
      interval: 'month',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      gracePeriodEndsAt: null,
      canceledAt: null,
      canceledReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await service.cancelSubscription('t', 'u', 's1');
    expect(prisma.subs.get('s1')!.status).toBe('CANCELED');
    expect(stripe.cancelCalls).toHaveLength(0);
  });
});

describe('SubscriptionsService.handleWebhookEvent', () => {
  it('idempotencia: segundo evento con mismo id no procesa', async () => {
    const { service, prisma } = buildSystem();
    const event = {
      id: 'evt_1',
      type: 'customer.subscription.created',
      data: { object: makeStripeSub() },
    } as unknown as Stripe.Event;
    await service.handleWebhookEvent(event, {});
    await service.handleWebhookEvent(event, {});
    expect(prisma.webhookEvents.size).toBe(1);
  });

  it('customer.subscription.created en estado active → ACTIVE + emite activated', async () => {
    const { service, prisma, publisher } = buildSystem();
    prisma.subs.set('s1', {
      id: 's1',
      tenantId: 't',
      userId: 'u',
      courseId: 'c1',
      stripeSubscriptionId: null,
      stripeCustomerId: '',
      stripePriceId: 'price_recurring',
      status: 'PENDING',
      unitAmount: 1999,
      currency: 'eur',
      interval: 'month',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      gracePeriodEndsAt: null,
      canceledAt: null,
      canceledReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const stripeSub = makeStripeSub({ metadata: { subscriptionLocalId: 's1' } });
    const event = {
      id: 'evt_2',
      type: 'customer.subscription.created',
      data: { object: stripeSub },
    } as unknown as Stripe.Event;
    await service.handleWebhookEvent(event, {});
    expect(prisma.subs.get('s1')!.status).toBe('ACTIVE');
    expect(prisma.subs.get('s1')!.stripeSubscriptionId).toBe('sub_stripe_1');
    const ev = publisher.events.find((e) => e.name === 'subscriptions.subscription.activated');
    expect(ev).toBeTruthy();
  });

  it('invoice.payment_failed → PAST_DUE + setea gracePeriodEndsAt + emite past_due', async () => {
    const { service, prisma, publisher } = buildSystem({ gracePeriodDays: 3 });
    prisma.subs.set('s1', {
      id: 's1',
      tenantId: 't',
      userId: 'u',
      courseId: 'c1',
      stripeSubscriptionId: 'sub_stripe_1',
      stripeCustomerId: 'cus_x',
      stripePriceId: 'price_recurring',
      status: 'ACTIVE',
      unitAmount: 1999,
      currency: 'eur',
      interval: 'month',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      gracePeriodEndsAt: null,
      canceledAt: null,
      canceledReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const event = {
      id: 'evt_3',
      type: 'invoice.payment_failed',
      data: { object: makeStripeInvoice() },
    } as unknown as Stripe.Event;
    await service.handleWebhookEvent(event, {});
    const sub = prisma.subs.get('s1')!;
    expect(sub.status).toBe('PAST_DUE');
    expect(sub.gracePeriodEndsAt).toBeInstanceOf(Date);
    const ev = publisher.events.find((e) => e.name === 'subscriptions.subscription.past_due');
    expect(ev).toBeTruthy();
  });

  it('invoice.paid recovery desde PAST_DUE → ACTIVE + emite activated con recovery', async () => {
    const { service, prisma, publisher } = buildSystem();
    prisma.subs.set('s1', {
      id: 's1',
      tenantId: 't',
      userId: 'u',
      courseId: 'c1',
      stripeSubscriptionId: 'sub_stripe_1',
      stripeCustomerId: 'cus_x',
      stripePriceId: 'price_recurring',
      status: 'PAST_DUE',
      unitAmount: 1999,
      currency: 'eur',
      interval: 'month',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      gracePeriodEndsAt: new Date(Date.now() + 86400 * 1000),
      canceledAt: null,
      canceledReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const event = {
      id: 'evt_4',
      type: 'invoice.paid',
      data: { object: makeStripeInvoice() },
    } as unknown as Stripe.Event;
    await service.handleWebhookEvent(event, {});
    const sub = prisma.subs.get('s1')!;
    expect(sub.status).toBe('ACTIVE');
    expect(sub.gracePeriodEndsAt).toBeNull();
    const ev = publisher.events.find(
      (e) => e.name === 'subscriptions.subscription.activated' && e.payload['recovery'] === true,
    );
    expect(ev).toBeTruthy();
  });

  it('customer.subscription.deleted → CANCELED + emite canceled', async () => {
    const { service, prisma, publisher } = buildSystem();
    prisma.subs.set('s1', {
      id: 's1',
      tenantId: 't',
      userId: 'u',
      courseId: 'c1',
      stripeSubscriptionId: 'sub_stripe_1',
      stripeCustomerId: 'cus_x',
      stripePriceId: 'price_recurring',
      status: 'ACTIVE',
      unitAmount: 1999,
      currency: 'eur',
      interval: 'month',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: true,
      gracePeriodEndsAt: null,
      canceledAt: null,
      canceledReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const event = {
      id: 'evt_5',
      type: 'customer.subscription.deleted',
      data: { object: makeStripeSub({ status: 'canceled' }) },
    } as unknown as Stripe.Event;
    await service.handleWebhookEvent(event, {});
    expect(prisma.subs.get('s1')!.status).toBe('CANCELED');
    expect(publisher.events.some((e) => e.name === 'subscriptions.subscription.canceled')).toBe(
      true,
    );
  });
});

describe('SubscriptionsService.expireGracePeriods', () => {
  it('marca como UNPAID las PAST_DUE con grace expirado y emite unpaid', async () => {
    const { service, prisma, publisher } = buildSystem();
    prisma.subs.set('s1', {
      id: 's1',
      tenantId: 't',
      userId: 'u',
      courseId: 'c1',
      stripeSubscriptionId: 'sub_stripe_1',
      stripeCustomerId: 'cus_x',
      stripePriceId: 'price_recurring',
      status: 'PAST_DUE',
      unitAmount: 1999,
      currency: 'eur',
      interval: 'month',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      gracePeriodEndsAt: new Date(Date.now() - 1000),
      canceledAt: null,
      canceledReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // Otra sub con grace todavía vivo no se debe tocar.
    prisma.subs.set('s2', {
      id: 's2',
      tenantId: 't',
      userId: 'u2',
      courseId: 'c2',
      stripeSubscriptionId: 'sub_stripe_2',
      stripeCustomerId: 'cus_y',
      stripePriceId: 'price_recurring',
      status: 'PAST_DUE',
      unitAmount: 1999,
      currency: 'eur',
      interval: 'month',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      gracePeriodEndsAt: new Date(Date.now() + 86400 * 1000),
      canceledAt: null,
      canceledReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // El mock findMany no implementa el filtro `gracePeriodEndsAt: { lte }`,
    // así que para este test añadimos override del findMany.
    prisma.modSubscriptionsSubscription.findMany = (async () => {
      return [...prisma.subs.values()].filter(
        (s) => s.status === 'PAST_DUE' && s.gracePeriodEndsAt && s.gracePeriodEndsAt < new Date(),
      );
    }) as never;

    const expired = await service.expireGracePeriods();
    expect(expired).toHaveLength(1);
    expect(expired[0]!.id).toBe('s1');
    expect(prisma.subs.get('s1')!.status).toBe('UNPAID');
    expect(prisma.subs.get('s2')!.status).toBe('PAST_DUE'); // sin tocar
    expect(publisher.events.some((e) => e.name === 'subscriptions.subscription.unpaid')).toBe(true);
  });
});

describe('SubscriptionsService.listMine', () => {
  it('lista solo subs del user en el tenant', async () => {
    const { service, prisma } = buildSystem();
    prisma.subs.set('a', {
      id: 'a',
      tenantId: 't',
      userId: 'me',
      courseId: 'c1',
      stripeSubscriptionId: null,
      stripeCustomerId: '',
      stripePriceId: 'p',
      status: 'ACTIVE',
      unitAmount: 0,
      currency: 'eur',
      interval: 'month',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      gracePeriodEndsAt: null,
      canceledAt: null,
      canceledReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.subs.set('b', {
      id: 'b',
      tenantId: 't',
      userId: 'other',
      courseId: 'c2',
      stripeSubscriptionId: null,
      stripeCustomerId: '',
      stripePriceId: 'p',
      status: 'ACTIVE',
      unitAmount: 0,
      currency: 'eur',
      interval: 'month',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      gracePeriodEndsAt: null,
      canceledAt: null,
      canceledReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const mine = await service.listMine('t', 'me');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).toBe('a');
  });
});
