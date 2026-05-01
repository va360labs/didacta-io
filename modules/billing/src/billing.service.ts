/**
 * BillingService — lógica de dominio de mod.billing.
 *
 * Diseño:
 *  - Stateless: toda persistencia vive en Prisma (3 tablas mod_billing_*).
 *  - Stripe se inyecta vía StripeAdapter (mockeable en tests).
 *  - Eventos de dominio se emiten a través de un publisher inyectado: el
 *    contrato del CORE expone EventBus para módulos. El factory los cablea.
 *  - Idempotencia del webhook: `mod_billing_webhook_event` con PK natural
 *    `stripe_event_id`. Antes de procesar, intentamos crearlo; si choca,
 *    skip silencioso y devolvemos el resultado de la primera vez.
 *
 * Lo que NO hace este service:
 *  - Enrollar al alumno tras pago: lo hace mod.learning escuchando
 *    `billing.order.completed`. Mantiene la regla del contrato modular
 *    (sin FKs cross-module, comunicación solo por eventos).
 *  - UI / formato de respuesta HTTP: lo hace el controller en apps/api.
 *  - Validación de input: lo hace el controller con zod.
 */

import type { PrismaClient } from '@didacta/database';
import type Stripe from 'stripe';
import {
  OrderNotFoundError,
  ProductAlreadyExistsError,
  ProductInactiveError,
  ProductNotFoundError,
  StripeApiError,
} from './errors.js';
import type { StripeAdapter } from './stripe.client.js';

/**
 * Inferimos los tipos de las filas del schema directamente del cliente
 * Prisma — evita acoplarnos a un nombre de export concreto y mantiene
 * coherencia si se renombran modelos en `@didacta/database`.
 */
type BillingProductRow = Awaited<ReturnType<PrismaClient['modBillingProduct']['create']>>;
type BillingOrderRow = Awaited<ReturnType<PrismaClient['modBillingOrder']['create']>>;

export interface BillingEventPublisher {
  publish(
    tenantId: string,
    actorId: string | null,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

export interface CheckoutUrlBuilder {
  successUrl(courseId: string): string;
  cancelUrl(courseId: string): string;
}

export interface CreateProductInput {
  tenantId: string;
  courseId: string;
  stripePriceId: string;
}

export interface UpdateProductInput {
  tenantId: string;
  productId: string;
  patch: { active?: boolean; stripePriceId?: string };
}

export interface StartCheckoutInput {
  tenantId: string;
  userId: string;
  userEmail: string;
  courseId: string;
}

export interface StartCheckoutResult {
  orderId: string;
  sessionId: string;
  url: string;
}

/**
 * Eventos de dominio publicados. Ver `manifest.eventsEmitted`.
 */
const EVENT = {
  ORDER_CREATED: 'billing.order.created',
  ORDER_COMPLETED: 'billing.order.completed',
  ORDER_FAILED: 'billing.order.failed',
  ORDER_REFUNDED: 'billing.order.refunded',
} as const;

export class BillingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly stripe: StripeAdapter,
    private readonly publisher: BillingEventPublisher,
    private readonly urls: CheckoutUrlBuilder,
  ) {}

  // ---------------- Productos (admin) ----------------

