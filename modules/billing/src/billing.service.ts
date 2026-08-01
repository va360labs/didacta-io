/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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
  /** Price ya existente en Stripe. Excluyente con `unitAmount`. */
  stripePriceId?: string;
  /**
   * Importe en céntimos: si llega (en vez de `stripePriceId`), el módulo crea
   * el Product y el Price en Stripe por ti. Evita el paso manual de crearlos en
   * el dashboard y pegar el `price_...`.
   */
  unitAmount?: number;
  currency?: string;
  /** Nombre visible en la pantalla de pago de Stripe (título del curso). */
  name?: string;
  /** Precio anterior (tachado) para la ficha de venta. Debe ser mayor que el real. */
  compareAtAmount?: number;
  /** Nombre de la opción de compra ("Curso Intermedio"). "" = precio único. */
  optionName?: string;
  sortOrder?: number;
  isFeatured?: boolean;
  externalRef?: string;
}

export interface UpdateProductInput {
  tenantId: string;
  productId: string;
  patch: { active?: boolean; stripePriceId?: string };
}

export interface StartCheckoutInput {
  tenantId: string;
  /**
   * Comprador autenticado, o null/ausente en el checkout PÚBLICO (viaje 2):
   * el visitante aún no tiene cuenta — se materializa en el fulfillment del
   * webhook con el email confirmado en Stripe (patrón de la membresía).
   */
  userId?: string | null;
  /** Email para precargar el checkout de Stripe. Anónimo sin email → lo recoge Stripe. */
  userEmail?: string;
  courseId: string;
  /**
   * Opción de compra elegida. Si no llega se usa la destacada (o la primera),
   * así los cursos con precio único siguen funcionando sin cambios.
   */
  optionId?: string;
  /**
   * URLs de retorno de Stripe resueltas POR PETICIÓN (a partir del Host real).
   * Opcionales por compatibilidad: si no llegan, se cae al `CheckoutUrlBuilder`
   * del constructor. El caller HTTP debe pasarlas siempre — el builder del
   * constructor se congela en el arranque con variables de entorno que en
   * producción no existen, y genera una URL que la web no sabe resolver.
   */
  successUrl?: string;
  cancelUrl?: string;
}

/** Una opción de compra del curso, tal y como la ve el alumno. */
export interface CourseOfferOption {
  id: string;
  /** "" cuando el curso tiene precio único. */
  name: string;
  perks: string[];
  unitAmount: number;
  compareAtAmount: number | null;
  currency: string;
  discountPercent: number | null;
  isFeatured: boolean;
}

export interface CourseOffer {
  forSale: boolean;
  options: CourseOfferOption[];
}

export interface StartCheckoutResult {
  orderId: string;
  sessionId: string;
  url: string;
}

/**
 * Callback del HOST para materializar al comprador anónimo como usuario de la
 * plataforma (el módulo no puede escribir la tabla `user` — contrato modular).
 * Devuelve el userId (creado o existente). Mismo patrón que el `UserProvisioner`
 * de mod.subscriptions (membresía).
 */
