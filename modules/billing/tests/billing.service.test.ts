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
    findFirst: async (args: { where: { stripePaymentIntentId?: string } }) => {
      for (const o of this.orders.values()) {
        if (
          args.where.stripePaymentIntentId &&
          o.stripePaymentIntentId === args.where.stripePaymentIntentId
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
  } | null = null;
  lastOneOffPrice: { name: string; unitAmount: number; currency: string } | null = null;

  async createCheckoutSession(params: {
    metadata: Record<string, string>;
    successUrl: string;
    cancelUrl: string;
    customerEmail?: string;
  }) {
    this.sessionCounter += 1;
    this.lastCheckout = {
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      metadata: params.metadata,
      customerEmail: params.customerEmail,
    };
    return {
      id: `cs_test_${this.sessionCounter}`,
      url: `https://checkout.stripe.test/cs_test_${this.sessionCounter}`,
    };
  }

  async createOneOffPrice(params: {
    name: string;
    productId?: string;
    unitAmount: number;
    currency: string;
    metadata: Record<string, string>;
  }) {
    this.lastOneOffPrice = {
      name: params.name,
      unitAmount: params.unitAmount,
      currency: params.currency,
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
        'https://aula.example.com/cursos/checkout/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://aula.example.com/cursos/checkout/cancel',
    });

    expect(stripe.lastCheckout?.successUrl).toBe(
      'https://aula.example.com/cursos/checkout/success?session_id={CHECKOUT_SESSION_ID}',
    );
    expect(stripe.lastCheckout?.cancelUrl).toBe('https://aula.example.com/cursos/checkout/cancel');
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
    expect(publisher.events[0]!.name).toBe('billing.order.completed');
    expect(publisher.events[0]!.payload.amountPaid).toBe(1999);
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
    await svc.handleWebhookEvent(ev, {});
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

    await svc.handleWebhookEvent(refundEvent('evt_refund_total', 1999, 1999), {});

    expect(prisma.orders.get(orderId)!.status).toBe('REFUNDED');
    expect(prisma.orders.get(orderId)!.refundedAt).toBeInstanceOf(Date);
    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0]!.name).toBe('billing.order.refunded');
    expect(publisher.events[0]!.payload.courseId).toBe('course-1');
  });

  it('un reembolso PARCIAL no retira el acceso ni marca la orden', async () => {
    const orderId = await comprarYCobrar();

    await svc.handleWebhookEvent(refundEvent('evt_refund_parcial', 1999, 500), {});

    expect(prisma.orders.get(orderId)!.status).toBe('COMPLETED');
    expect(publisher.events).toHaveLength(0);
  });

  it('un reembolso de un cobro AJENO (otro módulo) no toca ninguna orden', async () => {
    const orderId = await comprarYCobrar();
    const ajeno = refundEvent('evt_refund_ajeno', 39900, 39900);
    (ajeno.data.object as unknown as { payment_intent: string }).payment_intent = 'pi_membresia';

    await svc.handleWebhookEvent(ajeno, {});

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
    await expect(svc.handleWebhookEvent(event, {})).rejects.toThrow();
    expect(publisher.events).toHaveLength(0);

    // Segundo intento con el MISMO id de evento (reintento de Stripe), esta vez
    // con la order correcta: debe volver a intentarlo, no salir por idempotencia.
    const reintento = buildSessionCompletedEvent(checkout.orderId);
    reintento.id = event.id;
    await svc.handleWebhookEvent(reintento, {});

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

    await expect(svc.handleWebhookEvent(membershipEvent, {})).resolves.toBeUndefined();

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
    expect(publisher.events[0]!.name).toBe('billing.order.failed');
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
      {
        provisionUser: provision,
      },
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
        'https://aula.example.com/catalogo/checkout/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://aula.example.com/catalogo/checkout/cancel',
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
      {
        provisionUser: provision,
      },
    );

    // Email normalizado (trim + lowercase) y nombre de Stripe.
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledWith({
      tenantId: 't1',
      email: 'compradora@example.com',
      name: 'Ana',
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
    await svc.handleWebhookEvent(event, {}, { provisionUser: provision });
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en-US' }));
  });

  it('sin idioma capturado, la metadata NO lleva la clave y el provisioner recibe undefined', async () => {
    const checkout = await svc.startCheckout({ tenantId: 't1', courseId: 'course-1' });
    expect(stripe.lastCheckout?.metadata).not.toHaveProperty('locale');

    const provision = vi.fn().mockResolvedValue({ userId: 'u-nueva', created: true });
    await svc.handleWebhookEvent(
      anonymousCompletedEvent(checkout.orderId),
      {},
      { provisionUser: provision },
    );
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ locale: undefined }));
  });

  it('reentrega del webhook: NO provisiona dos veces ni re-emite el evento', async () => {
    const checkout = await svc.startCheckout({ tenantId: 't1', courseId: 'course-1' });
    publisher.events = [];
    const provision = vi.fn().mockResolvedValue({ userId: 'u-nueva', created: true });
    const event = anonymousCompletedEvent(checkout.orderId);

    await svc.handleWebhookEvent(event, {}, { provisionUser: provision });
    await svc.handleWebhookEvent(event, {}, { provisionUser: provision });

    expect(provision).toHaveBeenCalledTimes(1);
    expect(publisher.events).toHaveLength(1);
  });

  it('sin provisioner del host: lanza y el evento queda reintentable (no se quema el pago)', async () => {
    const checkout = await svc.startCheckout({ tenantId: 't1', courseId: 'course-1' });
    publisher.events = [];
    const event = anonymousCompletedEvent(checkout.orderId);

    await expect(svc.handleWebhookEvent(event, {})).rejects.toThrow(/provisioner/);
    expect(prisma.orders.get(checkout.orderId)!.status).toBe('PENDING');

    // El reintento de Stripe (mismo event id), esta vez con provisioner, completa.
    const provision = vi.fn().mockResolvedValue({ userId: 'u-nueva', created: true });
    await svc.handleWebhookEvent(event, {}, { provisionUser: provision });
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
        {
          provisionUser: provision,
        },
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
      {
        provisionUser: provision,
      },
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
      { provisionUser: provision },
    );

    expect(prisma.orders.get(checkout.orderId)!.status).toBe('CANCELLED');
    expect(provision).not.toHaveBeenCalled();
    expect(publisher.events).toHaveLength(0);
  });
});

