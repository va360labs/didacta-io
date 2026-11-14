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

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  BillingService,
  type BillingEventPublisher,
  type CheckoutUrlBuilder,
} from '../src/billing.service.js';
import {
  OrderNotFoundError,
  PriceChangedError,
  ProductAlreadyExistsError,
  ProductInactiveError,
  ProductNotFoundError,
  StripeApiError,
  WebhookTenantMismatchError,
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
  compareAtAmount: number | null;
  name: string;
  perks: string[];
  sortOrder: number;
  isFeatured: boolean;
  externalRef: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}
interface OrderRow {
  id: string;
  tenantId: string;
  userId: string | null;
  productId: string;
  courseId: string;
  stripeSessionId: string;
  stripePaymentIntentId: string | null;
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
    findFirst: async (args: {
      where: {
        id?: string;
        tenantId?: string;
        courseId?: string;
        name?: string;
        externalRef?: string;
      };
    }) => {
      const w = args.where;
      for (const p of this.products.values()) {
        if (w.id !== undefined && p.id !== w.id) continue;
        if (w.tenantId !== undefined && p.tenantId !== w.tenantId) continue;
        if (w.courseId !== undefined && p.courseId !== w.courseId) continue;
        if (w.name !== undefined && p.name !== w.name) continue;
        if (w.externalRef !== undefined && p.externalRef !== w.externalRef) continue;
        return p;
      }
      return null;
    },
    findMany: async (args: {
      where: { tenantId: string; courseId?: string; active?: boolean };
    }) => {
      return [...this.products.values()].filter(
        (p) =>
          p.tenantId === args.where.tenantId &&
          (args.where.courseId === undefined || p.courseId === args.where.courseId) &&
          (args.where.active === undefined || p.active === args.where.active),
      );
    },
    create: async (args: { data: Omit<ProductRow, 'id' | 'createdAt' | 'updatedAt'> }) => {
      const id = `prod-${this.products.size + 1}`;
      // Sin defaults muertos: `args.data` declara estos campos obligatorios
      // y el spread los pisaba siempre.
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
    findFirst: async (args: {
      where: { stripePaymentIntentId?: string; tenantId?: string; stripeSessionId?: string };
    }) => {
      for (const o of this.orders.values()) {
        if (
          args.where.stripePaymentIntentId &&
          o.stripePaymentIntentId === args.where.stripePaymentIntentId
        ) {
          return o;
        }
        if (
          args.where.stripeSessionId &&
          o.stripeSessionId === args.where.stripeSessionId &&
          (args.where.tenantId === undefined || o.tenantId === args.where.tenantId)
        ) {
          return o;
        }
      }
      return null;
    },
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
    // Lo justo para `expireOpenCheckouts`: tenant, estado, desde cuándo y por
    // opción de compra o curso.
    findMany: async (args: {
      where: {
        tenantId: string;
        status?: OrderRow['status'];
        createdAt?: { gte: Date };
        productId?: { in: string[] };
        courseId?: string;
      };
    }) => {
      const w = args.where;
      return [...this.orders.values()].filter(
        (o) =>
          o.tenantId === w.tenantId &&
          (w.status === undefined || o.status === w.status) &&
          (w.createdAt === undefined || o.createdAt >= w.createdAt.gte) &&
          (w.productId === undefined || w.productId.in.includes(o.productId)) &&
          (w.courseId === undefined || o.courseId === w.courseId),
      );
    },
    updateMany: async (args: {
      where: { id: string; tenantId: string; status: OrderRow['status'] };
      data: Partial<OrderRow>;
    }) => {
      const row = this.orders.get(args.where.id);
      if (!row || row.tenantId !== args.where.tenantId || row.status !== args.where.status) {
        return { count: 0 };
      }
      Object.assign(row, args.data, { updatedAt: new Date() });
      return { count: 1 };
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
    findUnique: async (args: { where: { stripeEventId: string } }) => {
      return this.webhookEvents.get(args.where.stripeEventId) ?? null;
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

  lastCheckout: {
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
    customerEmail?: string;
    uiMode?: string;
    returnUrl?: string;
    locale?: string;
  } | null = null;
  /** Estado que devuelve `retrieveCheckoutSession`, por id de sesión. */
  sessionStates = new Map<
    string,
    {
      status: 'open' | 'complete' | 'expired';
      paymentStatus: string;
      metadata: Record<string, string>;
    }
  >();
  retrieveCalls: string[] = [];
  lastOneOffPrice: {
    name: string;
    unitAmount: number;
    currency: string;
    currencyOptions?: Readonly<Record<string, number>> | null;
  } | null = null;

  async createCheckoutSession(params: {
    metadata: Record<string, string>;
    successUrl: string;
    cancelUrl: string;
    customerEmail?: string;
    uiMode?: string;
    returnUrl?: string;
    locale?: string;
  }) {
    this.sessionCounter += 1;
    this.lastCheckout = {
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      metadata: params.metadata,
      customerEmail: params.customerEmail,
      uiMode: params.uiMode,
      returnUrl: params.returnUrl,
      locale: params.locale,
    };
    if (params.uiMode === 'embedded') {
      return {
        id: `cs_test_${this.sessionCounter}`,
        url: null,
        clientSecret: `cs_test_${this.sessionCounter}_secret`,
        // Lo que cobra la sesión AHORA (no el precio que se pintó en la ficha).
        amountTotal: 100,
        currency: 'eur',
      };
    }
    return {
      id: `cs_test_${this.sessionCounter}`,
      url: `https://checkout.stripe.test/cs_test_${this.sessionCounter}`,
    };
  }

  async retrieveCheckoutSession(sessionId: string) {
    this.retrieveCalls.push(sessionId);
    const state = this.sessionStates.get(sessionId);
    if (!state) throw new StripeApiError(`No such checkout.session: ${sessionId}`);
    return { id: sessionId, amountTotal: 100, currency: 'eur', created: 1_794_000_000, ...state };
  }

  async createOneOffPrice(params: {
    name: string;
    productId?: string;
    unitAmount: number;
    currency: string;
    currencyOptions?: Readonly<Record<string, number>> | null;
    metadata: Record<string, string>;
  }) {
    this.lastOneOffPrice = {
      name: params.name,
      unitAmount: params.unitAmount,
      currency: params.currency,
      currencyOptions: params.currencyOptions ?? null,
    };
    this.sessionCounter += 1;
    const created = {
      id: `price_auto_${this.sessionCounter}`,
      productId: params.productId ?? `prod_auto_${this.sessionCounter}`,
      unitAmount: params.unitAmount,
      currency: params.currency,
      active: true,
    };
    this.prices.set(created.id, created);
    return created;
  }

  async retrievePrice(priceId: string) {
    const p = this.prices.get(priceId);
    if (!p) throw new StripeApiError(`No such price: ${priceId}`);
    return p;
  }

  async retrieveProduct(productId: string) {
    return { id: productId, name: 'Test product', active: true };
  }

  /** Estado de cada sesión en «Stripe»: `open` por defecto. */
  sessionStatus = new Map<string, string>();
  expired: string[] = [];
  failExpire = false;

  async expireCheckoutSession(sessionId: string) {
    if (this.failExpire) throw new StripeApiError('Stripe no responde');
    const status = this.sessionStatus.get(sessionId) ?? 'open';
    if (status !== 'open') return { status };
    this.sessionStatus.set(sessionId, 'expired');
    this.expired.push(sessionId);
    return { status: 'expired' };
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
  successUrl: (id) => `https://web.test/courses/${id}?paid=1`,
  cancelUrl: (id) => `https://web.test/courses/${id}?cancelled=1`,
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
    svc = new BillingService(prisma as unknown as never, async () => stripe, publisher, urls);
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
    svc = new BillingService(prisma as unknown as never, async () => stripe, publisher, urls);
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
    expect(publisher.events[0]!.name).toBe('billing.order.created');
    expect(publisher.events[0]!.payload.stripeSessionId).toBe(result.sessionId);
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

describe('BillingService — pago embebido en la ficha del aula', () => {
  let prisma: MockPrisma;
  let stripe: MockStripe;
  let svc: BillingService;

  beforeEach(async () => {
    prisma = new MockPrisma();
    stripe = new MockStripe();
    svc = new BillingService(
      prisma as unknown as never,
      async () => stripe,
      new MockPublisher(),
      urls,
    );
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
  });

  const RETURN =
    'https://aula.test/catalog/checkout/success?session_id={CHECKOUT_SESSION_ID}&checkout=embedded';

  it('pide la sesión embebida con su vuelta e idioma y devuelve el secreto, no una URL', async () => {
    const result = await svc.startCheckout({
      tenantId: 't1',
      userId: null,
      courseId: 'course-1',
      uiMode: 'embedded',
      returnUrl: RETURN,
      checkoutLocale: 'en',
      referralCode: 'ana123',
    });
    expect(result.url).toBeNull();
    expect(result.clientSecret).toBe(`${result.sessionId}_secret`);
    // El importe que enseña el pago es el de la sesión, no el del producto (999).
    expect(result.amountTotal).toBe(100);
    expect(result.currency).toBe('eur');
    expect(stripe.lastCheckout).toMatchObject({
      uiMode: 'embedded',
      returnUrl: RETURN,
      locale: 'en',
    });
    // La entrega es la misma: orden PENDING con la sesión y la metadata de siempre.
    expect(prisma.orders.get(result.orderId)?.stripeSessionId).toBe(result.sessionId);
    expect(stripe.lastCheckout?.metadata).toMatchObject({
      orderId: result.orderId,
      referralCode: 'ana123',
    });
  });

  it('sin uiMode: el alojado de siempre (ni vuelta ni idioma)', async () => {
    const result = await svc.startCheckout({ tenantId: 't1', userId: 'u1', courseId: 'course-1' });
    expect(result.url).toContain('checkout.stripe.test');
    expect(result.clientSecret).toBeNull();
    expect(stripe.lastCheckout?.uiMode).toBeUndefined();
    expect(stripe.lastCheckout?.returnUrl).toBeUndefined();
    expect(stripe.lastCheckout?.locale).toBeUndefined();
  });

  it('estado de la vuelta: pagada, abierta o de otra academia', async () => {
    const result = await svc.startCheckout({
      tenantId: 't1',
      userId: null,
      courseId: 'course-1',
      uiMode: 'embedded',
      returnUrl: RETURN,
    });
    stripe.sessionStates.set(result.sessionId, {
      status: 'open',
      paymentStatus: 'unpaid',
      metadata: { tenantId: 't1' },
    });
    await expect(svc.getCheckoutSessionState('t1', result.sessionId)).resolves.toMatchObject({
      status: 'open',
      paid: false,
    });

    stripe.sessionStates.set(result.sessionId, {
      status: 'complete',
      paymentStatus: 'paid',
      metadata: { tenantId: 't1' },
    });
    await expect(svc.getCheckoutSessionState('t1', result.sessionId)).resolves.toEqual({
      status: 'complete',
      paid: true,
      courseId: 'course-1',
      amount: 100,
      currency: 'eur',
      at: new Date(1_794_000_000_000).toISOString(),
    });

    // La sesión es de una orden de t1: para t2 no existe (ni se pregunta a Stripe).
    const calls = stripe.retrieveCalls.length;
    await expect(svc.getCheckoutSessionState('t2', result.sessionId)).resolves.toBeNull();
    expect(stripe.retrieveCalls).toHaveLength(calls);
  });

  it('una orden ya entregada por el webhook es «pagada» sin preguntar a Stripe', async () => {
    const result = await svc.startCheckout({ tenantId: 't1', userId: 'u1', courseId: 'course-1' });
    const row = prisma.orders.get(result.orderId)!;
    row.status = 'COMPLETED';
    row.amountPaid = 2_900;
    row.completedAt = new Date('2026-11-14T10:00:00.000Z');
    await expect(svc.getCheckoutSessionState('t1', result.sessionId)).resolves.toEqual({
      status: 'complete',
      paid: true,
      courseId: 'course-1',
      amount: 2_900,
      currency: 'eur',
      at: '2026-11-14T10:00:00.000Z',
    });
    expect(stripe.retrieveCalls).toHaveLength(0);
  });

  it('completa pero sin cobrar (p. ej. medio diferido) no es «pagada»', async () => {
    const result = await svc.startCheckout({ tenantId: 't1', userId: 'u1', courseId: 'course-1' });
    stripe.sessionStates.set(result.sessionId, {
      status: 'complete',
      paymentStatus: 'unpaid',
      metadata: { tenantId: 't1' },
    });
    await expect(svc.getCheckoutSessionState('t1', result.sessionId)).resolves.toMatchObject({
      status: 'complete',
      paid: false,
    });
  });
});

describe('BillingService — alta de producto por importe y URLs por petición', () => {
  let prisma: MockPrisma;
  let stripe: MockStripe;
  let publisher: MockPublisher;
  let svc: BillingService;

  beforeEach(() => {
    prisma = new MockPrisma();
    stripe = new MockStripe();
    publisher = new MockPublisher();
    svc = new BillingService(prisma as unknown as never, async () => stripe, publisher, urls);
  });

  it('crea Product+Price en Stripe cuando se da un importe en vez de un price_', async () => {
    const product = await svc.createProduct({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 11900,
      currency: 'eur',
      name: 'Curso de Claude Code',
    });

    expect(product.unitAmount).toBe(11900);
    expect(product.currency).toBe('eur');
    expect(product.stripePriceId).toMatch(/^price_/);
    expect(product.stripeProductId).toMatch(/^prod_/);
    // El nombre que verá el comprador en Stripe es el título del curso.
    expect(stripe.lastOneOffPrice?.name).toBe('Curso de Claude Code');
  });

  it('upsertCoursePrice es repetible: crea, luego no toca nada, y actualiza si cambia el importe', async () => {
    const primera = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 6700,
      name: 'Ecosistema Claude',
    });
    expect(primera.accion).toBe('creado');
    expect(primera.product.unitAmount).toBe(6700);
    // Copiamos los valores: el mock devuelve la fila por REFERENCIA y un update
    // posterior la mutaría, invalidando la comparación de después.
    const priceInicial = String(primera.product.stripePriceId);
    const productStripe = String(primera.product.stripeProductId);

    const segunda = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 6700,
      name: 'Ecosistema Claude',
    });
    expect(segunda.accion).toBe('sin-cambios');
    expect(segunda.product.stripePriceId).toBe(priceInicial);

    const tercera = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 4700,
      compareAtAmount: 6700,
      name: 'Ecosistema Claude',
    });
    expect(tercera.accion).toBe('actualizado');
    expect(tercera.product.unitAmount).toBe(4700);
    expect(tercera.product.compareAtAmount).toBe(6700);
    // Price nuevo, pero MISMO Product de Stripe: no se duplican productos.
    expect(tercera.product.stripePriceId).not.toBe(priceInicial);
    expect(tercera.product.stripeProductId).toBe(productStripe);
  });

