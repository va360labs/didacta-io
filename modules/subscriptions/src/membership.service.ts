/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * MembershipService — venta de MEMBRESÍA por suscripción (página pública /unete).
 *
 * A diferencia de SubscriptionsService (suscripción POR CURSO de un usuario ya
 * logueado), la membresía:
 *   - se vende a visitantes ANÓNIMOS (Stripe recoge el email en el checkout);
 *   - concede un GRUPO de acceso (mod.access-groups) en vez de un curso;
 *   - sus planes (precio, periodicidad, trial, tachado) los parametriza el
 *     admin en la BD — el Product/Price de Stripe se crea perezosamente en el
 *     primer checkout y se ROTA al cambiar el importe (prices inmutables).
 *
 * División de responsabilidades con el host (apps/api):
 *   - Este service NO toca la tabla `user` (contrato de módulos: solo lectura
 *     cross-module, nunca escritura). El alta/lookup del comprador la hace el
 *     host vía el callback `UserProvisioner` que se le inyecta al procesar el
 *     webhook `checkout.session.completed`.
 *   - El entitlement (grupo) lo hace el host escuchando los eventos
 *     `subscriptions.membership.activated` / `.revoked`.
 *
 * El resto del ciclo de vida (invoice.paid, payment_failed, grace, cancel) lo
 * sigue gestionando SubscriptionsService: las filas de membresía viven en la
 * MISMA tabla `mod_subscriptions_subscription` (courseId NULL + planId).
 */

import type { PrismaClient } from '@didacta/database';
import type Stripe from 'stripe';
import {
  MembershipAlreadySubscribedError,
  MembershipConfigIncompleteError,
  MembershipNotTrialingError,
  MembershipPageInactiveError,
  MembershipPlanIntervalInvalidError,
  MembershipPlanNotFoundError,
} from './errors.js';
import type { SubscriptionsStripeAdapter } from './stripe-subscriptions.client.js';
import type {
  SubscriptionsEventPublisher,
  SubscriptionsStripeAdapterResolver,
} from './subscriptions.service.js';

type PlanRow = Awaited<ReturnType<PrismaClient['modSubscriptionsPlan']['create']>>;
type ConfigRow = Awaited<ReturnType<PrismaClient['modSubscriptionsMembershipConfig']['upsert']>>;

export const MEMBERSHIP_EVENT = {
  /** Checkout pagado y suscripción local creada/vinculada al user. */
  ACTIVATED: 'subscriptions.membership.activated',
  /** La membresía deja de dar acceso (cancelación efectiva o impago agotado). */
  REVOKED: 'subscriptions.membership.revoked',
} as const;

/**
 * Meses máximos por periodo de facturación. Es el tope de Stripe (interval ×
 * interval_count no puede superar un año), no una decisión de producto: vale
 * cualquier entero 1..12 (mensual, bimestral, trimestral, semestral, anual…).
 */
export const PLAN_INTERVAL_MAX_MONTHS = 12;

/** Moneda de un plan si el admin no indica otra (ISO 4217, minúsculas). */
export const PLAN_DEFAULT_CURRENCY = 'eur';

/**
 * Estados en los que una membresía **ya existe para su dueño** y no procede
 * venderle otra. Una sola definición porque la usan dos sitios que tienen que
 * responder lo mismo: el guard del checkout y `/integrations/learners/state`,
 * que es donde una tienda externa pregunta antes de vender.
 *
 * `PENDING` queda FUERA a propósito, y no es un descuido: es el estado de un
 * checkout terminado cuyo cobro Stripe aún no ha resuelto (pago diferido) y
 * también el de una suscripción que nació `incomplete` y no llegó a ninguna
 * parte. Esa persona **no tiene acceso a nada**; bloquearle la compra la dejaría
 * sin poder contratar por culpa de un intento fallido suyo.
 *
 * `PAST_DUE` sí entra: está en periodo de gracia, conserva el acceso y lo que
 * necesita es arreglar su método de pago, no una segunda suscripción que le
 * cobraría dos veces por lo mismo.
 */
export const MEMBERSHIP_LIVE_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE'] as const;

/** El DTO del host también valida, pero el módulo no depende de su llamador. */
function assertPlanInterval(intervalMonths: number): void {
  if (
    !Number.isInteger(intervalMonths) ||
    intervalMonths < 1 ||
    intervalMonths > PLAN_INTERVAL_MAX_MONTHS
  ) {
    throw new MembershipPlanIntervalInvalidError(intervalMonths);
  }
}