describe('BillingService — resolveWebhookTenantId (mitad lookup del patrón F3)', () => {
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

  it('checkout con NUESTRA marca (orderId+productId) → tenant de la metadata', async () => {
    const tenantId = await svc.resolveWebhookTenantId({
      id: 'evt_res_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          metadata: { orderId: 'order-1', productId: 'prod-1', tenantId: 't-meta' },
        } as unknown as Stripe.Checkout.Session,
      },
    } as Stripe.Event);
    expect(tenantId).toBe('t-meta');
  });

  it('checkout SIN nuestra marca (p.ej. membresía de mod.subscriptions) → null', async () => {
    const tenantId = await svc.resolveWebhookTenantId({
      id: 'evt_res_2',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_2',
          metadata: { tenantId: 't-ajeno', membership: '1' },
        } as unknown as Stripe.Checkout.Session,
      },
    } as Stripe.Event);
    expect(tenantId).toBeNull();
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

    const tenantId = await svc.resolveWebhookTenantId({
      id: 'evt_res_3',
      type: 'charge.refunded',
      data: {
        object: { id: 'ch_1', payment_intent: 'pi_res_1' } as unknown as Stripe.Charge,
      },
    } as Stripe.Event);
    expect(tenantId).toBe('t1');

    // PaymentIntent desconocido (cobro ajeno) → null.
    expect(
      await svc.resolveWebhookTenantId({
        id: 'evt_res_4',
        type: 'charge.refunded',
        data: {
          object: { id: 'ch_2', payment_intent: 'pi_desconocido' } as unknown as Stripe.Charge,
        },
      } as Stripe.Event),
    ).toBeNull();
  });

  it('evento sin lógica de dominio → null (el host lo procesa sancionado)', async () => {
    expect(
      await svc.resolveWebhookTenantId({
        id: 'evt_res_5',
        type: 'payment_method.attached',
        data: { object: {} },
      } as unknown as Stripe.Event),
    ).toBeNull();
  });
});
