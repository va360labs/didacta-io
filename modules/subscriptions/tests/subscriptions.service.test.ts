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
  SubscriptionPriceNotForCourseError,
  SubscriptionPriceNotRecurringError,
  StripeApiError,
  WebhookOutOfOrderError,
} from '../src/errors.js';
import type {
  SubscriptionsStripeAdapter,
  StripePriceResult,
  StripeSubscriptionView,
} from '../src/stripe-subscriptions.client.js';

// ---------- Mocks ----------

type SubStatus = 'PENDING' | 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'UNPAID' | 'CANCELED';
type InvoiceStatus = 'OPEN' | 'PAID' | 'UNCOLLECTIBLE' | 'VOID';

interface SubRow {
  id: string;
  tenantId: string;
  userId: string;
  courseId: string | null;
  /** Plan de membresía — null en subs por curso. */
  planId?: string | null;
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
  trialEndsAt?: Date | null;
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
        // Copia: Prisma devuelve snapshots — si devolviéramos la referencia
        // viva, un update posterior mutaría lo que el service ya leyó y las
        // comparaciones old-status vs new-status quedarían siempre iguales.
        if (tenantOk && idOk && userOk && courseOk && statusOk) return { ...s };
      }
      return null;
    },
    findUnique: async (args: { where: { id?: string; stripeSubscriptionId?: string } }) => {
      if (args.where.id) {
        const row = this.subs.get(args.where.id);
        return row ? { ...row } : null;
      }
      if (args.where.stripeSubscriptionId) {
        for (const s of this.subs.values()) {
          if (s.stripeSubscriptionId === args.where.stripeSubscriptionId) return { ...s };
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
    // CAS del barrido de grace: si el estado ya no es el esperado, 0 filas.
    updateMany: async (args: {
      where: { id: string; status?: string; gracePeriodEndsAt?: { lte: Date } };
      data: Partial<SubRow>;
    }) => {
      const row = this.subs.get(args.where.id);
      if (!row) return { count: 0 };
      if (args.where.status && row.status !== args.where.status) return { count: 0 };
      const lte = args.where.gracePeriodEndsAt?.lte;
      if (lte && !(row.gracePeriodEndsAt && row.gracePeriodEndsAt <= lte)) return { count: 0 };
      Object.assign(row, args.data, { updatedAt: new Date() });
      return { count: 1 };
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
    // Evidencia de pago del trial: { subscriptionId, status: 'PAID', amount: { gt: 0 } }.
    findFirst: async (args: {
      where: { subscriptionId?: string; status?: InvoiceStatus; amount?: { gt?: number } };
    }) => {
      for (const i of this.invoices.values()) {
        if (args.where.subscriptionId && i.subscriptionId !== args.where.subscriptionId) continue;
        if (args.where.status && i.status !== args.where.status) continue;
        if (args.where.amount?.gt !== undefined && !(i.amount > args.where.amount.gt)) continue;
        return { ...i };
      }
      return null;
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
    findUnique: async (args: { where: { stripeEventId: string } }) =>
      this.webhookEvents.get(args.where.stripeEventId) ?? null,
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

  async createProduct(): Promise<string> {
    throw new Error('not used in unit tests');
  }

  async updateProduct(): Promise<void> {
    throw new Error('not used in unit tests');
  }

  async createRecurringPrice(): Promise<string> {
    throw new Error('not used in unit tests');
  }

  endTrialNowCalls: string[] = [];
  endTrialNowResult: (StripeSubscriptionView & { latestInvoicePaid: boolean }) | null = null;

  async endTrialNow(
    subscriptionId: string,
  ): Promise<StripeSubscriptionView & { latestInvoicePaid: boolean }> {
    this.endTrialNowCalls.push(subscriptionId);
    return (
      this.endTrialNowResult ?? {
        id: subscriptionId,
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: Math.floor(Date.now() / 1000) + 86400 * 30,
        canceledAt: null,
        latestInvoicePaid: true,
      }
    );
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

function buildSystem(opts?: {
  gracePeriodDays?: number;
  coursePrices?: (tenantId: string, courseId: string) => Promise<string[]>;
}) {
  const prisma = new MockPrisma();
  const stripe = new StripeStub();
  const publisher = new PublisherStub();
  // Default precio recurring listo para usar.
  stripe.setPrice('price_recurring', 'month');
  stripe.setPrice('price_oneshot', null);
  stripe.setPrice('price_inactive', 'month', false);
  // Catalogo curso -> precios. Por defecto, los tres prices del stub estan
  // vinculados al curso de los tests; los casos que prueban el binding pasan
  // el suyo.
  const coursePrices =
    opts?.coursePrices ?? (async () => ['price_recurring', 'price_oneshot', 'price_inactive']);
  const service = new SubscriptionsService(
    prisma as never,
    async () => stripe,
    publisher,
    URLS,
    opts?.gracePeriodDays ?? 3,
    coursePrices,
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

/**
 * La MISMA invoice tal y como la entrega Stripe con una versión de API
 * moderna: sin `subscription` en la raíz, colgando de
 * `parent.subscription_details.subscription`.
 *
 * No es hipotético. La cuenta real entregaba `2025-12-15.clover` mientras el
 * SDK fijaba `2024-12-18.acacia` para las llamadas, y por ahí se perdieron en
 * producción los 8 `invoice.paid` que hubo.
 */
function makeStripeInvoiceFormaNueva(over: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  const base = makeStripeInvoice(over) as unknown as Record<string, unknown>;
  delete base['subscription'];
  base['parent'] = {
    type: 'subscription_details',
    quote_details: null,
    subscription_details: { subscription: 'sub_stripe_1', metadata: {} },
  };
  return base as unknown as Stripe.Invoice;
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

describe('SubscriptionsService.startSubscription — el precio no lo elige el cliente (C4)', () => {
  const input = {
    tenantId: 't',
    userId: 'u',
    userEmail: 'a@b.c',
    courseId: 'curso-caro',
    stripePriceId: 'price_recurring',
  };

  it('rechaza un price recurrente que no esta vinculado a ESE curso', async () => {
    // El precio de la membresia mas barata: existe, esta activo y es
    // recurrente. Antes bastaba con eso para suscribirse al curso caro a ese
    // importe.
    const { service, prisma } = buildSystem({
      coursePrices: async () => ['price_del_curso_caro'],
    });

    await expect(service.startSubscription(input)).rejects.toBeInstanceOf(
      SubscriptionPriceNotForCourseError,
    );
    // Y no deja fila local a medias.
    expect(prisma.subs.size).toBe(0);
  });

  it('sin catalogo configurado no se vende (falla del lado seguro)', async () => {
    const { service } = buildSystem({ coursePrices: async () => [] });

    await expect(service.startSubscription(input)).rejects.toBeInstanceOf(
      SubscriptionPriceNotForCourseError,
    );
  });

  it('acepta el price que si esta vinculado al curso', async () => {
    const { service } = buildSystem({ coursePrices: async () => ['price_recurring'] });

    await expect(service.startSubscription(input)).resolves.toMatchObject({
      url: expect.any(String),
    });
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

  it('un evento que fallo a medias SI se reintenta: no se quema (C3)', async () => {
    const { service, prisma } = buildSystem();
    prisma.subs.set('s1', {
      id: 's1',
      tenantId: 't',
      userId: 'u',
      courseId: 'c1',
      stripeSubscriptionId: 'sub_stripe_1',
      stripeCustomerId: 'cus_test',
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
      planId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const event = {
      id: 'evt_deleted',
      type: 'customer.subscription.deleted',
      data: { object: makeStripeSub({ status: 'canceled' }) },
    } as unknown as Stripe.Event;

    // Primer intento: la fila del evento se inserta y el trabajo de dominio
    // revienta con un fallo transitorio. Queda `processedAt: null`.
    const romper = new Error('conexion caida');
    const original = prisma.subs.get('s1')!;
    let fallar = true;
    const updateOriginal = prisma.modSubscriptionsSubscription.update;
    prisma.modSubscriptionsSubscription.update = (async (args: never) => {
      if (fallar) throw romper;
      return updateOriginal.call(prisma.modSubscriptionsSubscription, args);
    }) as typeof updateOriginal;

    await expect(service.handleWebhookEvent(event, {})).rejects.toThrow('conexion caida');
    expect(prisma.webhookEvents.get('evt_deleted')!.processedAt).toBeNull();
    expect(prisma.subs.get('s1')!.status).toBe('ACTIVE'); // sigue viva en local

    // Stripe reintenta. Antes, el choque con la PK devolvia 200 en silencio y
    // la sub se quedaba ACTIVE para siempre con la sub muerta en Stripe.
    fallar = false;
    await service.handleWebhookEvent(event, {});

    expect(prisma.subs.get('s1')!.status).toBe('CANCELED');
    expect(prisma.webhookEvents.get('evt_deleted')!.processedAt).not.toBeNull();
    expect(original).toBeTruthy();
  });

  it('un evento ya procesado con exito no se vuelve a procesar', async () => {
    const { service, prisma, publisher } = buildSystem();
    const event = {
      id: 'evt_ok',
      type: 'customer.subscription.created',
      data: { object: makeStripeSub() },
    } as unknown as Stripe.Event;

    await service.handleWebhookEvent(event, {});
    const publicadosTrasElPrimero = publisher.events.length;
    await service.handleWebhookEvent(event, {});

    expect(publisher.events.length).toBe(publicadosTrasElPrimero);
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

  // El alta cuyo cobro no era inmediato: Stripe deja la suscripción
  // `incomplete` (→ PENDING) y confirma minutos u horas después. Si esa
  // confirmación no emite `activated`, el bridge de grupos de acceso no se
  // entera y el cliente paga sin recibir nada. Un caso por cada vía por la que
  // Stripe puede traer esa confirmación.

  function seedPendiente(prisma: ReturnType<typeof buildSystem>['prisma']): void {
    prisma.subs.set('s1', {
      id: 's1',
      tenantId: 't',
      userId: 'u',
      courseId: 'c1',
      stripeSubscriptionId: 'sub_stripe_1',
      stripeCustomerId: 'cus_x',
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
  }

  it('invoice.paid sobre una sub PENDING → ACTIVE + emite activated (no era recovery)', async () => {
    const { service, prisma, publisher } = buildSystem();
    seedPendiente(prisma);

    await service.handleWebhookEvent(
      {
        id: 'evt_pend_invoice',
        type: 'invoice.paid',
        data: { object: makeStripeInvoice() },
      } as unknown as Stripe.Event,
      {},
    );

    expect(prisma.subs.get('s1')!.status).toBe('ACTIVE');
    const ev = publisher.events.find((e) => e.name === 'subscriptions.subscription.activated');
    expect(ev).toBeTruthy();
    // Desde PENDING es la PRIMERA activación, no una recuperación de impago.
    expect(ev!.payload['recovery']).toBe(false);
  });

  it('customer.subscription.updated de incomplete a active sobre PENDING → emite activated', async () => {
    const { service, prisma, publisher } = buildSystem();
    seedPendiente(prisma);

    await service.handleWebhookEvent(
      {
        id: 'evt_pend_updated',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_stripe_1',
            status: 'active',
            customer: 'cus_x',
            cancel_at_period_end: false,
            current_period_end: Math.floor(Date.now() / 1000) + 86400,
            trial_end: null,
          },
        },
      } as unknown as Stripe.Event,
      {},
    );

    expect(prisma.subs.get('s1')!.status).toBe('ACTIVE');
    const ev = publisher.events.find((e) => e.name === 'subscriptions.subscription.activated');
    expect(ev).toBeTruthy();
    expect(ev!.payload['recovery']).toBe(false);
  });

  // --- Forma NUEVA de los objetos de Stripe (regresión de un fallo VIVO) ---
  //
  // Encontrado en producción el 16-ago-2026: la cuenta entregaba los webhooks
  // con `2025-12-15.clover` y el código leía la forma de `2024-12-18.acacia`.
  // Los handlers empezaban con `if (!invoice.subscription) return;`, así que
  // TODOS los eventos de invoice se descartaban en silencio: cero facturas
  // guardadas, el impago no marcaba PAST_DUE —quien dejaba de pagar conservaba
  // el acceso— y el trial no convertía nunca. Cero errores en los logs.

  it('invoice.paid en forma nueva (parent.subscription_details) SÍ se procesa', async () => {
    const { service, prisma, publisher } = buildSystem();
    seedPendiente(prisma);

    await service.handleWebhookEvent(
      {
        id: 'evt_clover_paid',
        type: 'invoice.paid',
        data: { object: makeStripeInvoiceFormaNueva() },
      } as unknown as Stripe.Event,
      {},
    );

    expect(prisma.subs.get('s1')!.status).toBe('ACTIVE');
    expect(prisma.invoices.size).toBe(1);
    expect(publisher.events.some((e) => e.name === 'subscriptions.invoice.paid')).toBe(true);
  });

  it('invoice.payment_failed en forma nueva SÍ inicia el impago (si no, se cobra gratis para siempre)', async () => {
    const { service, prisma } = buildSystem();
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

    await service.handleWebhookEvent(
      {
        id: 'evt_clover_failed',
        type: 'invoice.payment_failed',
        data: { object: makeStripeInvoiceFormaNueva() },
      } as unknown as Stripe.Event,
      {},
    );

    expect(prisma.subs.get('s1')!.status).toBe('PAST_DUE');
    expect(prisma.subs.get('s1')!.gracePeriodEndsAt).toBeInstanceOf(Date);
  });

  it('current_period_end solo dentro de items.data → la fecha de renovación se guarda igual', async () => {
    const { service, prisma } = buildSystem();
    seedPendiente(prisma);
    const fin = Math.floor(Date.now() / 1000) + 86400 * 30;

    await service.handleWebhookEvent(
      {
        id: 'evt_clover_updated',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_stripe_1',
            status: 'active',
            customer: 'cus_x',
            cancel_at_period_end: false,
            // Sin `current_period_end` en la raíz: es el cambio de forma.
            items: { data: [{ current_period_end: fin }] },
            trial_end: null,
          },
        },
      } as unknown as Stripe.Event,
      {},
    );

    const sub = prisma.subs.get('s1')!;
    expect(sub.currentPeriodEnd).toBeInstanceOf(Date);
    expect(Math.floor(sub.currentPeriodEnd!.getTime() / 1000)).toBe(fin);
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

// ---------- Periodo de PRUEBA (TRIALING) ----------

/** Fila base de una suscripción de MEMBRESÍA en trial (courseId null + planId). */
function seedTrialingMembership(prisma: MockPrisma, over: Partial<SubRow> = {}): SubRow {
  const row: SubRow = {
    id: 's_trial',
    tenantId: 't',
    userId: 'u',
    courseId: null,
    planId: 'plan_1',
    stripeSubscriptionId: 'sub_stripe_1',
    stripeCustomerId: 'cus_x',
    stripePriceId: 'price_recurring',
    status: 'TRIALING',
    unitAmount: 3990,
    currency: 'eur',
    interval: 'month',
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    gracePeriodEndsAt: null,
    canceledAt: null,
    canceledReason: null,
    trialEndsAt: new Date(Date.now() + 86400 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  prisma.subs.set(row.id, row);
  return row;
}

describe('SubscriptionsService — periodo de prueba (TRIALING)', () => {
  it('customer.subscription.updated con status trialing → TRIALING + sincroniza trialEndsAt', async () => {
    const { service, prisma } = buildSystem();
    seedTrialingMembership(prisma, { status: 'PENDING', trialEndsAt: null });
    const trialEnd = Math.floor(Date.now() / 1000) + 86400;
    const event = {
      id: 'evt_t1',
      type: 'customer.subscription.updated',
      data: { object: makeStripeSub({ status: 'trialing', trial_end: trialEnd }) },
    } as unknown as Stripe.Event;
    await service.handleWebhookEvent(event, {});
    const sub = prisma.subs.get('s_trial')!;
    expect(sub.status).toBe('TRIALING');
    expect(sub.trialEndsAt?.getTime()).toBe(trialEnd * 1000);
  });

  it('ORDEN REAL de Stripe: updated(active) SIN invoice pagada NO saca la sub de TRIALING (el gate sigue encendido)', async () => {
    // Al terminar el trial, Stripe manda updated(active) ANTES de intentar el
    // cobro. Aceptarlo a ciegas apagaría el gate de contenido y regalaría el
    // grace del dunning a quien nunca pagó.
    const { service, prisma } = buildSystem();
    seedTrialingMembership(prisma);
    await service.handleWebhookEvent(
      {
        id: 'evt_o1',
        type: 'customer.subscription.updated',
        data: { object: makeStripeSub({ status: 'active', trial_end: null }) },
      } as unknown as Stripe.Event,
      {},
    );
    const sub = prisma.subs.get('s_trial')!;
    expect(sub.status).toBe('TRIALING');
    // Conserva el trialEndsAt previo (informativo) aunque Stripe ya lo nulló.
    expect(sub.trialEndsAt).not.toBeNull();
  });

  it('ORDEN REAL: updated(active) tras invoice PAID > 0 SÍ pasa a ACTIVE', async () => {
    const { service, prisma } = buildSystem();
    const row = seedTrialingMembership(prisma);
    prisma.invoices.set('inv_paid', {
      id: 'inv_paid',
      tenantId: 't',
      subscriptionId: row.id,
      stripeInvoiceId: 'in_x',
      status: 'PAID',
      amount: 3990,
      currency: 'eur',
      hostedInvoiceUrl: null,
      paidAt: new Date(),
      periodStart: new Date(),
      periodEnd: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await service.handleWebhookEvent(
      {
        id: 'evt_o2',
        type: 'customer.subscription.updated',
        data: { object: makeStripeSub({ status: 'active', trial_end: null }) },
      } as unknown as Stripe.Event,
      {},
    );
    expect(prisma.subs.get('s_trial')!.status).toBe('ACTIVE');
    expect(prisma.subs.get('s_trial')!.trialEndsAt).toBeNull();
  });

  it('cancelar DURANTE el trial sí transiciona: updated(canceled) desde TRIALING → CANCELED + evento', async () => {
    const { service, prisma, publisher } = buildSystem();
    seedTrialingMembership(prisma);
    await service.handleWebhookEvent(
      {
        id: 'evt_o3',
        type: 'customer.subscription.updated',
        data: { object: makeStripeSub({ status: 'canceled' }) },
      } as unknown as Stripe.Event,
      {},
    );
    expect(prisma.subs.get('s_trial')!.status).toBe('CANCELED');
    const canceled = publisher.events.find(
      (e) => e.name === 'subscriptions.subscription.canceled' && e.payload['immediate'] === true,
    );
    expect(canceled).toBeTruthy();
  });

  it('FIN DE TRIAL SIN PAGO: invoice.payment_failed con sub TRIALING → UNPAID directo, SIN grace, emite unpaid', async () => {
    const { service, prisma, publisher } = buildSystem({ gracePeriodDays: 3 });
    seedTrialingMembership(prisma);
    const event = {
      id: 'evt_t2',
      type: 'invoice.payment_failed',
      data: { object: makeStripeInvoice() },
    } as unknown as Stripe.Event;
    await service.handleWebhookEvent(event, {});
    const sub = prisma.subs.get('s_trial')!;
    // Pierde el acceso YA: nada de PAST_DUE ni 3 días de gracia — la gracia es
    // para quien ya pagó alguna vez, no para un trial que nunca pagó.
    expect(sub.status).toBe('UNPAID');
    expect(sub.gracePeriodEndsAt).toBeNull();
    expect(sub.trialEndsAt).toBeNull();
    const unpaid = publisher.events.find((e) => e.name === 'subscriptions.subscription.unpaid');
    expect(unpaid).toBeTruthy();
    expect(unpaid!.payload['planId']).toBe('plan_1');
    expect(unpaid!.payload['trialExpired']).toBe(true);
    // No se emitió past_due (no hay dunning con gracia para el trial).
    expect(publisher.events.some((e) => e.name === 'subscriptions.subscription.past_due')).toBe(
      false,
    );
  });

  it('FIN DE TRIAL PAGADO: invoice.paid con sub TRIALING → ACTIVE y limpia trialEndsAt', async () => {
    const { service, prisma } = buildSystem();
    seedTrialingMembership(prisma);
    const event = {
      id: 'evt_t3',
      type: 'invoice.paid',
      data: { object: makeStripeInvoice({ amount_paid: 3990 }) },
    } as unknown as Stripe.Event;
    await service.handleWebhookEvent(event, {});
    const sub = prisma.subs.get('s_trial')!;
    expect(sub.status).toBe('ACTIVE');
    expect(sub.trialEndsAt).toBeNull();
  });

  it('recovery tras impago del trial: invoice.paid con sub UNPAID → ACTIVE + activated recovery (re-concede acceso)', async () => {
    const { service, prisma, publisher } = buildSystem();
    seedTrialingMembership(prisma, { status: 'UNPAID', trialEndsAt: null });
    const event = {
      id: 'evt_t4',
      type: 'invoice.paid',
      data: { object: makeStripeInvoice({ amount_paid: 3990 }) },
    } as unknown as Stripe.Event;
    await service.handleWebhookEvent(event, {});
    expect(prisma.subs.get('s_trial')!.status).toBe('ACTIVE');
    const ev = publisher.events.find(
      (e) => e.name === 'subscriptions.subscription.activated' && e.payload['recovery'] === true,
    );
    expect(ev).toBeTruthy();
    expect(ev!.payload['planId']).toBe('plan_1');
  });

  it('endurecimiento: updated a unpaid/canceled desde ACTIVE publica los eventos de revocación', async () => {
    const { service, prisma, publisher } = buildSystem();
    seedTrialingMembership(prisma, { status: 'ACTIVE', trialEndsAt: null });
    await service.handleWebhookEvent(
      {
        id: 'evt_t5',
        type: 'customer.subscription.updated',
        data: { object: makeStripeSub({ status: 'unpaid' }) },
      } as unknown as Stripe.Event,
      {},
    );
    const unpaid = publisher.events.find((e) => e.name === 'subscriptions.subscription.unpaid');
    expect(unpaid).toBeTruthy();
    expect(unpaid!.payload['planId']).toBe('plan_1');
    expect(prisma.subs.get('s_trial')!.status).toBe('UNPAID');

    seedTrialingMembership(prisma, {
      id: 's_trial2',
      stripeSubscriptionId: 'sub_stripe_2',
      status: 'ACTIVE',
      trialEndsAt: null,
    });
    await service.handleWebhookEvent(
      {
        id: 'evt_t6',
        type: 'customer.subscription.updated',
        data: { object: makeStripeSub({ id: 'sub_stripe_2', status: 'canceled' }) },
      } as unknown as Stripe.Event,
      {},
    );
    const canceled = publisher.events.find(
      (e) => e.name === 'subscriptions.subscription.canceled' && e.payload['immediate'] === true,
    );
    expect(canceled).toBeTruthy();
    expect(prisma.subs.get('s_trial2')!.status).toBe('CANCELED');
  });

  it('updated a unpaid desde TRIALING sin pago NO transiciona (lo resuelve invoice.payment_failed → UNPAID directo)', async () => {
    const { service, prisma, publisher } = buildSystem();
    seedTrialingMembership(prisma);
    await service.handleWebhookEvent(
      {
        id: 'evt_t7',
        type: 'customer.subscription.updated',
        data: { object: makeStripeSub({ status: 'unpaid' }) },
      } as unknown as Stripe.Event,
      {},
    );
    expect(prisma.subs.get('s_trial')!.status).toBe('TRIALING');
    expect(publisher.events.some((e) => e.name === 'subscriptions.subscription.unpaid')).toBe(
      false,
    );
    // …y cuando llega el invoice.payment_failed, ahí sí: UNPAID sin gracia.
    await service.handleWebhookEvent(
      {
        id: 'evt_t8',
        type: 'invoice.payment_failed',
        data: { object: makeStripeInvoice() },
      } as unknown as Stripe.Event,
      {},
    );
    expect(prisma.subs.get('s_trial')!.status).toBe('UNPAID');
    expect(publisher.events.some((e) => e.name === 'subscriptions.subscription.unpaid')).toBe(true);
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

// ---------- Split F3: lookup sancionado + procesado por tenant ----------

function makeSubRow(overrides: Partial<SubRow> & { id: string; tenantId: string }): SubRow {
  return {
    userId: 'u',
    courseId: 'c1',
    stripeSubscriptionId: null,
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
    ...overrides,
  };
}

describe('SubscriptionsService.resolveWebhookTenantId (mitad lookup del patrón F3)', () => {
  it('customer.subscription.updated → tenant de la sub por stripeSubscriptionId', async () => {
    const { service, prisma } = buildSystem();
    prisma.subs.set(
      's1',
      makeSubRow({ id: 's1', tenantId: 't-sub', stripeSubscriptionId: 'sub_stripe_1' }),
    );
    const tenantId = await service.resolveWebhookTenantId({
      id: 'evt_r1',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_stripe_1' } },
    } as unknown as Stripe.Event);
    expect(tenantId).toBe('t-sub');
  });

  it('customer.subscription.created → tenant por metadata.subscriptionLocalId', async () => {
    const { service, prisma } = buildSystem();
    prisma.subs.set('sub-local-9', makeSubRow({ id: 'sub-local-9', tenantId: 't-created' }));
    const tenantId = await service.resolveWebhookTenantId({
      id: 'evt_r2',
      type: 'customer.subscription.created',
      data: { object: { id: 'sub_stripe_9', metadata: { subscriptionLocalId: 'sub-local-9' } } },
    } as unknown as Stripe.Event);
    expect(tenantId).toBe('t-created');
  });

  it('invoice.paid → tenant de la sub referenciada por el invoice', async () => {
    const { service, prisma } = buildSystem();
    prisma.subs.set(
      's2',
      makeSubRow({ id: 's2', tenantId: 't-inv', stripeSubscriptionId: 'sub_stripe_2' }),
    );
    const tenantId = await service.resolveWebhookTenantId({
      id: 'evt_r3',
      type: 'invoice.paid',
      data: { object: { subscription: 'sub_stripe_2' } },
    } as unknown as Stripe.Event);
    expect(tenantId).toBe('t-inv');
  });

  it('charge.refunded → tenant de la invoice local por stripeInvoiceId', async () => {
    const { service, prisma } = buildSystem();
    prisma.invoices.set('inv-1', {
      id: 'inv-1',
      tenantId: 't-refund',
      subscriptionId: 's3',
      stripeInvoiceId: 'in_ref_1',
      status: 'PAID',
      amount: 1999,
      currency: 'eur',
      hostedInvoiceUrl: null,
      paidAt: new Date(),
      periodStart: new Date(),
      periodEnd: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const tenantId = await service.resolveWebhookTenantId({
      id: 'evt_r4',
      type: 'charge.refunded',
      data: { object: { invoice: 'in_ref_1' } },
    } as unknown as Stripe.Event);
    expect(tenantId).toBe('t-refund');
  });

  it('entidad desconocida o evento sin lógica de dominio → null (procesado sancionado)', async () => {
    const { service } = buildSystem();
    expect(
      await service.resolveWebhookTenantId({
        id: 'evt_r5',
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_stripe_desconocida' } },
      } as unknown as Stripe.Event),
    ).toBeNull();
    expect(
      await service.resolveWebhookTenantId({
        id: 'evt_r6',
        type: 'payment_method.attached',
        data: { object: {} },
      } as unknown as Stripe.Event),
    ).toBeNull();
  });
});

describe('SubscriptionsService — split F3 del barrido de grace periods', () => {
  function installGraceFindMany(prisma: MockPrisma) {
    // El findMany del mock base no implementa status/gracePeriodEndsAt.lte/
    // distinct; este override cubre las dos formas que usa el split.
    prisma.modSubscriptionsSubscription.findMany = (async (args: {
      where: { tenantId?: string; status?: SubStatus; gracePeriodEndsAt?: { lte?: Date } };
      distinct?: string[];
    }) => {
      const lte = args.where.gracePeriodEndsAt?.lte;
      let rows = [...prisma.subs.values()].filter(
        (s) =>
          (!args.where.tenantId || s.tenantId === args.where.tenantId) &&
          (!args.where.status || s.status === args.where.status) &&
          (!lte || (s.gracePeriodEndsAt && s.gracePeriodEndsAt <= lte)),
      );
      if (args.distinct?.includes('tenantId')) {
        const seen = new Set<string>();
        rows = rows.filter((r) => (seen.has(r.tenantId) ? false : (seen.add(r.tenantId), true)));
      }
      return rows.map((r) => ({ ...r }));
    }) as never;
  }

  it('findTenantsWithExpiredGrace devuelve tenants únicos con grace vencido', async () => {
    const { service, prisma } = buildSystem();
    installGraceFindMany(prisma);
    const past = new Date(Date.now() - 1000);
    prisma.subs.set(
      's1',
      makeSubRow({ id: 's1', tenantId: 't1', status: 'PAST_DUE', gracePeriodEndsAt: past }),
    );
    prisma.subs.set(
      's2',
      makeSubRow({ id: 's2', tenantId: 't1', status: 'PAST_DUE', gracePeriodEndsAt: past }),
    );
    prisma.subs.set(
      's3',
      makeSubRow({ id: 's3', tenantId: 't2', status: 'PAST_DUE', gracePeriodEndsAt: past }),
    );
    prisma.subs.set(
      's4',
      makeSubRow({
        id: 's4',
        tenantId: 't3',
        status: 'PAST_DUE',
        gracePeriodEndsAt: new Date(Date.now() + 86400_000),
      }),
    );
    const tenants = await service.findTenantsWithExpiredGrace(new Date());
    expect(tenants.sort()).toEqual(['t1', 't2']);
  });

  it('expireGracePeriodsForTenant solo toca las subs de ESE tenant y emite unpaid', async () => {
    const { service, prisma, publisher } = buildSystem();
    installGraceFindMany(prisma);
    const past = new Date(Date.now() - 1000);
    prisma.subs.set(
      's1',
      makeSubRow({ id: 's1', tenantId: 't1', status: 'PAST_DUE', gracePeriodEndsAt: past }),
    );
    prisma.subs.set(
      's2',
      makeSubRow({ id: 's2', tenantId: 't2', status: 'PAST_DUE', gracePeriodEndsAt: past }),
    );

    const expired = await service.expireGracePeriodsForTenant('t1', new Date());

    expect(expired.map((s) => s.id)).toEqual(['s1']);
    expect(prisma.subs.get('s1')!.status).toBe('UNPAID');
    expect(prisma.subs.get('s2')!.status).toBe('PAST_DUE'); // otro tenant: intacto
    const unpaid = publisher.events.filter((e) => e.name === 'subscriptions.subscription.unpaid');
    expect(unpaid).toHaveLength(1);
    expect(unpaid[0]!.tenantId).toBe('t1');
  });
});

describe('SubscriptionsService — el webhook desordenado no se pierde (H11)', () => {
  it('invoice.paid de una sub que aun no existe en local pide reintento', async () => {
    const { service } = buildSystem();
    const event = {
      id: 'evt_early',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_1',
          subscription: 'sub_stripe_1',
          amount_paid: 1999,
          currency: 'eur',
          created: Math.floor(Date.now() / 1000),
          billing_reason: 'subscription_create',
        },
      },
    } as unknown as Stripe.Event;

    await expect(service.handleWebhookEvent(event, {})).rejects.toBeInstanceOf(
      WebhookOutOfOrderError,
    );
  });

  it('una factura vieja de otro producto de la misma cuenta se deja pasar', async () => {
    const { service, prisma } = buildSystem();
    const haceTresDias = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
    const event = {
      id: 'evt_ajeno',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_2',
          subscription: 'sub_de_otro_producto',
          amount_paid: 500,
          currency: 'eur',
          created: haceTresDias,
          billing_reason: 'subscription_cycle',
        },
      },
    } as unknown as Stripe.Event;

    await expect(service.handleWebhookEvent(event, {})).resolves.toBeUndefined();
    expect(prisma.webhookEvents.get('evt_ajeno')!.processedAt).not.toBeNull();
  });
});

describe('SubscriptionsService — un checkout abandonado no bloquea la compra (H12)', () => {
  const input = {
    tenantId: 't',
    userId: 'u',
    userEmail: 'a@b.c',
    courseId: 'c1',
    stripePriceId: 'price_recurring',
  };

  function pendiente(prisma: MockPrisma, createdAt: Date) {
    prisma.subs.set('vieja', {
      id: 'vieja',
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
      planId: null,
      createdAt,
      updatedAt: createdAt,
    });
  }

  it('una PENDING de hace dos dias se caduca y deja comprar', async () => {
    const { service, prisma } = buildSystem();
    pendiente(prisma, new Date(Date.now() - 48 * 60 * 60 * 1000));

    await expect(service.startSubscription(input)).resolves.toMatchObject({
      url: expect.any(String),
    });
    expect(prisma.subs.get('vieja')!.status).toBe('CANCELED');
    expect(prisma.subs.get('vieja')!.canceledReason).toBe('checkout_abandonado');
  });

  it('una PENDING recien creada SI bloquea (el alumno tiene el checkout abierto)', async () => {
    const { service, prisma } = buildSystem();
    pendiente(prisma, new Date());

    await expect(service.startSubscription(input)).rejects.toBeInstanceOf(
      SubscriptionAlreadyActiveError,
    );
  });

  it('checkout.session.expired caduca la fila PENDING', async () => {
    const { service, prisma } = buildSystem();
    pendiente(prisma, new Date());
    const event = {
      id: 'evt_exp',
      type: 'checkout.session.expired',
      data: { object: { id: 'cs_1', metadata: { subscriptionLocalId: 'vieja' } } },
    } as unknown as Stripe.Event;

    await service.handleWebhookEvent(event, {});

    expect(prisma.subs.get('vieja')!.status).toBe('CANCELED');
    expect(prisma.subs.get('vieja')!.canceledReason).toBe('checkout_caducado');
  });

  it('checkout.session.expired NO degrada una sub que ya se activo', async () => {
    const { service, prisma } = buildSystem();
    pendiente(prisma, new Date());
    prisma.subs.get('vieja')!.status = 'ACTIVE';
    const event = {
      id: 'evt_exp2',
      type: 'checkout.session.expired',
      data: { object: { id: 'cs_2', metadata: { subscriptionLocalId: 'vieja' } } },
    } as unknown as Stripe.Event;

    await service.handleWebhookEvent(event, {});

    expect(prisma.subs.get('vieja')!.status).toBe('ACTIVE');
  });
});

describe('SubscriptionsService — reembolsos y barrido de gracia', () => {
  function subActiva(prisma: MockPrisma) {
    prisma.subs.set('s1', {
      id: 's1',
      tenantId: 't',
      userId: 'u',
      courseId: 'c1',
      stripeSubscriptionId: 'sub_stripe_1',
      stripeCustomerId: 'cus_test',
      stripePriceId: 'price_recurring',
      status: 'PAST_DUE',
      unitAmount: 1999,
      currency: 'eur',
      interval: 'month',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      gracePeriodEndsAt: new Date(Date.now() - 60_000),
      canceledAt: null,
      canceledReason: null,
      planId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  function facturaDe(prisma: MockPrisma) {
    prisma.invoices.set('inv1', {
      id: 'inv1',
      tenantId: 't',
      subscriptionId: 's1',
      stripeInvoiceId: 'in_1',
      amount: 1999,
      currency: 'eur',
      status: 'PAID',
      periodStart: new Date(),
      periodEnd: new Date(),
      hostedInvoiceUrl: null,
      paidAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it('un reembolso PARCIAL no revoca la comision del referidor (L9)', async () => {
    const { service, prisma, publisher } = buildSystem();
    subActiva(prisma);
    facturaDe(prisma);
    const event = {
      id: 'evt_ref_parcial',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_1',
          invoice: 'in_1',
          amount: 1999,
          amount_refunded: 100,
          currency: 'eur',
        },
      },
    } as unknown as Stripe.Event;

    await service.handleWebhookEvent(event, {});

    expect(publisher.events.some((e) => e.name.includes('refunded'))).toBe(false);
  });

  it('un reembolso TOTAL si la revoca', async () => {
    const { service, prisma, publisher } = buildSystem();
    subActiva(prisma);
    facturaDe(prisma);
    const event = {
      id: 'evt_ref_total',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_2',
          invoice: 'in_1',
          amount: 1999,
          amount_refunded: 1999,
          currency: 'eur',
        },
      },
    } as unknown as Stripe.Event;

    await service.handleWebhookEvent(event, {});

    expect(publisher.events.some((e) => e.name.includes('refunded'))).toBe(true);
  });

  it('el barrido no pisa a quien acaba de pagar entre el findMany y el update (M5)', async () => {
    const { service, prisma, publisher } = buildSystem();
    subActiva(prisma);

    // Simula el `invoice.paid` que entra despues del findMany: la sub vuelve a
    // ACTIVE justo antes de que el worker la marque UNPAID.
    const findManyOriginal = prisma.modSubscriptionsSubscription.findMany;
    prisma.modSubscriptionsSubscription.findMany = (async (args: never) => {
      const res = await findManyOriginal.call(prisma.modSubscriptionsSubscription, args);
      const s1 = prisma.subs.get('s1');
      if (s1 && s1.status === 'PAST_DUE') {
        s1.status = 'ACTIVE';
        s1.gracePeriodEndsAt = null;
      }
      return res;
    }) as typeof findManyOriginal;

    const procesadas = await service.expireGracePeriodsForTenant('t');

    expect(prisma.subs.get('s1')!.status).toBe('ACTIVE'); // no lo machaca
    expect(procesadas).toHaveLength(0);
    expect(publisher.events.some((e) => e.name.includes('unpaid'))).toBe(false);
  });
});