export interface PlanInput {
  name: string;
  intervalMonths: number;
  amountCents: number;
  currency?: string;
  compareAtCents?: number | null;
  trialDays?: number;
  active?: boolean;
  isFeatured?: boolean;
  sortOrder?: number;
}

export interface MembershipConfigInput {
  active?: boolean;
  headline?: string;
  subheadline?: string | null;
  accessGroupId?: string | null;
  showCourses?: boolean;
  /** Lecciones visibles por curso durante el trial (0 = sin límite). */
  trialLessonLimit?: number;
  coursePrices?: Array<{ courseId: string; amountCents: number }>;
  testimonialQuote?: string | null;
  testimonialAuthor?: string | null;
  testimonialRole?: string | null;
}

/** Curso publicado tal y como lo pinta la página pública. */
export interface MembershipCourseView {
  id: string;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  estimatedMinutes: number | null;
  /** Categoría/tema del curso (para los chips de filtrado), o null. */
  category: string | null;
  /** Nº de módulos (secciones) del curso. */
  moduleCount: number;
  /** Títulos de los primeros módulos (chips del detalle expandible). */
  moduleTitles: string[];
  /** Nombre del creador del curso ("Impartido por"), o null. */
  teacherName: string | null;
  /** Precio individual de referencia (céntimos) configurado por el admin, o null. */
  amountCents: number | null;
}

/** Datos agregados REALES del tenant para los tiles de la página de venta. */
export interface MembershipPublicStats {
  /** Usuarios ACTIVE del tenant (alumnos con acceso). */
  activeMembers: number;
  /** Suma de estimatedMinutes de los cursos publicados (0 si ninguno lo define). */
  totalMinutes: number;
}

export interface MembershipPublicPage {
  headline: string;
  subheadline: string | null;
  plans: Array<{
    id: string;
    name: string;
    intervalMonths: number;
    amountCents: number;
    currency: string;
    compareAtCents: number | null;
    trialDays: number;
    isFeatured: boolean;
  }>;
  courses: MembershipCourseView[];
  /** Suma de los precios individuales configurados (céntimos), o null si no hay. */
  standaloneTotalCents: number | null;
  stats: MembershipPublicStats;
  testimonial: { quote: string; author: string; role: string | null } | null;
  /** Lecciones visibles por curso durante la prueba (0 = acceso completo). */
  trialLessonLimit: number;
}

/**
 * Callback del HOST para materializar el comprador como usuario de la
 * plataforma. Devuelve el userId (creado o existente). El módulo no puede
 * escribir la tabla `user` (contrato de módulos).
 */
export type UserProvisioner = (args: {
  tenantId: string;
  email: string;
  name: string | null;
  /**
   * Idioma con el que el comprador estaba navegando al pagar, capturado en
   * `startMembershipCheckout` y transportado en la metadata de la sesión (es lo
   * único que sobrevive al salto a Stripe). Opaco para este módulo: lo valida y
   * lo persiste el host, y SOLO si crea la fila.
   */
  locale?: string;
}) => Promise<{ userId: string; created: boolean }>;