  it('precios por mercado: se guardan, viajan a Stripe y cambiarlos crea un Price nuevo en el MISMO Product', async () => {
    const primera = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 4900,
      currency: 'eur',
      currencyOptions: { MXN: 99_900 },
      name: 'Curso multidivisa',
    });
    expect(primera.accion).toBe('creado');
    expect(primera.product.currencyOptions).toEqual({ mxn: 99_900 });
    expect(stripe.lastOneOffPrice?.currencyOptions).toEqual({ mxn: 99_900 });
    const price1 = String(primera.product.stripePriceId);
    const product1 = String(primera.product.stripeProductId);

    // Mismo mapa con otro orden y mayúsculas: no se toca Stripe.
    const igual = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 4900,
      currency: 'eur',
      currencyOptions: { mxn: 99_900 },
      name: 'Curso multidivisa',
    });
    expect(igual.accion).toBe('sin-cambios');

    // Sin decir nada de los precios por mercado: se quedan.
    const sinTocar = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 4900,
      currency: 'eur',
      name: 'Curso multidivisa',
    });
    expect(sinTocar.accion).toBe('sin-cambios');

    // Mismo importe, otro precio en MXN: Stripe no deja editarlo → Price nuevo.
    const cambio = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 4900,
      currency: 'eur',
      currencyOptions: { mxn: 89_900, cop: 22_900_000 },
      name: 'Curso multidivisa',
    });
    expect(cambio.accion).toBe('actualizado');
    expect(cambio.product.stripePriceId).not.toBe(price1);
    expect(cambio.product.stripeProductId).toBe(product1);
    expect(cambio.product.currencyOptions).toEqual({ cop: 22_900_000, mxn: 89_900 });

    // Quitarlos todos también es un Price nuevo, sin currency_options.
    const quitar = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 4900,
      currency: 'eur',
      currencyOptions: null,
      name: 'Curso multidivisa',
    });
    expect(quitar.accion).toBe('actualizado');
    expect(stripe.lastOneOffPrice?.currencyOptions).toBeNull();
  });

  it('cambiar de moneda (EUR → CHF) rota el Price y mantiene el Product', async () => {
    const eur = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 4900,
      currency: 'eur',
      name: 'Curso',
    });
    const product = String(eur.product.stripeProductId);
    const price = String(eur.product.stripePriceId);
    const chf = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 10_000,
      currency: 'CHF',
      name: 'Curso',
    });
    expect(chf.accion).toBe('actualizado');
    expect([chf.product.unitAmount, chf.product.currency]).toEqual([10_000, 'chf']);
    expect(chf.product.stripeProductId).toBe(product);
    expect(chf.product.stripePriceId).not.toBe(price);
  });

  it('un curso puede tener VARIAS opciones de compra y el checkout cobra la elegida', async () => {
    const basico = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 11997,
      optionName: 'Curso',
      sortOrder: 0,
      name: 'Agentes IA',
    });
    const medio = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 18997,
      optionName: 'Curso Intermedio',
      sortOrder: 1,
      isFeatured: true,
      name: 'Agentes IA',
    });
    const alto = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 49797,
      optionName: 'Curso Avanzado',
      sortOrder: 2,
      name: 'Agentes IA',
    });
    expect([basico.accion, medio.accion, alto.accion]).toEqual(['creado', 'creado', 'creado']);

    const oferta = await svc.getCourseOffer('t1', 'course-1');
    expect(oferta.forSale).toBe(true);
    expect(oferta.options.map((o) => o.name)).toEqual([
      'Curso',
      'Curso Intermedio',
      'Curso Avanzado',
    ]);
    expect(oferta.options.find((o) => o.isFeatured)?.unitAmount).toBe(18997);

    // Comprar la opción avanzada cobra SU importe, no el de la destacada.
    const checkout = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'u@test',
      courseId: 'course-1',
      optionId: alto.product.id,
    });
    expect(prisma.orders.get(checkout.orderId)!.productId).toBe(alto.product.id);

    // Sin elegir opción se usa la destacada.
    const porDefecto = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u2',
      userEmail: 'u2@test',
      courseId: 'course-1',
    });
    expect(prisma.orders.get(porDefecto.orderId)!.productId).toBe(medio.product.id);
  });

  it('no deja pagar con una opción de OTRO curso', async () => {
    const delUno = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 5000,
      optionName: 'Curso',
    });
    await svc.upsertCoursePrice({ tenantId: 't1', courseId: 'course-2', unitAmount: 9900 });

    await expect(
      svc.startCheckout({
        tenantId: 't1',
        userId: 'u1',
        userEmail: 'u@test',
        courseId: 'course-2',
        optionId: delUno.product.id,
      }),
    ).rejects.toThrow();
  });

  it('ignora un precio tachado que no sea mayor que el precio real', async () => {
    const r = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-2',
      unitAmount: 9700,
      compareAtAmount: 5000,
    });
    expect(r.product.compareAtAmount).toBeNull();
  });

  it('rechaza un importe cero o negativo en lugar de crear un precio inválido', async () => {
    await expect(
      svc.createProduct({ tenantId: 't1', courseId: 'course-1', unitAmount: 0 }),
    ).rejects.toThrow(/importe mayor que cero/i);
  });

  it('startCheckout usa las URLs de la petición y no las del arranque', async () => {
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });

    await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'u@test',
      courseId: 'course-1',
      successUrl:
        'https://aula.example.com/courses/checkout/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://aula.example.com/courses/checkout/cancel',
    });

    expect(stripe.lastCheckout?.successUrl).toBe(
      'https://aula.example.com/courses/checkout/success?session_id={CHECKOUT_SESSION_ID}',
    );
    expect(stripe.lastCheckout?.cancelUrl).toBe('https://aula.example.com/courses/checkout/cancel');
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
    svc = new BillingService(prisma as unknown as never, async () => stripe, publisher, urls);
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
          // Stripe SIEMPRE lo manda en una Checkout Session. Va explícito
          // porque el fulfillment falla cerrado: sin este campo no matricula.
          payment_status: 'paid',
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

    await svc.handleWebhookEvent(
      buildSessionCompletedEvent(checkout.orderId),
      { foo: 'bar' },
      { tenantId: 't1' },
    );

    const updated = prisma.orders.get(checkout.orderId)!;
    expect(updated.status).toBe('COMPLETED');
    expect(updated.amountPaid).toBe(1999);
    expect(updated.customerEmail).toBe('u@test');
    expect(updated.completedAt).toBeInstanceOf(Date);

    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0]!.name).toBe('billing.order.completed');
    expect(publisher.events[0]!.payload.amountPaid).toBe(1999);
  });

  it('el código de referido viaja opaco en la metadata y vuelve como attribution', async () => {
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
    const checkout = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'u@test',
      courseId: 'course-1',
      referralCode: 'abc23xyz',
    });
    expect(stripe.lastCheckout?.metadata['referralCode']).toBe('abc23xyz');
    publisher.events = [];

    const event = buildSessionCompletedEvent(checkout.orderId);
    const session = event.data.object as Stripe.Checkout.Session;
    session.metadata = { ...session.metadata, referralCode: 'abc23xyz' };
    await svc.handleWebhookEvent(event, {}, { tenantId: 't1' });
    expect(publisher.events[0]!.payload.attribution).toEqual({ referralCode: 'abc23xyz' });

    // Reentrega con la orden ya COMPLETED: el evento re-publicado conserva la
    // atribución (si no, una caída entre el update y el publish la perdería).
    // (Otro id de evento: el mismo id lo descarta antes la idempotencia.)
    publisher.events = [];
    await svc.handleWebhookEvent({ ...event, id: 'evt_reentrega' }, {}, { tenantId: 't1' });
    expect(publisher.events[0]!.payload.attribution).toEqual({ referralCode: 'abc23xyz' });
  });

  it('sin enlace de referido el evento lleva attribution null y la metadata no lo menciona', async () => {
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
    const checkout = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'u@test',
      courseId: 'course-1',
    });
    expect(stripe.lastCheckout?.metadata).not.toHaveProperty('referralCode');
    publisher.events = [];
    await svc.handleWebhookEvent(
      buildSessionCompletedEvent(checkout.orderId),
      {},
      { tenantId: 't1' },
    );
    expect(publisher.events[0]!.payload.attribution).toBeNull();
  });

  async function comprarYCobrar() {
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
    const checkout = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'u@test',
      courseId: 'course-1',
    });
    const ev = buildSessionCompletedEvent(checkout.orderId);
    (ev.data.object as unknown as { payment_intent: string }).payment_intent = 'pi_test_1';
    await svc.handleWebhookEvent(ev, {}, { tenantId: 't1' });
    publisher.events = [];
    return checkout.orderId;
  }

  function refundEvent(id: string, amount: number, refunded: number): Stripe.Event {
    return {
      id,
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_1',
          payment_intent: 'pi_test_1',
          amount,
          amount_refunded: refunded,
        } as unknown as Stripe.Charge,
      },
    } as Stripe.Event;
  }

  it('un reembolso TOTAL marca la orden como REFUNDED y emite el evento para retirar el acceso', async () => {
    const orderId = await comprarYCobrar();

    await svc.handleWebhookEvent(
      refundEvent('evt_refund_total', 1999, 1999),
      {},
      { tenantId: 't1' },
    );

    expect(prisma.orders.get(orderId)!.status).toBe('REFUNDED');
    expect(prisma.orders.get(orderId)!.refundedAt).toBeInstanceOf(Date);
    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0]!.name).toBe('billing.order.refunded');
    expect(publisher.events[0]!.payload.courseId).toBe('course-1');
  });

  it('un reembolso PARCIAL no retira el acceso ni marca la orden; avisa con lo devuelto acumulado', async () => {
    const orderId = await comprarYCobrar();

    await svc.handleWebhookEvent(
      refundEvent('evt_refund_parcial', 1999, 500),
      {},
      { tenantId: 't1' },
    );

    expect(prisma.orders.get(orderId)!.status).toBe('COMPLETED');
    // Nada de `billing.order.refunded` (retiraría el acceso): solo el parcial,
    // para recortar en proporción la comisión de referidos.
    expect(publisher.events.map((e) => e.name)).toEqual(['billing.order.partially_refunded']);
    expect(publisher.events[0]!.payload).toMatchObject({
      orderId,
      amountRefunded: 500,
      amountTotal: 1999,
    });
  });

  it('un reembolso de un cobro AJENO (otro módulo) no toca ninguna orden', async () => {
    const orderId = await comprarYCobrar();
    const ajeno = refundEvent('evt_refund_ajeno', 39900, 39900);
    (ajeno.data.object as unknown as { payment_intent: string }).payment_intent = 'pi_membresia';

    await svc.handleWebhookEvent(ajeno, {}, { tenantId: 't1' });

    expect(prisma.orders.get(orderId)!.status).toBe('COMPLETED');
    expect(publisher.events).toHaveLength(0);
  });

  it('un evento recibido pero NO procesado se reintenta (no se queda "quemado")', async () => {
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
    const checkout = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'u@test',
      courseId: 'course-1',
    });
    publisher.events = [];

    // Primer intento: el trabajo de dominio falla a mitad (simulamos borrando
    // la order justo después de que el evento quede registrado).
    const event = buildSessionCompletedEvent('order-inexistente');
    await expect(svc.handleWebhookEvent(event, {}, { tenantId: 't1' })).rejects.toThrow();
    expect(publisher.events).toHaveLength(0);

    // Segundo intento con el MISMO id de evento (reintento de Stripe), esta vez
    // con la order correcta: debe volver a intentarlo, no salir por idempotencia.
    const reintento = buildSessionCompletedEvent(checkout.orderId);
    reintento.id = event.id;
    await svc.handleWebhookEvent(reintento, {}, { tenantId: 't1' });

    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0]!.name).toBe('billing.order.completed');
  });

  it('ignora en silencio el checkout de OTRO módulo (membresía) en el endpoint compartido', async () => {
    // Un único endpoint de Stripe alimenta a mod.billing y a mod.subscriptions.
    // La sesión de la membresía no lleva courseId ni productId: billing debe
    // archivarla y seguir, NO lanzar (un 5xx haría que Stripe reintentara
    // durante días un evento que nunca fue suyo).
    const membershipEvent = {
      id: 'evt_membership_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_membership',
          client_reference_id: 'plan-anual-uuid',
          metadata: { tenantId: 't1', membership: '1', planId: 'plan-anual-uuid' },
          amount_total: 39900,
          status: 'complete',
        } as unknown as Stripe.Checkout.Session,
      },
    } as Stripe.Event;

    await expect(
      svc.handleWebhookEvent(membershipEvent, {}, { tenantId: 't1' }),
    ).resolves.toBeUndefined();

    // Ni emite eventos de dominio ni deja el webhook marcado como fallido.
    expect(publisher.events).toHaveLength(0);
    const stored = prisma.webhookEvents.get('evt_membership_1');
    expect(stored?.errorMessage ?? null).toBeNull();
    expect(stored?.processedAt).toBeInstanceOf(Date);
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
    await svc.handleWebhookEvent(event, {}, { tenantId: 't1' });
    await svc.handleWebhookEvent(event, {}, { tenantId: 't1' }); // re-entrega de Stripe

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
      { tenantId: 't1' },
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
      { tenantId: 't1' },
    );

    expect(prisma.orders.get(checkout.orderId)!.status).toBe('FAILED');
    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0]!.name).toBe('billing.order.failed');
  });

  // --- Pago de notificación diferida (SEPA, transferencia): el dinero primero ---
  //
  // Todo este bloque protege el mismo fallo: `checkout.session.completed`
  // significa "terminó el formulario", no "hemos cobrado". Mientras el
  // checkout solo aceptó tarjeta el problema fue inalcanzable; en cuanto se
  // abran más métodos de pago, es la diferencia entre vender y regalar.

  /** Sesión de un pago diferido: el comprador terminó, pero el dinero no está. */
  function unpaidCompletedEvent(orderId: string, eventId: string): Stripe.Event {
    return {
      id: eventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_sepa',
          metadata: {
            orderId,
            tenantId: 't1',
            userId: 'u1',
            courseId: 'course-1',
            productId: 'prod-1',
          },
          amount_total: 1999,
          customer_email: 'u@test',
          customer_details: { email: 'u@test' },
          payment_intent: 'pi_sepa_1',
          payment_status: 'unpaid',
          status: 'complete',
        } as unknown as Stripe.Checkout.Session,
      },
    } as Stripe.Event;
  }

  async function pedidoConPagoDiferidoEnCurso(): Promise<string> {
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
      unpaidCompletedEvent(checkout.orderId, 'evt_unpaid'),
      {},
      { tenantId: 't1' },
    );
    return checkout.orderId;
  }

  it('completed con payment_status unpaid NO matricula: la order sigue PENDING', async () => {
    const orderId = await pedidoConPagoDiferidoEnCurso();

    expect(prisma.orders.get(orderId)!.status).toBe('PENDING');
    expect(publisher.events).toHaveLength(0);
  });

  it('completed con payment_status unpaid guarda ya el PaymentIntent (para reconocer un reembolso)', async () => {
    const orderId = await pedidoConPagoDiferidoEnCurso();

    const stored = prisma.orders.get(orderId)!;
    expect(stored.stripePaymentIntentId).toBe('pi_sepa_1');
    expect(stored.customerEmail).toBe('u@test');
  });

  it('async_payment_succeeded completa la order y emite ORDER_COMPLETED', async () => {
    const orderId = await pedidoConPagoDiferidoEnCurso();

    const cobrado = unpaidCompletedEvent(orderId, 'evt_sepa_ok');
    (cobrado as { type: string }).type = 'checkout.session.async_payment_succeeded';
    (cobrado.data.object as { payment_status: string }).payment_status = 'paid';
    await svc.handleWebhookEvent(cobrado, {}, { tenantId: 't1' });

    expect(prisma.orders.get(orderId)!.status).toBe('COMPLETED');
    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0]!.name).toBe('billing.order.completed');
  });

  it('async_payment_failed sobre una order YA completada retira el acceso, no la ignora', async () => {
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
    const checkout = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'u@test',
      courseId: 'course-1',
    });
    await svc.handleWebhookEvent(
      buildSessionCompletedEvent(checkout.orderId),
      {},
      { tenantId: 't1' },
    );
    publisher.events = [];

    await svc.handleWebhookEvent(
      {
        id: 'evt_fail_tardio',
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
      { tenantId: 't1' },
    );

    expect(prisma.orders.get(checkout.orderId)!.status).toBe('FAILED');
    // Se revoca por el canal de reembolso, que es el único que cancela la
    // matrícula de compra. `amountRefunded: 0` porque nunca entró el dinero.
    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0]!.name).toBe('billing.order.refunded');
    expect(publisher.events[0]!.payload.amountRefunded).toBe(0);
  });

  it('no_payment_required (código promocional del 100%) SÍ matricula: es compra válida y gratis', async () => {
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
    const checkout = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'u@test',
      courseId: 'course-1',
    });
    publisher.events = [];

    const gratis = buildSessionCompletedEvent(checkout.orderId);
    (gratis.data.object as { payment_status: string; amount_total: number }).payment_status =
      'no_payment_required';
    (gratis.data.object as { payment_status: string; amount_total: number }).amount_total = 0;
    await svc.handleWebhookEvent(gratis, {}, { tenantId: 't1' });

    expect(prisma.orders.get(checkout.orderId)!.status).toBe('COMPLETED');
    expect(publisher.events[0]!.name).toBe('billing.order.completed');
  });

  it('checkout logueado: el fulfillment NO llama al provisioner (la order ya tiene dueño)', async () => {
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
    const checkout = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'u@test',
      courseId: 'course-1',
    });
    publisher.events = [];

    const provision = vi.fn();
    await svc.handleWebhookEvent(
      buildSessionCompletedEvent(checkout.orderId),
      {},
      { tenantId: 't1', provisionUser: provision },
    );

    expect(provision).not.toHaveBeenCalled();
    expect(publisher.events[0]!.payload.userId).toBe('u1');
    expect(publisher.events[0]!.payload.userCreated).toBe(false);
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
      { tenantId: 't1' },
    );

    expect(prisma.webhookEvents.has('evt_invoice')).toBe(true);
    expect(publisher.events).toHaveLength(0);
  });
});

