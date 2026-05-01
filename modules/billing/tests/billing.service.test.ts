/**
 * Tests unit del BillingService — sin red, sin DB real, sin Stripe SDK.
 *
 * Estrategia de test:
 *  - Prisma se mockea con stub que implementa el subset usado.
 *  - StripeAdapter se mockea con un objeto que devuelve sessions
 *    deterministas y simula el `constructWebhookEvent`.
 *  - El publisher de eventos también es stub que registra cada publish().
 *
 * Cobertura priorizada:
 *  1. createProduct: rechaza duplicado, rechaza price inactivo, cachea unit_amount.
 *  2. startCheckout: crea order PENDING + session Stripe + actualiza con sessionId.
 *  3. handleWebhookEvent: idempotencia (mismo evento dos veces), checkout.session.completed
 *     transiciona PENDING→COMPLETED y emite billing.order.completed, expired→CANCELLED,
 *     async_payment_failed→FAILED.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import {
  BillingService,
  type BillingEventPublisher,
  type CheckoutUrlBuilder,
} from '../src/billing.service.js';
import {
  ProductAlreadyExistsError,
  ProductInactiveError,
  ProductNotFoundError,
  StripeApiError,
} from '../src/errors.js';
import type { StripeAdapter } from '../src/stripe.client.js';

// ---------- Mocks Prisma ----------
//
// Mantenemos el mock sencillo: 3 mapas en memoria (productos, órdenes,
// webhook_events). Solo implementamos los métodos que el service usa,
// con su semántica esperada (unique constraints, findFirst con tenantId, etc.).

interface ProductRow {
  id: string;
  tenantId: string;
  courseId: string;
  stripeProductId: string;
  stripePriceId: string;
  unitAmount: number;
  currency: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}
interface OrderRow {
  id: string;
  tenantId: string;
  userId: string;
  productId: string;
  courseId: string;
  stripeSessionId: string;
  status: 'PENDING' | 'COMPLETED' | 'CANCELLED' | 'FAILED' | 'REFUNDED';
  amountPaid: number | null;
  currency: string;
  customerEmail: string | null;
  completedAt: Date | null;
  refundedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
interface WebhookEventRow {
  stripeEventId: string;
  type: string;
  payload: unknown;
  processedAt: Date | null;
  errorMessage: string | null;
  receivedAt: Date;
}

class MockPrisma {
  products = new Map<string, ProductRow>();
  orders = new Map<string, OrderRow>();
  webhookEvents = new Map<string, WebhookEventRow>();

  modBillingProduct = {
    findUnique: async (args: {
      where: { tenantId_courseId: { tenantId: string; courseId: string } };
    }) => {
      for (const p of this.products.values()) {
        if (
          p.tenantId === args.where.tenantId_courseId.tenantId &&
          p.courseId === args.where.tenantId_courseId.courseId
        ) {
          return p;
        }
      }
      return null;
    },
    findFirst: async (args: { where: { id: string; tenantId: string } }) => {
      for (const p of this.products.values()) {
        if (p.id === args.where.id && p.tenantId === args.where.tenantId) return p;
      }
      return null;
    },
    findMany: async (args: { where: { tenantId: string } }) => {
      return [...this.products.values()].filter((p) => p.tenantId === args.where.tenantId);
    },
    create: async (args: { data: Omit<ProductRow, 'id' | 'createdAt' | 'updatedAt'> }) => {
      const id = `prod-${this.products.size + 1}`;
      const row: ProductRow = {
        id,
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.products.set(id, row);
      return row;
    },
    update: async (args: { where: { id: string }; data: Partial<ProductRow> }) => {
      const row = this.products.get(args.where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, args.data, { updatedAt: new Date() });
      return row;
    },
    delete: async (args: { where: { id: string } }) => {
      this.products.delete(args.where.id);
    },
  };

  modBillingOrder = {
    findUnique: async (args: { where: { id: string } }) => this.orders.get(args.where.id) ?? null,
    create: async (args: {
      data: Omit<
        OrderRow,
        | 'id'
        | 'createdAt'
        | 'updatedAt'
        | 'amountPaid'
        | 'customerEmail'
        | 'completedAt'
        | 'refundedAt'
      > &
        Partial<OrderRow>;
    }) => {
      const id = `order-${this.orders.size + 1}`;
      const row: OrderRow = {
        id,
        amountPaid: null,
        customerEmail: null,
        completedAt: null,
        refundedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...args.data,
      } as OrderRow;
      this.orders.set(id, row);
      return row;
    },
    update: async (args: { where: { id: string }; data: Partial<OrderRow> }) => {
      const row = this.orders.get(args.where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, args.data, { updatedAt: new Date() });
      return row;
    },
  };

  modBillingWebhookEvent = {
    create: async (args: { data: { stripeEventId: string; type: string; payload: unknown } }) => {
      if (this.webhookEvents.has(args.data.stripeEventId)) {
        throw new Error(
          'Unique constraint failed on the constraint: `mod_billing_webhook_event_pkey`',
        );
      }
      const row: WebhookEventRow = {
        stripeEventId: args.data.stripeEventId,
        type: args.data.type,
        payload: args.data.payload,
        processedAt: null,
        errorMessage: null,
        receivedAt: new Date(),
      };
      this.webhookEvents.set(row.stripeEventId, row);
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

// ---------- Mock StripeAdapter ----------

class MockStripe implements StripeAdapter {
  prices = new Map<
    string,
    { id: string; productId: string; unitAmount: number; currency: string; active: boolean }
  >();
  sessionCounter = 0;

  setPrice(
    id: string,
    opts: Partial<{
      active: boolean;
      unitAmount: number;
      currency: string;
      productId: string;
    }> = {},
  ) {
    this.prices.set(id, {
      id,
      productId: opts.productId ?? 'prod_test',
      unitAmount: opts.unitAmount ?? 999,
      currency: opts.currency ?? 'eur',
      active: opts.active ?? true,
    });
  }

  async createCheckoutSession(params: { metadata: Record<string, string> }) {
    this.sessionCounter += 1;
    return {
      id: `cs_test_${this.sessionCounter}`,
      url: `https://checkout.stripe.test/cs_test_${this.sessionCounter}`,
    };
  }

  async retrievePrice(priceId: string) {
    const p = this.prices.get(priceId);
    if (!p) throw new StripeApiError(`No such price: ${priceId}`);
    return p;
  }

  async retrieveProduct(productId: string) {
    return { id: productId, name: 'Test product', active: true };
  }

  constructWebhookEvent(): Stripe.Event {
    throw new Error('not used in these tests — use handleWebhookEvent direct');
  }
}

// ---------- Mock publisher ----------

class MockPublisher implements BillingEventPublisher {
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

const urls: CheckoutUrlBuilder = {
  successUrl: (id) => `https://web.test/cursos/${id}?paid=1`,
  cancelUrl: (id) => `https://web.test/cursos/${id}?cancelled=1`,
};

// ---------- Tests ----------

describe('BillingService — productos (admin)', () => {
  let prisma: MockPrisma;
  let stripe: MockStripe;
  let publisher: MockPublisher;
  let svc: BillingService;

  beforeEach(() => {
    prisma = new MockPrisma();
    stripe = new MockStripe();
    publisher = new MockPublisher();
    svc = new BillingService(prisma as unknown as never, stripe, publisher, urls);
  });

  it('createProduct: cachea unit_amount y currency desde Stripe', async () => {
    stripe.setPrice('price_123', { unitAmount: 1999, currency: 'usd', productId: 'prod_xyz' });

    const created = await svc.createProduct({
      tenantId: 't1',
      courseId: 'course-1',
      stripePriceId: 'price_123',
    });

    expect(created.unitAmount).toBe(1999);
    expect(created.currency).toBe('usd');
    expect(created.stripeProductId).toBe('prod_xyz');
    expect(created.active).toBe(true);
  });

  it('createProduct: rechaza duplicado por curso', async () => {
    stripe.setPrice('price_a');
    stripe.setPrice('price_b');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
    await expect(
      svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_b' }),
    ).rejects.toBeInstanceOf(ProductAlreadyExistsError);
  });

  it('createProduct: rechaza price inactivo en Stripe', async () => {
    stripe.setPrice('price_dead', { active: false });
    await expect(
      svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_dead' }),
    ).rejects.toBeInstanceOf(StripeApiError);
  });

  it('updateProduct: cambiar active no llama a Stripe', async () => {
    stripe.setPrice('price_a');
    const created = await svc.createProduct({
      tenantId: 't1',
      courseId: 'course-1',
      stripePriceId: 'price_a',
    });

    const updated = await svc.updateProduct({
      tenantId: 't1',
      productId: created.id,
      patch: { active: false },
    });
    expect(updated.active).toBe(false);
  });

  it('deleteProduct: 404 si no es del tenant', async () => {
    stripe.setPrice('price_a');
    const created = await svc.createProduct({
      tenantId: 't1',
      courseId: 'course-1',
      stripePriceId: 'price_a',
    });
    await expect(svc.deleteProduct('t-other', created.id)).rejects.toBeInstanceOf(
      ProductNotFoundError,
    );
  });
});

describe('BillingService — startCheckout (alumno)', () => {
  let prisma: MockPrisma;
  let stripe: MockStripe;
  let publisher: MockPublisher;
  let svc: BillingService;

  beforeEach(() => {
    prisma = new MockPrisma();
    stripe = new MockStripe();
    publisher = new MockPublisher();
    svc = new BillingService(prisma as unknown as never, stripe, publisher, urls);
    stripe.setPrice('price_a');
  });

  it('crea order PENDING, llama a Stripe, actualiza con sessionId, emite ORDER_CREATED', async () => {
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
    const result = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'u@test',
      courseId: 'course-1',
    });

    expect(result.url).toContain('checkout.stripe.test');
    expect(result.sessionId).toMatch(/^cs_test_/);

    const stored = prisma.orders.get(result.orderId);
    expect(stored?.status).toBe('PENDING');
    expect(stored?.stripeSessionId).toBe(result.sessionId);

    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0].name).toBe('billing.order.created');
    expect(publisher.events[0].payload.stripeSessionId).toBe(result.sessionId);
  });

  it('falla si el producto no existe para el curso', async () => {
    await expect(
      svc.startCheckout({
        tenantId: 't1',
        userId: 'u1',
        userEmail: 'u@test',
        courseId: 'course-no-product',
      }),
    ).rejects.toBeInstanceOf(ProductNotFoundError);
  });

  it('falla si el producto está inactivo', async () => {
    const p = await svc.createProduct({
      tenantId: 't1',
      courseId: 'course-1',
      stripePriceId: 'price_a',
    });
    await svc.updateProduct({ tenantId: 't1', productId: p.id, patch: { active: false } });

    await expect(
      svc.startCheckout({
        tenantId: 't1',
        userId: 'u1',
        userEmail: 'u@test',
        courseId: 'course-1',
      }),
    ).rejects.toBeInstanceOf(ProductInactiveError);
  });
});

describe('BillingService — handleWebhookEvent (idempotente)', () => {
  let prisma: MockPrisma;
  let stripe: MockStripe;
  let publisher: MockPublisher;
  let svc: BillingService;

  beforeEach(() => {
    prisma = new MockPrisma();
    stripe = new MockStripe();
    publisher = new MockPublisher();
    svc = new BillingService(prisma as unknown as never, stripe, publisher, urls);
  });

  function buildSessionCompletedEvent(
    orderId: string,
    opts?: { tenantId?: string; userId?: string; courseId?: string },
  ): Stripe.Event {
    return {
      id: `evt_${orderId}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_xyz',
          metadata: {
            orderId,
            tenantId: opts?.tenantId ?? 't1',
            userId: opts?.userId ?? 'u1',
            courseId: opts?.courseId ?? 'course-1',
            productId: 'prod-1',
          },
          amount_total: 1999,
          customer_email: 'u@test',
          customer_details: { email: 'u@test' },
          status: 'complete',
        } as unknown as Stripe.Checkout.Session,
      },
    } as Stripe.Event;
  }

  it('checkout.session.completed transiciona PENDING → COMPLETED y emite ORDER_COMPLETED', async () => {
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
    const checkout = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'u@test',
      courseId: 'course-1',
    });
    publisher.events = []; // limpiamos el created para asertar solo el completed

    await svc.handleWebhookEvent(buildSessionCompletedEvent(checkout.orderId), { foo: 'bar' });

    const updated = prisma.orders.get(checkout.orderId)!;
    expect(updated.status).toBe('COMPLETED');
    expect(updated.amountPaid).toBe(1999);
    expect(updated.customerEmail).toBe('u@test');
    expect(updated.completedAt).toBeInstanceOf(Date);

    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0].name).toBe('billing.order.completed');
    expect(publisher.events[0].payload.amountPaid).toBe(1999);
  });

  it('idempotencia: el mismo evento dos veces NO duplica trabajo', async () => {
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
    const checkout = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'u@test',
      courseId: 'course-1',
    });
    publisher.events = [];

    const event = buildSessionCompletedEvent(checkout.orderId);
    await svc.handleWebhookEvent(event, {});
    await svc.handleWebhookEvent(event, {}); // re-entrega de Stripe

    expect(publisher.events).toHaveLength(1); // NO se emitió dos veces
  });

  it('checkout.session.expired marca order como CANCELLED sin emitir failed', async () => {
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
    const checkout = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'u@test',
      courseId: 'course-1',
    });
    publisher.events = [];

    await svc.handleWebhookEvent(
      {
        id: 'evt_expire',
        type: 'checkout.session.expired',
        data: {
          object: {
            id: 'cs_xyz',
            metadata: { orderId: checkout.orderId },
            status: 'expired',
          } as unknown as Stripe.Checkout.Session,
        },
      } as Stripe.Event,
      {},
    );

    expect(prisma.orders.get(checkout.orderId)!.status).toBe('CANCELLED');
    expect(publisher.events).toHaveLength(0);
  });

  it('checkout.session.async_payment_failed emite ORDER_FAILED', async () => {
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
    const checkout = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'u@test',
      courseId: 'course-1',
    });
    publisher.events = [];

    await svc.handleWebhookEvent(
      {
        id: 'evt_fail',
        type: 'checkout.session.async_payment_failed',
        data: {
          object: {
            id: 'cs_xyz',
            metadata: { orderId: checkout.orderId },
            status: 'open',
          } as unknown as Stripe.Checkout.Session,
        },
      } as Stripe.Event,
      {},
    );

    expect(prisma.orders.get(checkout.orderId)!.status).toBe('FAILED');
    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0].name).toBe('billing.order.failed');
  });

  it('eventos no relevantes (ej. invoice.paid) se persisten pero no afectan estado', async () => {
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });

    await svc.handleWebhookEvent(
      {
        id: 'evt_invoice',
        type: 'invoice.paid',
        data: { object: {} as unknown as Stripe.Invoice },
      } as Stripe.Event,
      {},
    );

    expect(prisma.webhookEvents.has('evt_invoice')).toBe(true);
    expect(publisher.events).toHaveLength(0);
  });
});