export class MembershipService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly stripeFor: SubscriptionsStripeAdapterResolver,
    private readonly publisher: SubscriptionsEventPublisher,
  ) {}

  // ---------------- Planes (admin) ----------------

  async listPlans(tenantId: string): Promise<PlanRow[]> {
    return this.prisma.modSubscriptionsPlan.findMany({
      where: { tenantId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createPlan(tenantId: string, input: PlanInput): Promise<PlanRow> {
    assertPlanInterval(input.intervalMonths);
    return this.prisma.modSubscriptionsPlan.create({
      data: {
        tenantId,
        name: input.name,
        intervalMonths: input.intervalMonths,
        amountCents: input.amountCents,
        currency: input.currency ?? PLAN_DEFAULT_CURRENCY,
        compareAtCents: input.compareAtCents ?? null,
        trialDays: input.trialDays ?? 0,
        active: input.active ?? true,
        isFeatured: input.isFeatured ?? false,
        sortOrder: input.sortOrder ?? 0,
      },
    });
  }

  async updatePlan(tenantId: string, planId: string, input: Partial<PlanInput>): Promise<PlanRow> {
    if (input.intervalMonths !== undefined) assertPlanInterval(input.intervalMonths);
    const plan = await this.prisma.modSubscriptionsPlan.findFirst({
      where: { id: planId, tenantId },
    });
    if (!plan) throw new MembershipPlanNotFoundError(planId);

    // Si cambia el importe, la moneda o la periodicidad, el price de Stripe
    // deja de valer (inmutable) → se limpia y se re-crea en el próximo checkout.
    const priceChanged =
      (input.amountCents !== undefined && input.amountCents !== plan.amountCents) ||
      (input.currency !== undefined && input.currency !== plan.currency) ||
      (input.intervalMonths !== undefined && input.intervalMonths !== plan.intervalMonths);
    const nameChanged = input.name !== undefined && input.name !== plan.name;

    const updated = await this.prisma.modSubscriptionsPlan.update({
      where: { id: plan.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.intervalMonths !== undefined ? { intervalMonths: input.intervalMonths } : {}),
        ...(input.amountCents !== undefined ? { amountCents: input.amountCents } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.compareAtCents !== undefined ? { compareAtCents: input.compareAtCents } : {}),
        ...(input.trialDays !== undefined ? { trialDays: input.trialDays } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.isFeatured !== undefined ? { isFeatured: input.isFeatured } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(priceChanged ? { stripePriceId: null } : {}),
      },
    });

    // Renombrar el plan renombra su Product en Stripe (es el nombre que ve el
    // comprador en el checkout). Best-effort: si Stripe falla o no hay clave, el
    // nombre se resincroniza en el próximo checkout que recree el price/product.
    if (nameChanged && updated.stripeProductId) {
      try {
        const stripe = await this.stripeFor(tenantId);
        await stripe.updateProduct(updated.stripeProductId, updated.name);
      } catch {
        /* no bloquea la edición del plan */
      }
    }

    return updated;
  }

  async deletePlan(tenantId: string, planId: string): Promise<void> {
    const plan = await this.prisma.modSubscriptionsPlan.findFirst({
      where: { id: planId, tenantId },
    });
    if (!plan) throw new MembershipPlanNotFoundError(planId);
    // Si el plan ya vendió suscripciones, NO se borra (historial): se desactiva.
    const sold = await this.prisma.modSubscriptionsSubscription.count({
      where: { tenantId, planId },
    });
    if (sold > 0) {
      await this.prisma.modSubscriptionsPlan.update({
        where: { id: plan.id },
        data: { active: false },
      });
      return;
    }
    await this.prisma.modSubscriptionsPlan.delete({ where: { id: plan.id } });
  }

  // ---------------- Configuración de la página (admin) ----------------

  async getConfig(tenantId: string): Promise<ConfigRow> {
    return this.prisma.modSubscriptionsMembershipConfig.upsert({
      where: { tenantId },
      create: { tenantId },
      update: {},
    });
  }

  async updateConfig(tenantId: string, input: MembershipConfigInput): Promise<ConfigRow> {
    return this.prisma.modSubscriptionsMembershipConfig.upsert({
      where: { tenantId },
      create: { tenantId, ...configData(input) },
      update: configData(input),
    });
  }

  // ---------------- Página pública ----------------

  /**
   * Datos que pinta /unete. Lanza MembershipPageInactiveError si la página no
   * está activada por el admin. Lee cursos PUBLISHED de mod.courses (lectura
   * cross-module permitida en core first-party, filtrada por tenant y
   * declarada en el manifest).
   */
  async getPublicPage(tenantId: string): Promise<MembershipPublicPage> {
    const config = await this.getConfig(tenantId);
    if (!config.active) throw new MembershipPageInactiveError();

    const plans = await this.prisma.modSubscriptionsPlan.findMany({
      where: { tenantId, active: true },
      orderBy: [{ sortOrder: 'asc' }, { amountCents: 'asc' }],
    });

    const priceByCourse = new Map(
      parseCoursePrices(config.coursePrices).map((p) => [p.courseId, p.amountCents]),
    );

    let courses: MembershipCourseView[] = [];
    if (config.showCourses) {
      const rows = await this.prisma.modCoursesCourse.findMany({
        where: { tenantId, status: 'PUBLISHED', deletedAt: null },
        orderBy: { publishedAt: 'desc' },
        select: {
          id: true,
          title: true,
          description: true,
          thumbnailUrl: true,
          estimatedMinutes: true,
          category: true,
          createdById: true,
          modules: {
            where: { deletedAt: null },
            orderBy: { position: 'asc' },
            select: { title: true },
          },
        },
      });
      // "Impartido por": nombre real del creador del curso (lectura del core
      // `user` filtrada por tenant; null si no se puede resolver).
      const creatorIds = [
        ...new Set(rows.map((c) => c.createdById).filter((x): x is string => !!x)),
      ];
      const creators = creatorIds.length
        ? await this.prisma.user.findMany({
            where: { tenantId, id: { in: creatorIds } },
            select: { id: true, name: true },
          })
        : [];
      const nameById = new Map(creators.map((u) => [u.id, u.name]));
      courses = rows.map((c) => ({
        id: c.id,
        title: c.title,
        // Las descripciones migradas (LearnDash) traen HTML: en la página de
        // venta solo queremos texto plano corto, nunca marcado crudo.
        description: stripHtmlToExcerpt(c.description),
        thumbnailUrl: c.thumbnailUrl,
        estimatedMinutes: c.estimatedMinutes,
        category: c.category,
        moduleCount: c.modules.length,
        moduleTitles: c.modules.slice(0, 4).map((m) => m.title),
        teacherName: (c.createdById ? nameById.get(c.createdById) : null) ?? null,
        amountCents: priceByCourse.get(c.id) ?? null,
      }));
    }

    // Tiles con datos REALES (nada inventado): alumnos con acceso y horas del
    // catálogo. Si un dato no existe (p.ej. sin estimatedMinutes), la UI no
    // pinta ese tile.
    const activeMembers = await this.prisma.user.count({
      where: { tenantId, status: 'ACTIVE', deletedAt: null },
    });
    const stats: MembershipPublicStats = {
      activeMembers,
      totalMinutes: courses.reduce((sum, c) => sum + (c.estimatedMinutes ?? 0), 0),
    };

    const priced = courses.filter((c) => c.amountCents !== null);
    const standaloneTotalCents = priced.length
      ? priced.reduce((sum, c) => sum + (c.amountCents ?? 0), 0)
      : null;

    const testimonial =
      config.testimonialQuote && config.testimonialAuthor
        ? {
            quote: config.testimonialQuote,
            author: config.testimonialAuthor,
            role: config.testimonialRole,
          }
        : null;

    return {
      headline: config.headline,
      subheadline: config.subheadline,
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        intervalMonths: p.intervalMonths,
        amountCents: p.amountCents,
        currency: p.currency,
        compareAtCents: p.compareAtCents,
        trialDays: p.trialDays,
        isFeatured: p.isFeatured,
      })),
      courses,
      standaloneTotalCents,
      stats,
      testimonial,
      // Transparencia: la página de venta anuncia cuántas clases por curso se
      // ven durante la prueba (0 = acceso completo también en trial).
      trialLessonLimit: config.trialLessonLimit,
    };
  }

  // ---------------- Checkout ----------------

  /**
   * ¿Este correo ya tiene una membresía viva en este tenant?
   *
   * Lectura cross-module de `user` (permitida: el contrato prohíbe *escribir*,
   * no leer). El email se compara primero exacto y después sin distinguir
   * mayúsculas, igual que hace `/inscribe` y `/integrations/learners/state`: si
   * un tenant arrastra dos filas que solo difieren en la caja, las tres
   * respuestas tienen que hablar del mismo usuario o el guard sería esquivable
   * escribiendo el correo en mayúsculas.
   *
   * Devuelve la fila viva, o `null`. Nunca lanza: si no hay usuario con ese
   * correo, es que nunca ha comprado nada.
   */
  async findLiveMembershipByEmail(
    tenantId: string,
    email: string,
  ): Promise<{ id: string; status: string; planId: string | null } | null> {
    const limpio = email.trim();
    if (!limpio) return null;

    const user =
      (await this.prisma.user.findFirst({
        where: { tenantId, email: limpio },
        select: { id: true },
      })) ??
      (await this.prisma.user.findFirst({
        where: { tenantId, email: { equals: limpio, mode: 'insensitive' } },
        select: { id: true },
      }));
    if (!user) return null;

    return this.prisma.modSubscriptionsSubscription.findFirst({
      where: {
        tenantId,
        userId: user.id,
        // Membresía, no suscripción por curso: es lo que distingue las dos
        // clases de fila que comparten esta tabla.
        planId: { not: null },
        status: { in: [...MEMBERSHIP_LIVE_STATUSES] },
      },
      select: { id: true, status: true, planId: true },
    });
  }

  /**
   * Crea la Checkout Session de Stripe para un plan. `email` viene del user
   * logueado si lo hay; anónimo → Stripe lo recoge. No crea fila local: el
   * comprador puede no existir aún como user — la fila se crea en el webhook
   * `checkout.session.completed` (fulfillMembershipCheckout).
   *
   * ⚠️ **El guard de duplicados solo alcanza hasta donde llega el email.** Si
   * el comprador es anónimo, aquí no hay correo que comprobar —lo recoge Stripe
   * en su propia pantalla— y el duplicado se caza después, en
   * `fulfillMembershipCheckout`. Son dos redes distintas a propósito: esta
   * evita el cobro, la otra evita el acceso doble cuando el cobro ya ocurrió.
   */
  async startMembershipCheckout(args: {
    tenantId: string;
    planId: string;
    email?: string;
    successUrl: string;
    cancelUrl: string;
    /**
     * Código de atribución opcional (p.ej. programa de referidos). Viaja
     * opaco en la metadata de la session/subscription de Stripe y vuelve en
     * el payload del evento de activación — este módulo NO lo interpreta.
     */
    referralCode?: string;
    /**
     * Idioma activo de la UI del comprador. Viaja opaco en la metadata de la
     * session y vuelve en el webhook, que es lo único que sobrevive al salto a
     * Stripe: la fila de `user` no existe todavía cuando se inicia el checkout.
     * Este módulo NO lo interpreta ni lo valida — lo hace el host.
     */
    locale?: string;
  }): Promise<{ url: string; sessionId: string }> {
    const config = await this.getConfig(args.tenantId);
    if (!config.active) throw new MembershipPageInactiveError();

    if (args.email) {
      const viva = await this.findLiveMembershipByEmail(args.tenantId, args.email);
      if (viva) throw new MembershipAlreadySubscribedError(viva.status);
    }

    const plan = await this.prisma.modSubscriptionsPlan.findFirst({
      where: { id: args.planId, tenantId: args.tenantId, active: true },
    });
    if (!plan) throw new MembershipPlanNotFoundError(args.planId);

    const stripe = await this.stripeFor(args.tenantId);
    const priceId = await this.ensureStripePrice(plan, stripe);

    const session = await stripe.createCheckoutSession({
      priceId,
      successUrl: args.successUrl,
      cancelUrl: args.cancelUrl,
      customerEmail: args.email,
      trialDays: plan.trialDays,
      allowPromotionCodes: true,
      clientReferenceId: plan.id,
      metadata: {
        tenantId: args.tenantId,
        membership: '1',
        planId: plan.id,
        ...(args.referralCode ? { referralCode: args.referralCode } : {}),
        ...(args.locale ? { locale: args.locale } : {}),
      },
    });
    return { url: session.url, sessionId: session.id };
  }

  /**
   * Garantiza que el plan tiene un Price recurring vigente en Stripe.
   * Product por tenant (reutilizado entre planes); price por plan, rotado si
   * el admin cambió el importe (updatePlan limpia stripePriceId).
   */
  private async ensureStripePrice(
    plan: PlanRow,
    stripe: SubscriptionsStripeAdapter,
  ): Promise<string> {
    if (plan.stripePriceId) return plan.stripePriceId;

    let productId = plan.stripeProductId;
    if (!productId) {
      // Un Product de Stripe POR PLAN, nombrado con el nombre del plan: así el
      // checkout muestra "Plan Anual" (el nombre que ve el comprador es el
      // del Product de su price). El nombre lo controla el admin desde el nombre
      // del plan; renombrarlo lo resincroniza en Stripe (ver updatePlan).
      productId = await stripe.createProduct(plan.name, {
        tenantId: plan.tenantId,
        planId: plan.id,
        didacta: 'membership',
      });
    }

    const priceId = await stripe.createRecurringPrice({
      productId,
      amountCents: plan.amountCents,
      currency: plan.currency,
      intervalMonths: plan.intervalMonths,
      nickname: plan.name,
      metadata: { tenantId: plan.tenantId, planId: plan.id },
    });

    await this.prisma.modSubscriptionsPlan.update({
      where: { id: plan.id },
      data: { stripeProductId: productId, stripePriceId: priceId },
    });
    return priceId;
  }

  // ---------------- Fulfillment (webhook checkout.session.completed) ----------------

  /**
   * Procesa un `checkout.session.completed` de MEMBRESÍA (metadata.membership).
   * Idempotente por stripeSubscriptionId. El host inyecta `provisionUser` para
   * crear/buscar el user (el módulo no escribe la tabla user).
   *
   * Devuelve null si la session no es de membresía o le faltan datos.
   */
  async fulfillMembershipCheckout(
    session: Stripe.Checkout.Session,
    provisionUser: UserProvisioner,
  ): Promise<{
    subscriptionId: string;
    userId: string;
    userCreated: boolean;
    /**
     * Id de la membresía que esta persona YA tenía viva cuando llegó este
     * checkout. Distinto de `null` significa que **ha pagado dos veces**: la
     * fila se crea igual —si no, tendríamos una suscripción cobrándose en
     * Stripe que el panel no vería ni podría cancelar— pero quien llama tiene
     * que dejar constancia. No se resuelve solo: elegir entre reembolsar la
     * nueva, cancelar la vieja o dejar las dos es una decisión de negocio.
     */
    duplicateOf?: string | null;
  } | null> {
    const meta = (session.metadata ?? {}) as Record<string, string>;
    if (meta['membership'] !== '1') return null;
    const tenantId = meta['tenantId'];
    const planId = meta['planId'];
    const stripeSubscriptionId =
      typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    const email = session.customer_details?.email ?? session.customer_email ?? null;
    if (!tenantId || !planId || !stripeSubscriptionId || !email) {
      throw new MembershipConfigIncompleteError(
        `checkout.session.completed de membresía sin datos: tenantId=${tenantId ?? '∅'} planId=${planId ?? '∅'} sub=${stripeSubscriptionId ?? '∅'} email=${email ?? '∅'}`,
      );
    }

    // Idempotencia: si ya materializamos esta suscripción de Stripe, no-op.
    const existing = await this.prisma.modSubscriptionsSubscription.findUnique({
      where: { stripeSubscriptionId },
    });
    if (existing) {
      return { subscriptionId: existing.id, userId: existing.userId, userCreated: false };
    }

    const plan = await this.prisma.modSubscriptionsPlan.findFirst({
      where: { id: planId, tenantId },
    });
    if (!plan) throw new MembershipPlanNotFoundError(planId);

    const { userId, created } = await provisionUser({
      tenantId,
      email: email.trim().toLowerCase(),
      name: session.customer_details?.name ?? null,
      // Idioma con el que compró (lo escribió `startMembershipCheckout`). Va sin
      // validar a propósito: quien escribe la fila de `user` es el host y es él
      // quien decide qué locales acepta.
      locale: meta['locale'],
    });

    // La segunda red contra el duplicado. La primera —el guard de
    // `startMembershipCheckout`— solo actúa si sabíamos el email antes de
    // saltar a Stripe, y en la venta anónima no lo sabemos: lo escribe el
    // comprador en la pantalla de Stripe y vuelve aquí. Este es el único punto
    // del camino en el que el correo y la suscripción existen a la vez.
    const yaTenia = await this.prisma.modSubscriptionsSubscription.findFirst({
      where: {
        tenantId,
        userId,
        planId: { not: null },
        status: { in: [...MEMBERSHIP_LIVE_STATUSES] },
      },
      select: { id: true },
    });

    // Trial: si el plan tiene días de prueba, la sub nace TRIALING (con
    // acceso, pero mod.learning limita el contenido a trialLessonLimit). El
    // fin estimado es now + trialDays; Stripe (customer.subscription.updated)
    // converge el valor real después. Sin trial → ACTIVE directo.
    const trialing = plan.trialDays > 0;

    // EL DINERO PRIMERO, igual que en mod.billing. `checkout.session.completed`
    // dice que la persona terminó el formulario, no que hayamos cobrado: con un
    // método de notificación diferida (SEPA, transferencia) llega `unpaid` y el
    // cobro se resuelve después. Esta fila nacía ACTIVE sin mirarlo — acceso
    // completo a la membresía sin que hubiera entrado un euro.
    //
    // Hoy es inalcanzable porque el checkout de suscripciones solo acepta
    // tarjeta; se arregla ANTES de abrir métodos de pago, no después. Un trial
    // no se ve afectado: Stripe manda `no_payment_required` cuando no cobra al
    // dar de alta, y eso cuenta como resuelto.
    //
    // Sin cobro, la sub nace PENDING y NO se emite `membership.activated`: el
    // acceso lo concede después `onSubscriptionUpdated`/`onInvoicePaid` cuando
    // Stripe confirme. El user sí se crea —la fila necesita dueño—, así que
    // existe una cuenta sin acceso hasta que el pago entre; es el precio de
    // poder enlazar el pago con su comprador.
    const cobrado = isMembershipPaymentSettled(session);
    const sub = await this.prisma.modSubscriptionsSubscription.create({
      data: {
        tenantId,
        userId,
        courseId: null,
        planId: plan.id,
        stripeSubscriptionId,
        stripeCustomerId:
          typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? ''),
        stripePriceId: plan.stripePriceId ?? '',
        status: cobrado ? (trialing ? 'TRIALING' : 'ACTIVE') : 'PENDING',
        trialEndsAt:
          cobrado && trialing ? new Date(Date.now() + plan.trialDays * 24 * 60 * 60 * 1000) : null,
        unitAmount: plan.amountCents,
        currency: plan.currency,
        interval: intervalLabel(plan.intervalMonths),
      },
    });

    if (!cobrado) {
      return {
        subscriptionId: sub.id,
        userId,
        userCreated: created,
        duplicateOf: yaTenia?.id ?? null,
      };
    }

    // Atribución opaca (p.ej. referidos): si el checkout llevó referralCode,
    // vuelve en el payload para que el consumidor interesado (bridge del host)
    // la interprete. Este módulo no conoce su semántica.
    const referralCode = meta['referralCode']?.trim();
    await this.publisher.publish(tenantId, userId, MEMBERSHIP_EVENT.ACTIVATED, {
      subscriptionId: sub.id,
      planId: plan.id,
      userId,
      userCreated: created,
      stripeSubscriptionId,
      attribution: referralCode ? { referralCode } : null,
    });

    return {
      subscriptionId: sub.id,
      userId,
      userCreated: created,
      duplicateOf: yaTenia?.id ?? null,
    };
  }

  // ---------------- Pagar ahora (terminar el trial y cobrar ya) ----------------

  /**
   * Termina el periodo de prueba de la membresía del usuario AHORA: Stripe
   * cobra el primer periodo inmediatamente (`trial_end: 'now'`) y, si el cargo
   * entra, la sub pasa a ACTIVE y el gate de contenido de trial se apaga.
   *
   * Es el CTA "Pagar ahora y desbloquear todo" del candado de trial y de la
   * pestaña Suscripción de la cuenta.
   */
  async payNow(tenantId: string, userId: string): Promise<MembershipSubscriptionRow> {
    const sub = await this.prisma.modSubscriptionsSubscription.findFirst({
      where: { tenantId, userId, planId: { not: null }, status: 'TRIALING' },
      orderBy: { createdAt: 'desc' },
    });
    if (!sub || !sub.stripeSubscriptionId) throw new MembershipNotTrialingError();

    const stripe = await this.stripeFor(tenantId);
    const view = await stripe.endTrialNow(sub.stripeSubscriptionId);

    // Desbloqueo SOLO con evidencia de cobro: status active + invoice PAGADA
    // (Stripe puede devolver 'active' con la invoice aún cobrándose, y un
    // cargo fallido no debe apagar el gate de trial ni regalar grace). Si no
    // hay evidencia, la fila se queda TRIALING y son los webhooks quienes
    // resuelven: invoice.paid → ACTIVE, invoice.payment_failed → UNPAID
    // directo (sin gracia, la fila sigue TRIALING).
    const paid = view.status === 'active' && view.latestInvoicePaid;
    const updated = await this.prisma.modSubscriptionsSubscription.update({
      where: { id: sub.id },
      data: paid
        ? {
            status: 'ACTIVE',
            trialEndsAt: null,
            currentPeriodEnd: view.currentPeriodEnd
              ? new Date(view.currentPeriodEnd * 1000)
              : sub.currentPeriodEnd,
          }
        : {
            currentPeriodEnd: view.currentPeriodEnd
              ? new Date(view.currentPeriodEnd * 1000)
              : sub.currentPeriodEnd,
          },
    });

    if (paid) {
      // Re-anuncio idempotente del entitlement (el bridge de grupos absorbe
      // el duplicado); deja rastro del fin de trial pagado.
      await this.publisher.publish(tenantId, userId, 'subscriptions.subscription.activated', {
        subscriptionId: sub.id,
        courseId: null,
        planId: sub.planId,
        userId,
        trialEndedEarly: true,
      });
    }

    return updated;
  }
}