  async listProducts(tenantId: string): Promise<BillingProductRow[]> {
    return this.prisma.modBillingProduct.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getProductByCourse(tenantId: string, courseId: string): Promise<BillingProductRow | null> {
    return this.prisma.modBillingProduct.findUnique({
      where: { tenantId_courseId: { tenantId, courseId } },
    });
  }

  async createProduct(input: CreateProductInput): Promise<BillingProductRow> {
    const existing = await this.getProductByCourse(input.tenantId, input.courseId);
    if (existing) {
      throw new ProductAlreadyExistsError(input.courseId);
    }
    // Sincronización con Stripe: si el priceId no existe o está inactivo,
    // fallamos antes de crear el row local. Cacheamos unit_amount y currency
    // para evitar lookup en el catálogo público (apps/web/cursos/[slug]).
    const price = await this.stripe.retrievePrice(input.stripePriceId);
    if (!price.active) {
      throw new StripeApiError(
        `El price ${input.stripePriceId} está inactivo en Stripe. Activa el price o usa otro.`,
      );
    }
    return this.prisma.modBillingProduct.create({
      data: {
        tenantId: input.tenantId,
        courseId: input.courseId,
        stripeProductId: price.productId,
        stripePriceId: price.id,
        unitAmount: price.unitAmount,
        currency: price.currency,
        active: true,
      },
    });
  }

  async updateProduct(input: UpdateProductInput): Promise<BillingProductRow> {
    const product = await this.prisma.modBillingProduct.findFirst({
      where: { id: input.productId, tenantId: input.tenantId },
    });
    if (!product) throw new ProductNotFoundError(input.productId);

    const data: Partial<BillingProductRow> = {};
    if (typeof input.patch.active === 'boolean') {
      data.active = input.patch.active;
    }
    if (input.patch.stripePriceId && input.patch.stripePriceId !== product.stripePriceId) {
      const price = await this.stripe.retrievePrice(input.patch.stripePriceId);
      if (!price.active) {
        throw new StripeApiError(`El price ${input.patch.stripePriceId} está inactivo en Stripe.`);
      }
      data.stripePriceId = price.id;
      data.stripeProductId = price.productId;
      data.unitAmount = price.unitAmount;
      data.currency = price.currency;
    }
    return this.prisma.modBillingProduct.update({
      where: { id: product.id },
      data,
    });
  }

  async deleteProduct(tenantId: string, productId: string): Promise<void> {
    const product = await this.prisma.modBillingProduct.findFirst({
      where: { id: productId, tenantId },
    });
    if (!product) throw new ProductNotFoundError(productId);
    await this.prisma.modBillingProduct.delete({ where: { id: product.id } });
  }

  // ---------------- Checkout (alumno) ----------------

  async startCheckout(input: StartCheckoutInput): Promise<StartCheckoutResult> {
    const product = await this.getProductByCourse(input.tenantId, input.courseId);
    if (!product) throw new ProductNotFoundError(input.courseId);
    if (!product.active) throw new ProductInactiveError(input.courseId);

    // Crear order en estado PENDING ANTES de llamar a Stripe — así el orderId
    // se incluye en metadata de la session y reconciliamos por client_reference_id.
    // Si Stripe falla, la order queda PENDING y se purga con cron (no impacta UX:
    // el alumno nunca ve esta order huérfana).
    const order = await this.prisma.modBillingOrder.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        productId: product.id,
        courseId: input.courseId,
        // Stripe session id provisional — se actualiza tras crear la session.
        // Usamos un placeholder único basado en el id de la order.
        stripeSessionId: `pending_${cryptoRandomId()}`,
        currency: product.currency,
        status: 'PENDING',
      },
    });

    let session;
    try {
      session = await this.stripe.createCheckoutSession({
        priceId: product.stripePriceId,
        successUrl: this.urls.successUrl(input.courseId),
        cancelUrl: this.urls.cancelUrl(input.courseId),
        customerEmail: input.userEmail,
        metadata: {
          tenantId: input.tenantId,
          userId: input.userId,
          courseId: input.courseId,
          productId: product.id,
          orderId: order.id,
        },
      });
    } catch (err) {
      // Stripe falló — marcamos la order como FAILED para auditoría.
      await this.prisma.modBillingOrder.update({
        where: { id: order.id },
        data: { status: 'FAILED' },
      });
      throw err;
    }

    const updated = await this.prisma.modBillingOrder.update({
      where: { id: order.id },
      data: { stripeSessionId: session.id },
    });

    await this.publisher.publish(input.tenantId, input.userId, EVENT.ORDER_CREATED, {
      orderId: updated.id,
      productId: product.id,
      courseId: input.courseId,
      userId: input.userId,
      stripeSessionId: session.id,
      amount: product.unitAmount,
      currency: product.currency,
    });

    return { orderId: updated.id, sessionId: session.id, url: session.url };
  }

  // ---------------- Webhook handler (idempotente) ----------------

  /**
   * Procesa un evento de Stripe ya validado por firma. Garantiza idempotencia:
   * si el evento ya se procesó, devuelve sin tocar nada.
   */
  async handleWebhookEvent(event: Stripe.Event, rawPayload: unknown): Promise<void> {
    // Idempotencia: insertar el row del evento ANTES de hacer trabajo. Si el
    // unique constraint salta, otro worker ya lo procesó.
    try {
      await this.prisma.modBillingWebhookEvent.create({
        data: {
          stripeEventId: event.id,
          type: event.type,
          // payload lo redactamos: guardamos el evento completo (sin tarjeta —
          // Stripe nunca envía PAN; solo last4 si el invoice se expandió).
          payload: rawPayload as never,
        },
      });
    } catch (err) {
      const message = (err as Error).message ?? '';
      if (message.includes('Unique constraint') || message.includes('mod_billing_webhook_event')) {
        return; // ya procesado; idempotente.
      }
      throw err;
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await this.onCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
          break;
        case 'checkout.session.expired':
        case 'checkout.session.async_payment_failed':
          await this.onCheckoutFailed(event.data.object as Stripe.Checkout.Session);
          break;
        case 'charge.refunded':
          await this.onChargeRefunded(event.data.object as Stripe.Charge);
          break;
        default:
          // Eventos no relevantes para mod.billing — los persistimos pero no
          // hacemos nada. Quedan en webhook_event para auditoría.
          break;
      }
      await this.prisma.modBillingWebhookEvent.update({
        where: { stripeEventId: event.id },
        data: { processedAt: new Date() },
      });
    } catch (err) {
      const message = (err as Error).message ?? 'unknown';
      await this.prisma.modBillingWebhookEvent.update({
        where: { stripeEventId: event.id },
        data: { errorMessage: message },
      });
      throw err;
    }
  }

  private async onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const metadata = session.metadata ?? {};
    const orderId = metadata.orderId ?? session.client_reference_id;
    const tenantId = metadata.tenantId;
    const userId = metadata.userId;
    const courseId = metadata.courseId;

    if (!orderId || !tenantId || !userId || !courseId) {
      throw new StripeApiError(
        `checkout.session.completed sin metadata mínimo (orderId/tenantId/userId/courseId): ${session.id}`,
      );
    }

    const order = await this.prisma.modBillingOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new OrderNotFoundError(orderId);

    // Idempotencia adicional: si la order ya está COMPLETED (por reentrega),
    // no re-emitimos evento ni re-actualizamos.
    if (order.status === 'COMPLETED') return;

    const updated = await this.prisma.modBillingOrder.update({
      where: { id: order.id },
      data: {
        status: 'COMPLETED',
        amountPaid: session.amount_total ?? null,
        customerEmail: session.customer_details?.email ?? session.customer_email ?? null,
        completedAt: new Date(),
      },
    });

    await this.publisher.publish(tenantId, userId, EVENT.ORDER_COMPLETED, {
      orderId: updated.id,
      productId: order.productId,
      courseId,
      userId,
      amountPaid: updated.amountPaid,
      currency: updated.currency,
      customerEmail: updated.customerEmail,
    });
  }

  private async onCheckoutFailed(session: Stripe.Checkout.Session): Promise<void> {
    const orderId = session.metadata?.orderId ?? session.client_reference_id;
    if (!orderId) return;
    const order = await this.prisma.modBillingOrder.findUnique({ where: { id: orderId } });
    if (!order) return;
    if (order.status !== 'PENDING') return;

    const next = session.status === 'expired' ? 'CANCELLED' : 'FAILED';
    await this.prisma.modBillingOrder.update({
      where: { id: order.id },
      data: { status: next },
    });

    if (next === 'FAILED') {
      await this.publisher.publish(order.tenantId, order.userId, EVENT.ORDER_FAILED, {
        orderId: order.id,
        productId: order.productId,
        courseId: order.courseId,
        userId: order.userId,
      });
    }
  }

  private async onChargeRefunded(charge: Stripe.Charge): Promise<void> {
    // El charge.refunded llega tras un refund manual desde el dashboard.
    // Buscamos la order por payment_intent en su metadata.
    const orderId =
      typeof charge.payment_intent === 'string'
        ? // No tenemos lookup directo session→charge sin expand; en MVP buscamos
          // por metadata si está presente, si no, ignoramos (auditoría queda
          // en webhook_event).
          charge.metadata?.orderId
        : null;
    if (!orderId) return;
    const order = await this.prisma.modBillingOrder.findUnique({ where: { id: orderId } });
    if (!order) return;
    if (order.status === 'REFUNDED') return;

    await this.prisma.modBillingOrder.update({
      where: { id: order.id },
      data: { status: 'REFUNDED', refundedAt: new Date() },
    });

    await this.publisher.publish(order.tenantId, order.userId, EVENT.ORDER_REFUNDED, {
      orderId: order.id,
      productId: order.productId,
      courseId: order.courseId,
      userId: order.userId,
    });
  }
}

// ---------------- helpers ----------------

function cryptoRandomId(): string {
  // Crypto.randomUUID() existe en Node 22 y es suficiente para placeholders.
  // Importamos perezoso para no romper en entornos sin globalThis.crypto.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
  return randomUUID();
}