describe('BillingService — checkout PÚBLICO (viaje 2: visitante sin cuenta)', () => {
  let prisma: MockPrisma;
  let stripe: MockStripe;
  let publisher: MockPublisher;
  let svc: BillingService;

  beforeEach(async () => {
    prisma = new MockPrisma();
    stripe = new MockStripe();
    publisher = new MockPublisher();
    svc = new BillingService(prisma as unknown as never, async () => stripe, publisher, urls);
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
  });

  /** Evento completed de una session ANÓNIMA: sin userId en la metadata. */
  function anonymousCompletedEvent(
    orderId: string,
    opts?: { email?: string | null; name?: string | null; eventId?: string },
  ): Stripe.Event {
    return {
      id: opts?.eventId ?? `evt_anon_${orderId}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_anon',
          metadata: { orderId, tenantId: 't1', courseId: 'course-1', productId: 'prod-1' },
          amount_total: 999,
          customer_email: null,
          customer_details:
            opts?.email === null
              ? { email: null }
              : { email: opts?.email ?? ' Compradora@Example.COM ', name: opts?.name ?? 'Ana' },
          payment_intent: 'pi_anon_1',
          payment_status: 'paid',
          status: 'complete',
        } as unknown as Stripe.Checkout.Session,
      },
    } as Stripe.Event;
  }

  it('startCheckout anónimo: order PENDING sin dueño y metadata sin userId', async () => {
    const checkout = await svc.startCheckout({
      tenantId: 't1',
      courseId: 'course-1',
      successUrl:
        'https://aula.example.com/catalog/checkout/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://aula.example.com/catalog/checkout/cancel',
    });

    const stored = prisma.orders.get(checkout.orderId)!;
    expect(stored.status).toBe('PENDING');
    expect(stored.userId).toBeNull();
    // La marca de pertenencia (orderId+productId) viaja; userId NO.
    expect(stripe.lastCheckout?.metadata.orderId).toBe(checkout.orderId);
    expect(stripe.lastCheckout?.metadata.productId).toBeTruthy();
    expect(stripe.lastCheckout?.metadata).not.toHaveProperty('userId');
    // Sin email: lo recoge el checkout hosted de Stripe.
    expect(stripe.lastCheckout?.customerEmail).toBeUndefined();
    // ORDER_CREATED sin actor (no hay usuario todavía).
    expect(publisher.events[0]!.name).toBe('billing.order.created');
    expect(publisher.events[0]!.actorId).toBeNull();
  });

  it('fulfillment anónimo: materializa al comprador con el email CONFIRMADO en Stripe y emite completed con su userId', async () => {
    const checkout = await svc.startCheckout({ tenantId: 't1', courseId: 'course-1' });
    publisher.events = [];
    const provision = vi.fn().mockResolvedValue({ userId: 'u-nueva', created: true });

    await svc.handleWebhookEvent(
      anonymousCompletedEvent(checkout.orderId),
      {},
      { tenantId: 't1', provisionUser: provision },
    );

    // Email normalizado (trim + lowercase) y nombre de Stripe.
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledWith({
      tenantId: 't1',
      email: 'compradora@example.com',
      name: 'Ana',
      // El curso comprado: la bienvenida lleva al alumno a él tras entrar.
      courseId: 'course-1',
    });
    const updated = prisma.orders.get(checkout.orderId)!;
    expect(updated.status).toBe('COMPLETED');
    expect(updated.userId).toBe('u-nueva');
    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0]!.name).toBe('billing.order.completed');
    expect(publisher.events[0]!.payload.userId).toBe('u-nueva');
    expect(publisher.events[0]!.payload.userCreated).toBe(true);
  });

  it('el idioma de la compra viaja en la metadata y llega al provisioner', async () => {
    // La cuenta del comprador anónimo se crea AQUÍ, después del salto a Stripe:
    // la metadata de la session es el único canal que lo sobrevive. Sin esto,
    // un comprador anglófono acaba con el idioma de referencia guardado y
    // recibe la bienvenida en español.
    const checkout = await svc.startCheckout({
      tenantId: 't1',
      courseId: 'course-1',
      locale: 'en-US',
    });
    expect(stripe.lastCheckout?.metadata.locale).toBe('en-US');

    const provision = vi.fn().mockResolvedValue({ userId: 'u-nueva', created: true });
    const event = anonymousCompletedEvent(checkout.orderId);
    (event.data.object as { metadata: Record<string, string> }).metadata.locale = 'en-US';
    await svc.handleWebhookEvent(event, {}, { tenantId: 't1', provisionUser: provision });
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en-US' }));
  });

  it('sin idioma capturado, la metadata NO lleva la clave y el provisioner recibe undefined', async () => {
    const checkout = await svc.startCheckout({ tenantId: 't1', courseId: 'course-1' });
    expect(stripe.lastCheckout?.metadata).not.toHaveProperty('locale');

    const provision = vi.fn().mockResolvedValue({ userId: 'u-nueva', created: true });
    await svc.handleWebhookEvent(
      anonymousCompletedEvent(checkout.orderId),
      {},
      { tenantId: 't1', provisionUser: provision },
    );
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ locale: undefined }));
  });

  it('reentrega del webhook: NO provisiona dos veces ni re-emite el evento', async () => {
    const checkout = await svc.startCheckout({ tenantId: 't1', courseId: 'course-1' });
    publisher.events = [];
    const provision = vi.fn().mockResolvedValue({ userId: 'u-nueva', created: true });
    const event = anonymousCompletedEvent(checkout.orderId);

    await svc.handleWebhookEvent(event, {}, { tenantId: 't1', provisionUser: provision });
    await svc.handleWebhookEvent(event, {}, { tenantId: 't1', provisionUser: provision });

    expect(provision).toHaveBeenCalledTimes(1);
    expect(publisher.events).toHaveLength(1);
  });

  it('sin provisioner del host: lanza y el evento queda reintentable (no se quema el pago)', async () => {
    const checkout = await svc.startCheckout({ tenantId: 't1', courseId: 'course-1' });
    publisher.events = [];
    const event = anonymousCompletedEvent(checkout.orderId);

    await expect(svc.handleWebhookEvent(event, {}, { tenantId: 't1' })).rejects.toThrow(
      /provisioner/,
    );
    expect(prisma.orders.get(checkout.orderId)!.status).toBe('PENDING');

    // El reintento de Stripe (mismo event id), esta vez con provisioner, completa.
    const provision = vi.fn().mockResolvedValue({ userId: 'u-nueva', created: true });
    await svc.handleWebhookEvent(event, {}, { tenantId: 't1', provisionUser: provision });
    expect(prisma.orders.get(checkout.orderId)!.status).toBe('COMPLETED');
    expect(publisher.events).toHaveLength(1);
  });

  it('session pagada sin email del comprador: lanza (Stripe reintenta) en vez de completar sin dueño', async () => {
    const checkout = await svc.startCheckout({ tenantId: 't1', courseId: 'course-1' });
    const provision = vi.fn();

    await expect(
      svc.handleWebhookEvent(
        anonymousCompletedEvent(checkout.orderId, { email: null }),
        {},
        { tenantId: 't1', provisionUser: provision },
      ),
    ).rejects.toThrow(/email/);
    expect(provision).not.toHaveBeenCalled();
    expect(prisma.orders.get(checkout.orderId)!.status).toBe('PENDING');
  });

  it('comprador con cuenta EXISTENTE (mismo email): reutiliza su userId sin crear otra', async () => {
    const checkout = await svc.startCheckout({ tenantId: 't1', courseId: 'course-1' });
    publisher.events = [];
    const provision = vi.fn().mockResolvedValue({ userId: 'u-existente', created: false });

    await svc.handleWebhookEvent(
      anonymousCompletedEvent(checkout.orderId),
      {},
      { tenantId: 't1', provisionUser: provision },
    );

    expect(prisma.orders.get(checkout.orderId)!.userId).toBe('u-existente');
    expect(publisher.events[0]!.payload.userCreated).toBe(false);
  });

  it('getCatalog agrupa las opciones ACTIVAS por curso con el % de descuento derivado', async () => {
    await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-2',
      unitAmount: 5000,
      compareAtAmount: 10000,
      optionName: 'Curso',
    });
    await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-2',
      unitAmount: 9000,
      optionName: 'Curso Avanzado',
      sortOrder: 1,
    });
    // Una opción desactivada no aparece en el catálogo público.
    const apagada = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-3',
      unitAmount: 700,
    });
    await svc.updateProduct({
      tenantId: 't1',
      productId: apagada.product.id,
      patch: { active: false },
    });

    const catalogo = await svc.getCatalog('t1');

    const ids = catalogo.map((c) => c.courseId).sort();
    expect(ids).toEqual(['course-1', 'course-2']);
    const curso2 = catalogo.find((c) => c.courseId === 'course-2')!;
    expect(curso2.options.map((o) => o.name)).toEqual(['Curso', 'Curso Avanzado']);
    expect(curso2.options[0]!.discountPercent).toBe(50);
    expect(curso2.options[1]!.discountPercent).toBeNull();
  });

  it('checkout anónimo expirado: order CANCELLED sin provisionar a nadie', async () => {
    const checkout = await svc.startCheckout({ tenantId: 't1', courseId: 'course-1' });
    publisher.events = [];
    const provision = vi.fn();

    await svc.handleWebhookEvent(
      {
        id: 'evt_anon_expire',
        type: 'checkout.session.expired',
        data: {
          object: {
            id: 'cs_anon',
            metadata: { orderId: checkout.orderId },
            status: 'expired',
          } as unknown as Stripe.Checkout.Session,
        },
      } as Stripe.Event,
      {},
      { tenantId: 't1', provisionUser: provision },
    );

    expect(prisma.orders.get(checkout.orderId)!.status).toBe('CANCELLED');
    expect(provision).not.toHaveBeenCalled();
    expect(publisher.events).toHaveLength(0);
  });
});

describe('BillingService — resolveWebhookTenantClaims (mitad lookup del webhook)', () => {
  let prisma: MockPrisma;
  let stripe: MockStripe;
  let publisher: MockPublisher;
  let svc: BillingService;

  beforeEach(() => {
    prisma = new MockPrisma();
    stripe = new MockStripe();
    publisher = new MockPublisher();
    svc = new BillingService(prisma as unknown as never, async () => stripe, publisher, urls);
  });

  it('checkout con orderId → el tenant que nombra la metadata (la orden aún no existe en local)', async () => {
    const claims = await svc.resolveWebhookTenantClaims({
      id: 'evt_res_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          metadata: { orderId: 'order-1', productId: 'prod-1', tenantId: 't-meta' },
        } as unknown as Stripe.Checkout.Session,
      },
    } as Stripe.Event);
    expect(claims).toEqual(['t-meta']);
  });

  it('checkout SIN orderId (p.ej. membresía de mod.subscriptions) → sin claims', async () => {
    const claims = await svc.resolveWebhookTenantClaims({
      id: 'evt_res_2',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_2',
          metadata: { tenantId: 't-ajeno', membership: '1' },
        } as unknown as Stripe.Checkout.Session,
      },
    } as Stripe.Event);
    expect(claims).toEqual([]);
  });

  it('charge.refunded → tenant de la order por stripePaymentIntentId', async () => {
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
    const checkout = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'u@test',
      courseId: 'course-1',
    });
    prisma.orders.get(checkout.orderId)!.stripePaymentIntentId = 'pi_res_1';

    const claims = await svc.resolveWebhookTenantClaims({
      id: 'evt_res_3',
      type: 'charge.refunded',
      data: {
        object: { id: 'ch_1', payment_intent: 'pi_res_1' } as unknown as Stripe.Charge,
      },
    } as Stripe.Event);
    expect(claims).toEqual(['t1']);

    // PaymentIntent desconocido (cobro ajeno) → sin claims.
    expect(
      await svc.resolveWebhookTenantClaims({
        id: 'evt_res_4',
        type: 'charge.refunded',
        data: {
          object: { id: 'ch_2', payment_intent: 'pi_desconocido' } as unknown as Stripe.Charge,
        },
      } as Stripe.Event),
    ).toEqual([]);
  });

  it('evento sin lógica de dominio → sin claims (solo se archiva)', async () => {
    expect(
      await svc.resolveWebhookTenantClaims({
        id: 'evt_res_5',
        type: 'payment_method.attached',
        data: { object: {} },
      } as unknown as Stripe.Event),
    ).toEqual([]);
  });
});

/**
 * Segunda cerradura del aislamiento entre aulas (la primera es el host, que
 * rechaza el evento antes de llamar aquí): el módulo no toca una orden que no
 * sea del tenant para el que el host verificó el evento, diga lo que diga la
 * metadata y sin fiarse de que la base filtre.
 */
describe('BillingService — el webhook solo toca órdenes del tenant verificado', () => {
  let prisma: MockPrisma;
  let stripe: MockStripe;
  let publisher: MockPublisher;
  let svc: BillingService;
  let orderId: string;

  beforeEach(async () => {
    prisma = new MockPrisma();
    stripe = new MockStripe();
    publisher = new MockPublisher();
    svc = new BillingService(prisma as unknown as never, async () => stripe, publisher, urls);
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
    const checkout = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'u@test',
      courseId: 'course-1',
    });
    orderId = checkout.orderId;
    publisher.events = [];
  });

  function completed(metadataTenantId: string): Stripe.Event {
    return {
      id: `evt_cruzado_${metadataTenantId}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_cruzada',
          metadata: {
            orderId,
            tenantId: metadataTenantId,
            courseId: 'course-1',
            productId: 'prod-1',
          },
          amount_total: 1999,
          customer_details: { email: 'u@test' },
          payment_status: 'paid',
          status: 'complete',
        } as unknown as Stripe.Checkout.Session,
      },
    } as Stripe.Event;
  }

  it('completed de una orden de t1 procesado para OTRO tenant → lanza y la orden sigue PENDING', async () => {
    // La metadata dice la verdad (t1) pero el host lo verificó para `t-otro`.
    await expect(
      svc.handleWebhookEvent(completed('t1'), {}, { tenantId: 't-otro' }),
    ).rejects.toBeInstanceOf(WebhookTenantMismatchError);

    expect(prisma.orders.get(orderId)!.status).toBe('PENDING');
    expect(publisher.events).toHaveLength(0);
  });

  it('metadata que dice «es de t-otro» apuntando a una orden de t1 → lanza y no se toca', async () => {
    // Quien firma escribe la metadata Y el orderId: que la metadata coincida
    // con el tenant verificado no basta, la orden tiene que ser suya.
    const provision = vi.fn();
    await expect(
      svc.handleWebhookEvent(
        completed('t-otro'),
        {},
        { tenantId: 't-otro', provisionUser: provision },
      ),
    ).rejects.toBeInstanceOf(WebhookTenantMismatchError);

    expect(prisma.orders.get(orderId)!.status).toBe('PENDING');
    expect(provision).not.toHaveBeenCalled();
    expect(publisher.events).toHaveLength(0);
  });

  it('async_payment_failed de otra aula sobre una compra pagada → lanza y sigue COMPLETED', async () => {
    await svc.handleWebhookEvent(completed('t1'), {}, { tenantId: 't1' });
    publisher.events = [];

    await expect(
      svc.handleWebhookEvent(
        {
          id: 'evt_fallo_cruzado',
          type: 'checkout.session.async_payment_failed',
          data: {
            object: {
              id: 'cs_cruzada',
              status: 'complete',
              metadata: { orderId },
            } as unknown as Stripe.Checkout.Session,
          },
        } as Stripe.Event,
        {},
        { tenantId: 't-otro' },
      ),
    ).rejects.toBeInstanceOf(WebhookTenantMismatchError);

    expect(prisma.orders.get(orderId)!.status).toBe('COMPLETED');
    expect(publisher.events).toHaveLength(0);
  });

  it('charge.refunded de otra aula sobre una compra de t1 → lanza y no se reembolsa', async () => {
    const ev = completed('t1');
    (ev.data.object as unknown as { payment_intent: string }).payment_intent = 'pi_de_t1';
    await svc.handleWebhookEvent(ev, {}, { tenantId: 't1' });
    publisher.events = [];

    await expect(
      svc.handleWebhookEvent(
        {
          id: 'evt_reembolso_cruzado',
          type: 'charge.refunded',
          data: {
            object: {
              id: 'ch_x',
              payment_intent: 'pi_de_t1',
              amount: 1999,
              amount_refunded: 1999,
            } as unknown as Stripe.Charge,
          },
        } as Stripe.Event,
        {},
        { tenantId: 't-otro' },
      ),
    ).rejects.toBeInstanceOf(WebhookTenantMismatchError);

    expect(prisma.orders.get(orderId)!.status).toBe('COMPLETED');
    expect(publisher.events).toHaveLength(0);
  });

  it('sin tenant verificado no se procesa nada (ni se archiva)', async () => {
    await expect(svc.handleWebhookEvent(completed('t1'), {}, {} as never)).rejects.toBeInstanceOf(
      WebhookTenantMismatchError,
    );
    expect(prisma.webhookEvents.size).toBe(0);
    expect(prisma.orders.get(orderId)!.status).toBe('PENDING');
  });

  it('claims: metadata propia + orden ajena → salen LOS DOS tenants (el host lo rechaza)', async () => {
    expect((await svc.resolveWebhookTenantClaims(completed('t-otro'))).sort()).toEqual([
      't-otro',
      't1',
    ]);
  });

  it('claims: un orderId basta para delatar la orden, aunque el evento no traiga más marca', async () => {
    const claims = await svc.resolveWebhookTenantClaims({
      id: 'evt_solo_order',
      type: 'checkout.session.async_payment_failed',
      data: {
        object: { id: 'cs_y', metadata: { orderId } } as unknown as Stripe.Checkout.Session,
      },
    } as Stripe.Event);
    expect(claims).toEqual(['t1']);
  });
});