type MembershipSubscriptionRow = Awaited<
  ReturnType<PrismaClient['modSubscriptionsSubscription']['create']>
>;

/**
 * ¿El checkout de esta membresía dejó el dinero resuelto?
 *
 * `paid` es el cobro normal. `no_payment_required` es todo lo que no cobra al
 * dar de alta: un plan con días de prueba y un cupón del 100%. Los dos son
 * altas legítimas y tienen que conceder acceso.
 *
 * Lo demás —`unpaid`, o el campo ausente— cuenta como NO cobrado. Falla
 * cerrado: conceder de menos se corrige cuando Stripe confirma; conceder de
 * más es regalar la membresía.
 *
 * Gemela de `isPaymentSettled` de mod.billing. Está duplicada a propósito: los
 * módulos no comparten código entre sí (contrato modular), y son ocho líneas.
 */
function isMembershipPaymentSettled(session: Stripe.Checkout.Session): boolean {
  return session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
}

/**
 * Etiqueta informativa para la columna `interval` (texto libre): los periodos
 * con nombre usan el término clásico y el resto queda como «Nm» (p. ej. '6m').
 */
function intervalLabel(intervalMonths: number): string {
  if (intervalMonths === 12) return 'year';
  if (intervalMonths === 3) return 'quarter';
  if (intervalMonths === 1) return 'month';
  return `${intervalMonths}m`;
}