export type BillingUserProvisioner = (args: {
  tenantId: string;
  email: string;
  name: string | null;
}) => Promise<{ userId: string; created: boolean }>;

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

  /**
   * Opciones de compra ACTIVAS de un curso, en orden de presentación. Un curso
   * puede venderse en varios formatos ("Curso", "Curso Intermedio", "Curso
   * Avanzado"), igual que la membresía tiene varios planes.
   */
  async listCourseOptions(tenantId: string, courseId: string): Promise<BillingProductRow[]> {
    return this.prisma.modBillingProduct.findMany({
      where: { tenantId, courseId, active: true },
      orderBy: [{ sortOrder: 'asc' }, { unitAmount: 'asc' }],
    });
  }

  /**
   * Opción concreta por id, validando que sea del tenant y del curso indicado.
   * Sin esta comprobación, un id de otra organización o de otro curso serviría
   * para pagar un precio que no toca.
   */
  async getCourseOption(
    tenantId: string,
    courseId: string,
    optionId: string,
  ): Promise<BillingProductRow | null> {
    return this.prisma.modBillingProduct.findFirst({
      where: { id: optionId, tenantId, courseId },
    });
  }

  /** Opción por defecto: la destacada, si no la primera del orden. */
  async getProductByCourse(tenantId: string, courseId: string): Promise<BillingProductRow | null> {
    const opciones = await this.listCourseOptions(tenantId, courseId);
    if (opciones.length === 0) return null;
    return opciones.find((o) => o.isFeatured) ?? opciones[0]!;
  }

  /**
   * Oferta del curso tal y como debe verla un ALUMNO: lo justo para pintar la
   * caja de precio y decidir si se muestra el botón de compra. No expone nada
   * interno de Stripe.
   *
   * Existe porque el precio solo estaba disponible en el endpoint de admin, así
   * que la ficha no podía mostrarlo sin inventárselo — y el botón se pintaba
   * siempre, fallando al hacer clic en los cursos que no están a la venta.
   */
  async getCourseOffer(tenantId: string, courseId: string): Promise<CourseOffer> {
    const opciones = await this.listCourseOptions(tenantId, courseId);
    if (opciones.length === 0) {
      return { forSale: false, options: [] };
    }
    return { forSale: true, options: opciones.map((o) => toOfferOption(o)) };
  }

  /**
   * Catálogo de venta del tenant: todas las opciones ACTIVAS agrupadas por
   * curso, en el mismo formato de oferta que ve el alumno. Es la base del
   * catálogo PÚBLICO (viaje 2): el host cruza estos courseIds con los cursos
   * PUBLISHED — este módulo no lee tablas de mod.courses.
   */
  async getCatalog(
    tenantId: string,
  ): Promise<Array<{ courseId: string; options: CourseOfferOption[] }>> {
    const productos = await this.prisma.modBillingProduct.findMany({
      where: { tenantId, active: true },
      orderBy: [{ sortOrder: 'asc' }, { unitAmount: 'asc' }],
    });
    const porCurso = new Map<string, CourseOfferOption[]>();
    for (const p of productos) {
      const lista = porCurso.get(p.courseId) ?? [];
      lista.push(toOfferOption(p));
      porCurso.set(p.courseId, lista);
    }
    return [...porCurso.entries()].map(([courseId, options]) => ({ courseId, options }));
  }

  async createProduct(input: CreateProductInput): Promise<BillingProductRow> {
    const optionName = input.optionName ?? '';
    const existing = await this.prisma.modBillingProduct.findFirst({
      where: { tenantId: input.tenantId, courseId: input.courseId, name: optionName },
    });
    if (existing) {
      throw new ProductAlreadyExistsError(input.courseId);
    }
    // Dos vías: (a) el admin pega un price_ ya creado en Stripe, o (b) escribe
    // un importe y lo creamos nosotros. Cacheamos unit_amount y currency para
    // evitar lookup en el catálogo público (apps/web/cursos/[slug]).
    let price;
    if (input.stripePriceId) {
      // Si el priceId no existe o está inactivo, fallamos antes de crear el row.
      price = await this.stripe.retrievePrice(input.stripePriceId);
      if (!price.active) {
        throw new StripeApiError(
          `El price ${input.stripePriceId} está inactivo en Stripe. Activa el price o usa otro.`,
        );
      }
    } else {
      if (input.unitAmount === undefined || input.unitAmount <= 0) {
        throw new StripeApiError('Indica un importe mayor que cero o un stripePriceId existente.');
      }
      price = await this.stripe.createOneOffPrice({
        name: input.name?.trim() || 'Curso',
        unitAmount: input.unitAmount,
        currency: (input.currency ?? 'eur').toLowerCase(),
        metadata: {
          tenantId: input.tenantId,
          courseId: input.courseId,
          didacta: 'course',
        },
      });
    }
    return this.prisma.modBillingProduct.create({
      data: {
        tenantId: input.tenantId,
        courseId: input.courseId,
        stripeProductId: price.productId,
        stripePriceId: price.id,
        unitAmount: price.unitAmount,
        currency: price.currency,
        // Solo tiene sentido si es MAYOR que el precio real: un "antes" más
        // barato que el "ahora" sería publicidad engañosa.
        compareAtAmount:
          input.compareAtAmount && input.compareAtAmount > price.unitAmount
            ? input.compareAtAmount
            : null,
        name: optionName,
        sortOrder: input.sortOrder ?? 0,
        isFeatured: input.isFeatured ?? false,
        externalRef: input.externalRef ?? null,
        active: true,
      },
    });
  }

  /**
   * Deja el curso a la venta al precio indicado, cree o actualice. Pensado para
   * sincronizar precios desde una fuente externa (p. ej. la tienda WooCommerce)
   * de forma repetible: llamarlo dos veces con el mismo importe no toca nada.
   *
   * Cuando el importe cambia se crea un Price NUEVO en Stripe sobre el mismo
   * Product (Stripe no permite editar un Price ya creado) y se apunta el
   * producto local al nuevo. Los pagos ya cobrados no se ven afectados.
   */
  async upsertCoursePrice(input: {
    tenantId: string;
    courseId: string;
    unitAmount: number;
    currency?: string;
    compareAtAmount?: number | null;
    /** Titulo del curso: es lo que ve el comprador en la pantalla de pago. */
    name?: string;
    /** Nombre de la OPCION ("Curso Intermedio"). "" = precio unico. */
    optionName?: string;
    sortOrder?: number;
    isFeatured?: boolean;
    externalRef?: string | null;
  }): Promise<{ product: BillingProductRow; accion: 'creado' | 'actualizado' | 'sin-cambios' }> {
    const currency = (input.currency ?? 'eur').toLowerCase();
    const optionName = input.optionName ?? '';
    // Se busca primero por referencia externa (sobrevive a que renombren la
    // variante en la tienda) y, si no, por nombre de opcion.
    const existente =
      (input.externalRef
        ? await this.prisma.modBillingProduct.findFirst({
            where: {
              tenantId: input.tenantId,
              courseId: input.courseId,
              externalRef: input.externalRef,
            },
          })
        : null) ??
      (await this.prisma.modBillingProduct.findFirst({
        where: { tenantId: input.tenantId, courseId: input.courseId, name: optionName },
      }));

    if (!existente) {
      const product = await this.createProduct({
        tenantId: input.tenantId,
        courseId: input.courseId,
        unitAmount: input.unitAmount,
        currency,
        name: input.name,
        compareAtAmount: input.compareAtAmount ?? undefined,
        optionName,
        sortOrder: input.sortOrder,
        isFeatured: input.isFeatured,
        externalRef: input.externalRef ?? undefined,
      });
      return { product, accion: 'creado' };
    }

    const compareAt =
      input.compareAtAmount && input.compareAtAmount > input.unitAmount
        ? input.compareAtAmount
        : null;
    const mismoImporte =
      existente.unitAmount === input.unitAmount && existente.currency === currency;
    const mismaPresentacion =
      existente.name === optionName &&
      existente.sortOrder === (input.sortOrder ?? existente.sortOrder) &&
      existente.isFeatured === (input.isFeatured ?? existente.isFeatured);
    if (
      mismoImporte &&
      existente.compareAtAmount === compareAt &&
      existente.active &&
      mismaPresentacion
    ) {
      return { product: existente, accion: 'sin-cambios' };
    }

    // Solo vamos a Stripe si de verdad cambió el importe: un cambio de precio
    // tachado es un dato nuestro y no necesita tocar la pasarela.
    let stripePriceId = existente.stripePriceId;
    let stripeProductId = existente.stripeProductId;
    if (!mismoImporte) {
      const price = await this.stripe.createOneOffPrice({
        name: input.name?.trim() || 'Curso',
        productId: existente.stripeProductId,
        unitAmount: input.unitAmount,
        currency,
        metadata: {
          tenantId: input.tenantId,
          courseId: input.courseId,
          didacta: 'course',
        },
      });
      stripePriceId = price.id;
      stripeProductId = price.productId;
    }

    const product = await this.prisma.modBillingProduct.update({
      where: { id: existente.id },
      data: {
        stripePriceId,
        stripeProductId,
        unitAmount: input.unitAmount,
        currency,
        compareAtAmount: compareAt,
        name: optionName,
        sortOrder: input.sortOrder ?? existente.sortOrder,
        isFeatured: input.isFeatured ?? existente.isFeatured,
        externalRef: input.externalRef ?? existente.externalRef,
        active: true,
      },
    });
    return { product, accion: 'actualizado' };
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
    // La opción se resuelve SIEMPRE contra (tenant, curso): un id de opción de
    // otro curso u organización no puede colarse para pagar otro precio.
    const product = input.optionId
      ? await this.getCourseOption(input.tenantId, input.courseId, input.optionId)
      : await this.getProductByCourse(input.tenantId, input.courseId);
    if (!product) {
      // `getProductByCourse` solo mira las opciones ACTIVAS. Si el curso tiene
      // alguna desactivada, el error correcto es "no disponible" y no "no
      // existe": al alumno le decimos algo distinto en cada caso.
      const desactivada = await this.prisma.modBillingProduct.findFirst({
        where: { tenantId: input.tenantId, courseId: input.courseId },
      });
      if (desactivada) throw new ProductInactiveError(input.courseId);
      throw new ProductNotFoundError(input.courseId);
    }
    if (!product.active) throw new ProductInactiveError(input.courseId);

    // Crear order en estado PENDING ANTES de llamar a Stripe — así el orderId
    // se incluye en metadata de la session y reconciliamos por client_reference_id.
    // Si Stripe falla, la order queda PENDING y se purga con cron (no impacta UX:
    // el alumno nunca ve esta order huérfana).
    const order = await this.prisma.modBillingOrder.create({
      data: {
        tenantId: input.tenantId,
        // Checkout público: aún no hay comprador — el webhook lo materializa
        // por el email confirmado en Stripe y rellena el user_id entonces.
        userId: input.userId ?? null,
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
        successUrl: input.successUrl ?? this.urls.successUrl(input.courseId),
        cancelUrl: input.cancelUrl ?? this.urls.cancelUrl(input.courseId),
        customerEmail: input.userEmail || undefined,
        metadata: {
          tenantId: input.tenantId,
          courseId: input.courseId,
          productId: product.id,
          orderId: order.id,
          // Sin userId en el checkout anónimo: la fila de la order (no la
          // metadata) es la fuente de verdad del comprador en el fulfillment.
          ...(input.userId ? { userId: input.userId } : {}),
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

    await this.publisher.publish(input.tenantId, input.userId ?? null, EVENT.ORDER_CREATED, {
      orderId: updated.id,
      productId: product.id,
      courseId: input.courseId,
      userId: input.userId ?? null,
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
   *
   * `opts.provisionUser` lo inyecta el HOST para materializar al comprador del
   * checkout PÚBLICO (order con user_id null). Sin él, un fulfillment anónimo
   * falla y Stripe reintenta — nunca se completa un pago sin dueño.
   */
  async handleWebhookEvent(
    event: Stripe.Event,
    rawPayload: unknown,
    opts?: { provisionUser?: BillingUserProvisioner },
  ): Promise<void> {
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
        // El evento ya se RECIBIÓ antes. Eso no significa que se procesara con
        // éxito: si el intento anterior falló a mitad, la fila quedó con
        // `processedAt` a null y un `errorMessage`. Dedupear por recibido
        // "quemaba" el evento — ni un reintento de Stripe ni un reenvío manual
        // volvían a intentarlo, y un pago podía quedarse sin matrícula para
        // siempre. Dedupeamos por PROCESADO: solo salimos si ya se completó.
        const previo = await this.prisma.modBillingWebhookEvent.findUnique({
          where: { stripeEventId: event.id },
          select: { processedAt: true },
        });
        if (previo?.processedAt) return; // ya procesado con éxito; idempotente.
        // Si no, seguimos y reintentamos el trabajo de dominio (que es
        // idempotente por su cuenta: la order no retrocede de COMPLETED).
      } else {
        throw err;
      }
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await this.onCheckoutCompleted(
            event.data.object as Stripe.Checkout.Session,
            opts?.provisionUser,
          );
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

  private async onCheckoutCompleted(
    session: Stripe.Checkout.Session,
    provisionUser?: BillingUserProvisioner,
  ): Promise<void> {
    const metadata = session.metadata ?? {};
    const orderId = metadata.orderId ?? session.client_reference_id;
    const tenantId = metadata.tenantId;
    const courseId = metadata.courseId;

    // Pertenencia POSITIVA: una sola cuenta de Stripe alimenta a varios módulos
    // desde el mismo endpoint, así que solo tratamos lo que lleva NUESTRA marca
    // (`orderId` + `productId`, que solo escribe `startCheckout`). Definir lo
    // propio por ausencia dejaba pasar otros checkouts con `courseId` — p.ej. el
    // de suscripción por curso de mod.subscriptions. Lo ajeno se ignora en
    // silencio: lanzar daría un 5xx y Stripe reintentaría durante días algo que
    // nunca fue nuestro. Queda archivado para auditoría.
    if (!metadata.orderId || !metadata.productId) return;

    if (!orderId || !tenantId || !courseId) {
      throw new StripeApiError(
        `checkout.session.completed sin metadata mínimo (orderId/tenantId/courseId): ${session.id}`,
      );
    }

    const order = await this.prisma.modBillingOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new OrderNotFoundError(orderId);

    // Idempotencia adicional: si la order ya está COMPLETED (por reentrega),
    // no re-emitimos evento ni re-actualizamos.
    if (order.status === 'COMPLETED') return;

    // Comprador: la FILA de la order es la fuente de verdad (checkout logueado
    // la trae rellena). En el checkout público llega null: se materializa aquí
    // con el email CONFIRMADO en Stripe — no el que tecleó al iniciar. Si algo
    // falta, lanzamos: el evento queda con errorMessage y Stripe reintenta —
    // jamás se completa un cobro sin dueño.
    let userId = order.userId;
    let userCreated = false;
    if (!userId) {
      const email = session.customer_details?.email ?? session.customer_email ?? null;
      if (!email) {
        throw new StripeApiError(
          `checkout público sin email del comprador en la session ${session.id} — no se puede materializar la cuenta`,
        );
      }
      if (!provisionUser) {
        throw new StripeApiError(
          `checkout público (order ${order.id}) sin provisioner del host — el fulfillment se reintentará`,
        );
      }
      const provisioned = await provisionUser({
        tenantId,
        email: email.trim().toLowerCase(),
        name: session.customer_details?.name ?? null,
      });
      userId = provisioned.userId;
      userCreated = provisioned.created;
    }

    const updated = await this.prisma.modBillingOrder.update({
      where: { id: order.id },
      data: {
        status: 'COMPLETED',
        userId,
        amountPaid: session.amount_total ?? null,
        customerEmail: session.customer_details?.email ?? session.customer_email ?? null,
        // Guardamos el PaymentIntent aquí porque es el único identificador que
        // comparten el cobro y un futuro `charge.refunded` (el Charge NO lleva
        // la metadata de la sesión). Sin esto, un reembolso es irreconocible.
        stripePaymentIntentId:
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : (session.payment_intent?.id ?? null),
        completedAt: new Date(),
      },
    });

    await this.publisher.publish(tenantId, userId, EVENT.ORDER_COMPLETED, {
      orderId: updated.id,
      productId: order.productId,
      courseId,
      userId,
      userCreated,
      amountPaid: updated.amountPaid,
      currency: updated.currency,
      customerEmail: updated.customerEmail,
    });
  }

  private async onCheckoutFailed(session: Stripe.Checkout.Session): Promise<void> {
    // Misma pertenencia positiva que en onCheckoutCompleted: en un endpoint
    // compartido, `client_reference_id` puede ser el id de OTRO módulo.
    const orderId = session.metadata?.orderId;
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

  /**
   * Reembolso hecho desde el dashboard de Stripe.
   *
   * La orden se reconoce por el PaymentIntent que guardamos al completar el
   * cobro: el Charge NO arrastra la metadata que pusimos en la sesión, así que
   * buscar ahí (lo que se hacía antes) no encontraba nunca la orden y el
   * reembolso pasaba desapercibido.
   *
   * Solo un reembolso TOTAL retira el acceso. Uno parcial (un descuento a
   * posteriori, una devolución de gastos) deja la compra en pie: marcarla como
   * reembolsada expulsaría del curso a alguien que sigue habiendo pagado.
   */
  private async onChargeRefunded(charge: Stripe.Charge): Promise<void> {
    const paymentIntentId =
      typeof charge.payment_intent === 'string'
        ? charge.payment_intent
        : (charge.payment_intent?.id ?? null);
    if (!paymentIntentId) return;

    const order = await this.prisma.modBillingOrder.findFirst({
      where: { stripePaymentIntentId: paymentIntentId },
    });
    if (!order) return; // cobro de otro módulo (p.ej. membresía) o ajeno.
    if (order.status === 'REFUNDED') return;

    const total = charge.amount ?? 0;
    const devuelto = charge.amount_refunded ?? 0;
    const esTotal = devuelto > 0 && devuelto >= total;
    if (!esTotal) return; // parcial: no tocamos el acceso.

    await this.prisma.modBillingOrder.update({
      where: { id: order.id },
      data: { status: 'REFUNDED', refundedAt: new Date() },
    });

    await this.publisher.publish(order.tenantId, order.userId, EVENT.ORDER_REFUNDED, {
      orderId: order.id,
      productId: order.productId,
      courseId: order.courseId,
      userId: order.userId,
      amountRefunded: devuelto,
    });
  }
}

// ---------------- helpers ----------------

/** Proyección de una fila de producto a la opción de compra que ve el alumno. */
function toOfferOption(o: BillingProductRow): CourseOfferOption {
  return {
    id: o.id,
    name: o.name,
    perks: o.perks,
    unitAmount: o.unitAmount,
    compareAtAmount: o.compareAtAmount ?? null,
    currency: o.currency,
    // El porcentaje se DERIVA; no se guarda, para que no pueda contradecir
    // a los importes.
    discountPercent:
      o.compareAtAmount && o.compareAtAmount > o.unitAmount
        ? Math.round(((o.compareAtAmount - o.unitAmount) / o.compareAtAmount) * 100)
        : null,
    isFeatured: o.isFeatured,
  };
}

function cryptoRandomId(): string {
  // Crypto.randomUUID() existe en Node 22 y es suficiente para placeholders.
  // Importamos perezoso para no romper en entornos sin globalThis.crypto.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
  return randomUUID();
}