/**
 * Dos aulas que cobran con la MISMA cuenta de Stripe y tienen cada una su
 * endpoint reciben las dos cada evento. La clave primaria de la tabla de
 * eventos es global; la fila que archivó la otra aula no se ve (RLS). Antes la
 * segunda entrega chocaba con la clave, no encontraba la fila y reventaba al
 * actualizarla: un 500 que Stripe reintentaba durante días.
 */
describe('BillingService — el evento ya lo archivó OTRA aula (fila que existe y no se ve)', () => {
  let prisma: MockPrisma;
  let stripe: MockStripe;
  let publisher: MockPublisher;
  let svc: BillingService;

  beforeEach(() => {
    prisma = new MockPrisma();
    stripe = new MockStripe();
    publisher = new MockPublisher();
    svc = new BillingService(prisma as unknown as never, async () => stripe, publisher, urls);
  });

  /** Simula RLS: la fila está (la clave choca) pero ni se lee ni se actualiza. */
  function archivadoPorOtraAula(eventId: string) {
    prisma.webhookEvents.set(eventId, {
      stripeEventId: eventId,
      type: 'x',
      payload: {},
      processedAt: new Date(),
      errorMessage: null,
      receivedAt: new Date(),
    });
    prisma.modBillingWebhookEvent.findUnique = async () => null;
    prisma.modBillingWebhookEvent.update = async () => {
      throw new Error('Record to update not found.');
    };
  }

  it('evento que aquí no toca nada → termina bien (200), sin escribir', async () => {
    archivadoPorOtraAula('evt_compartido');

    await expect(
      svc.handleWebhookEvent(
        {
          id: 'evt_compartido',
          type: 'payment_method.attached',
          data: { object: {} },
        } as unknown as Stripe.Event,
        {},
        { tenantId: 't1' },
      ),
    ).resolves.toBeUndefined();
    expect(publisher.events).toHaveLength(0);
  });

  it('evento que SÍ es de esta aula → el trabajo se hace igual, aunque no haya fila propia en la que apuntarlo', async () => {
    stripe.setPrice('price_a');
    await svc.createProduct({ tenantId: 't1', courseId: 'course-1', stripePriceId: 'price_a' });
    const checkout = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      userEmail: 'u@test',
      courseId: 'course-1',
    });
    publisher.events = [];
    archivadoPorOtraAula('evt_mio');

    await svc.handleWebhookEvent(
      {
        id: 'evt_mio',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_1',
            metadata: {
              orderId: checkout.orderId,
              tenantId: 't1',
              courseId: 'course-1',
              productId: 'prod-1',
            },
            amount_total: 1999,
            customer_details: { email: 'u@test' },
            payment_status: 'paid',
            status: 'complete',
          } as unknown as Stripe.Checkout.Session,
        },
      } as Stripe.Event,
      {},
      { tenantId: 't1' },
    );

    expect(prisma.orders.get(checkout.orderId)!.status).toBe('COMPLETED');
    expect(publisher.events.map((e) => e.name)).toEqual(['billing.order.completed']);
  });

  it('un fallo de dominio sale tal cual: apuntarlo en el archivo no lo tapa', async () => {
    // Fila propia y visible, pero la escritura del error también falla.
    prisma.modBillingWebhookEvent.update = async () => {
      throw new Error('la base no contesta');
    };

    await expect(
      svc.handleWebhookEvent(
        {
          id: 'evt_falla',
          type: 'checkout.session.completed',
          data: {
            object: {
              id: 'cs_2',
              metadata: {
                orderId: 'no-existe',
                tenantId: 't1',
                courseId: 'c',
                productId: 'p',
              },
              payment_status: 'paid',
            } as unknown as Stripe.Checkout.Session,
          },
        } as Stripe.Event,
        {},
        { tenantId: 't1' },
      ),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
  });

  it('un error al archivar que NO es de clave única no se confunde con un duplicado', async () => {
    // Antes bastaba con que el mensaje nombrara la tabla: un rechazo de RLS al
    // insertar se tomaba por «ya recibido».
    prisma.modBillingWebhookEvent.create = async () => {
      throw new Error(
        'new row violates row-level security policy for table "mod_billing_webhook_event"',
      );
    };

    await expect(
      svc.handleWebhookEvent(
        { id: 'evt_rls', type: 'payment_method.attached', data: { object: {} } } as never,
        {},
        { tenantId: 't1' },
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('BillingService — resyncStripeCatalog (el tenant cambia de cuenta de Stripe)', () => {
  let prisma: MockPrisma;
  let stripe: MockStripe;
  let svc: BillingService;

  function seed(id: string, extra: Partial<ProductRow> = {}) {
    prisma.products.set(id, {
      id,
      tenantId: 'tenant-1',
      courseId: 'course-1',
      stripeProductId: `prod_viejo_${id}`,
      stripePriceId: `price_viejo_${id}`,
      unitAmount: 4900,
      currency: 'eur',
      compareAtAmount: null,
      name: '',
      perks: [],
      sortOrder: 0,
      isFeatured: false,
      externalRef: null,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...extra,
    });
  }

  beforeEach(() => {
    prisma = new MockPrisma();
    stripe = new MockStripe();
    svc = new BillingService(
      prisma as unknown as never,
      async () => stripe,
      new MockPublisher(),
      urls,
    );
  });

  it('recrea Product y Price en la cuenta actual con el mismo importe y apunta la fila al nuevo', async () => {
    seed('p1');
    expect(await svc.resyncStripeCatalog('tenant-1')).toEqual({ resynced: 1, skipped: 0 });
    const fila = prisma.products.get('p1')!;
    expect(fila.stripePriceId).toMatch(/^price_auto_/);
    expect(fila.stripeProductId).toMatch(/^prod_auto_/);
    // El nombre del Product sale del viejo: es lo que veía el comprador.
    expect(stripe.lastOneOffPrice).toEqual({
      name: 'Test product',
      unitAmount: 4900,
      currency: 'eur',
      // Sin precios por mercado guardados, el Price nuevo tampoco los lleva.
      currencyOptions: null,
    });
    expect(fila.unitAmount).toBe(4900);
    expect(fila.currency).toBe('eur');
  });

  it('no toca los precios que ya están en la cuenta actual (isCurrent) y una segunda pasada no hace nada', async () => {
    seed('p1');
    seed('p2', { courseId: 'course-2' });
    const actuales = new Set<string>();
    const isCurrent = async (id: string) => actuales.has(id);

    expect(await svc.resyncStripeCatalog('tenant-1', { isCurrent })).toEqual({
      resynced: 2,
      skipped: 0,
    });
    for (const p of prisma.products.values()) actuales.add(p.stripePriceId);
    expect(await svc.resyncStripeCatalog('tenant-1', { isCurrent })).toEqual({
      resynced: 0,
      skipped: 2,
    });
  });

  it('acota por curso e ignora las opciones inactivas y las de otros tenants', async () => {
    seed('p1');
    seed('p2', { courseId: 'course-2' });
    seed('p3', { active: false });
    seed('p4', { tenantId: 'tenant-2' });
    expect(await svc.resyncStripeCatalog('tenant-1', { courseId: 'course-1' })).toEqual({
      resynced: 1,
      skipped: 0,
    });
    expect(prisma.products.get('p1')!.stripePriceId).toMatch(/^price_auto_/);
    expect(prisma.products.get('p2')!.stripePriceId).toBe('price_viejo_p2');
    expect(prisma.products.get('p3')!.stripePriceId).toBe('price_viejo_p3');
    expect(prisma.products.get('p4')!.stripePriceId).toBe('price_viejo_p4');
  });

  it('si el Product viejo no se puede leer, usa el nombre de la opción', async () => {
    seed('p1', { name: 'Curso Avanzado' });
    stripe.retrieveProduct = async () => {
      throw new StripeApiError('No such product');
    };
    await svc.resyncStripeCatalog('tenant-1');
    expect(stripe.lastOneOffPrice?.name).toBe('Curso Avanzado');
  });

  it('sin opciones activas no pide el adaptador de Stripe', async () => {
    const sinStripe = new BillingService(
      prisma as unknown as never,
      async () => {
        throw new Error('no debería resolver Stripe');
      },
      new MockPublisher(),
      urls,
    );
    await expect(sinStripe.resyncStripeCatalog('tenant-1')).resolves.toEqual({
      resynced: 0,
      skipped: 0,
    });
  });
});

describe('BillingService — sesiones de pago con un precio viejo (venta real del 14-nov)', () => {
  let prisma: MockPrisma;
  let stripe: MockStripe;
  let svc: BillingService;

  beforeEach(() => {
    prisma = new MockPrisma();
    stripe = new MockStripe();
    svc = new BillingService(
      prisma as unknown as never,
      async () => stripe,
      new MockPublisher(),
      urls,
    );
  });

  async function curso29() {
    const { product } = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 2900,
      currency: 'eur',
    });
    return product;
  }

  async function abrirSesion(productId: string, status = 'open', hace = 0) {
    const r = await svc.startCheckout({ tenantId: 't1', userId: 'u1', courseId: 'course-1' });
    const order = prisma.orders.get(r.orderId)!;
    expect(order.productId).toBe(productId);
    if (hace) order.createdAt = new Date(Date.now() - hace);
    if (status !== 'open') stripe.sessionStatus.set(r.sessionId, status);
    return r;
  }

  it('el precio que vio el comprador ya no es el actual: 409 y NO se crea ni pedido ni sesión', async () => {
    await curso29();
    await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 100,
      currency: 'eur',
    });
    const antes = stripe.sessionCounter;

    const err = await svc
      .startCheckout({
        tenantId: 't1',
        userId: 'u1',
        courseId: 'course-1',
        expectedPrice: { unitAmount: 2900, currency: 'eur' },
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PriceChangedError);
    expect((err as PriceChangedError).code).toBe('BILLING_PRICE_CHANGED');
    expect((err as PriceChangedError).current).toEqual({ unitAmount: 100, currency: 'eur' });
    expect(prisma.orders.size).toBe(0);
    expect(stripe.sessionCounter).toBe(antes);
  });

  it('control: con el precio actual (y la moneda en mayúsculas) se crea la sesión', async () => {
    await curso29();
    const r = await svc.startCheckout({
      tenantId: 't1',
      userId: 'u1',
      courseId: 'course-1',
      expectedPrice: { unitAmount: 2900, currency: 'EUR' },
    });
    expect(r.sessionId).toMatch(/^cs_test_/);
  });

  it('bajar el precio caduca las sesiones abiertas de esa opción y cierra sus pedidos; lo pagado y lo viejo no se tocan', async () => {
    const product = await curso29();
    const abierta = await abrirSesion(product.id);
    const pagada = await abrirSesion(product.id, 'complete');
    const vieja = await abrirSesion(product.id, 'open', 26 * 60 * 60 * 1000);

    const r = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 100,
      currency: 'eur',
    });

    expect(r.accion).toBe('actualizado');
    expect(r.checkouts).toEqual({ expired: 1, cancelledOrders: 1, alreadyPaid: 1, failed: 0 });
    expect(stripe.expired).toEqual([abierta.sessionId]);
    expect(prisma.orders.get(abierta.orderId)!.status).toBe('CANCELLED');
    // Pagada mientras tanto: la completa su webhook.
    expect(prisma.orders.get(pagada.orderId)!.status).toBe('PENDING');
    // Más de 24 h: Stripe ya la caducó sola; no se le pregunta.
    expect(prisma.orders.get(vieja.orderId)!.status).toBe('PENDING');
  });

  it('cambiar solo el precio tachado no toca las sesiones abiertas', async () => {
    const product = await curso29();
    const abierta = await abrirSesion(product.id);
    const r = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 2900,
      currency: 'eur',
      compareAtAmount: 4900,
    });
    expect(r.checkouts).toBeUndefined();
    expect(stripe.expired).toEqual([]);
    expect(prisma.orders.get(abierta.orderId)!.status).toBe('PENDING');
  });

  it('retirar la opción de la venta caduca sus sesiones; reactivarla no', async () => {
    const product = await curso29();
    const abierta = await abrirSesion(product.id);
    await svc.updateProduct({ tenantId: 't1', productId: product.id, patch: { active: false } });
    expect(stripe.expired).toEqual([abierta.sessionId]);
    expect(prisma.orders.get(abierta.orderId)!.status).toBe('CANCELLED');

    await svc.updateProduct({ tenantId: 't1', productId: product.id, patch: { active: true } });
    expect(stripe.expired).toHaveLength(1);
  });

  it('borrar la opción caduca antes sus sesiones abiertas', async () => {
    const product = await curso29();
    const abierta = await abrirSesion(product.id);
    await svc.deleteProduct('t1', product.id);
    expect(stripe.expired).toEqual([abierta.sessionId]);
    expect(prisma.orders.get(abierta.orderId)!.status).toBe('CANCELLED');
  });

  it('archivar el curso (por curso): caduca las de todas sus opciones', async () => {
    const product = await curso29();
    const abierta = await abrirSesion(product.id);
    const r = await svc.expireOpenCheckouts('t1', { courseId: 'course-1' });
    expect(r.cancelledOrders).toBe(1);
    expect(prisma.orders.get(abierta.orderId)!.status).toBe('CANCELLED');
  });

  it('Stripe no responde: el cambio de precio sigue, y el pedido queda pendiente (no se miente)', async () => {
    const product = await curso29();
    const abierta = await abrirSesion(product.id);
    stripe.failExpire = true;
    const r = await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 100,
      currency: 'eur',
    });
    expect(r.product.unitAmount).toBe(100);
    expect(r.checkouts).toMatchObject({ failed: 1, cancelledOrders: 0 });
    expect(prisma.orders.get(abierta.orderId)!.status).toBe('PENDING');
  });

  it('el webhook checkout.session.expired posterior no hace nada más (idempotente)', async () => {
    const product = await curso29();
    const abierta = await abrirSesion(product.id);
    await svc.upsertCoursePrice({
      tenantId: 't1',
      courseId: 'course-1',
      unitAmount: 100,
      currency: 'eur',
    });

    await svc.handleWebhookEvent(
      {
        id: 'evt_expired_1',
        type: 'checkout.session.expired',
        data: {
          object: {
            id: abierta.sessionId,
            status: 'expired',
            metadata: { orderId: abierta.orderId, tenantId: 't1', courseId: 'course-1' },
          },
        },
      } as unknown as Stripe.Event,
      {},
      { tenantId: 't1' },
    );
    expect(prisma.orders.get(abierta.orderId)!.status).toBe('CANCELLED');
  });
});