function configData(input: MembershipConfigInput) {
  return {
    ...(input.active !== undefined ? { active: input.active } : {}),
    ...(input.headline !== undefined ? { headline: input.headline } : {}),
    ...(input.subheadline !== undefined ? { subheadline: input.subheadline } : {}),
    ...(input.accessGroupId !== undefined ? { accessGroupId: input.accessGroupId } : {}),
    ...(input.showCourses !== undefined ? { showCourses: input.showCourses } : {}),
    ...(input.trialLessonLimit !== undefined ? { trialLessonLimit: input.trialLessonLimit } : {}),
    ...(input.coursePrices !== undefined ? { coursePrices: input.coursePrices as never } : {}),
    ...(input.testimonialQuote !== undefined ? { testimonialQuote: input.testimonialQuote } : {}),
    ...(input.testimonialAuthor !== undefined
      ? { testimonialAuthor: input.testimonialAuthor }
      : {}),
    ...(input.testimonialRole !== undefined ? { testimonialRole: input.testimonialRole } : {}),
  };
}

/** Longitud máxima del extracto de descripción en la página de venta. */
const EXCERPT_MAX_CHARS = 220;

/**
 * HTML → extracto de texto plano. Quita etiquetas, decodifica las entidades
 * habituales, colapsa espacios y corta en ~220 chars respetando palabras.
 * Devuelve null si no queda nada (para que la UI no pinte un párrafo vacío).
 */
/** Entidades HTML con nombre habituales en contenido migrado (WordPress/LearnDash). */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  ndash: '—',
  mdash: '—',
  hellip: '…',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  ntilde: 'ñ',
  uuml: 'ü',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  Ntilde: 'Ñ',
  iexcl: '¡',
  iquest: '¿',
  euro: '€',
};

export function stripHtmlToExcerpt(html: string | null): string | null {
  if (!html) return null;
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    // Entidades numéricas (&#233; / &#x2019;) → carácter real.
    .replace(/&#(\d+);/g, (_, code: string) => safeFromCodePoint(parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => safeFromCodePoint(parseInt(code, 16)))
    // Entidades con nombre conocidas; las desconocidas se quedan tal cual.
    .replace(/&([a-zA-Z]+);/g, (match, name: string) => NAMED_ENTITIES[name] ?? match)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (text.length <= EXCERPT_MAX_CHARS) return text;
  const cut = text.slice(0, EXCERPT_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 120 ? lastSpace : EXCERPT_MAX_CHARS).trimEnd()}…`;
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return ' ';
  try {
    return String.fromCodePoint(code);
  } catch {
    return ' ';
  }
}

function parseCoursePrices(value: unknown): Array<{ courseId: string; amountCents: number }> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (x): x is { courseId: string; amountCents: number } =>
      !!x &&
      typeof x === 'object' &&
      typeof (x as Record<string, unknown>)['courseId'] === 'string' &&
      typeof (x as Record<string, unknown>)['amountCents'] === 'number',
  );
}
