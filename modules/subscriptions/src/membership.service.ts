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
  MembershipConfigIncompleteError,
  MembershipPageInactiveError,
  MembershipPlanNotFoundError,
  StripeApiError,
  StripeConfigMissingError,
} from './errors.js';
import type { SubscriptionsStripeAdapter } from './stripe-subscriptions.client.js';
import type { SubscriptionsEventPublisher } from './subscriptions.service.js';

type PlanRow = Awaited<ReturnType<PrismaClient['modSubscriptionsPlan']['create']>>;
type ConfigRow = Awaited<ReturnType<PrismaClient['modSubscriptionsMembershipConfig']['upsert']>>;

export const MEMBERSHIP_EVENT = {
  /** Checkout pagado y suscripción local creada/vinculada al user. */
  ACTIVATED: 'subscriptions.membership.activated',
  /** La membresía deja de dar acceso (cancelación efectiva o impago agotado). */
  REVOKED: 'subscriptions.membership.revoked',
} as const;

/** Periodicidades soportadas (meses). */
export const PLAN_INTERVALS = [1, 3, 12] as const;

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
  /** Precio individual de referencia (céntimos) configurado por el admin, o null. */
  amountCents: number | null;
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
  testimonial: { quote: string; author: string; role: string | null } | null;
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
}) => Promise<{ userId: string; created: boolean }>;

export class MembershipService {
  constructor(
    private readonly prisma: PrismaClient,
    /** null si la instancia no tiene STRIPE_SECRET_KEY: config/planes siguen operativos, checkout no. */
    private readonly stripe: SubscriptionsStripeAdapter | null,
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
    return this.prisma.modSubscriptionsPlan.create({
      data: {
        tenantId,
        name: input.name,
        intervalMonths: input.intervalMonths,
        amountCents: input.amountCents,
        currency: input.currency ?? 'eur',
        compareAtCents: input.compareAtCents ?? null,
        trialDays: input.trialDays ?? 0,
        active: input.active ?? true,
        isFeatured: input.isFeatured ?? false,
        sortOrder: input.sortOrder ?? 0,
      },
    });
  }

  async updatePlan(tenantId: string, planId: string, input: Partial<PlanInput>): Promise<PlanRow> {
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

    return this.prisma.modSubscriptionsPlan.update({
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
        },
      });
      courses = rows.map((c) => ({
        id: c.id,
        title: c.title,
        // Las descripciones migradas (LearnDash) traen HTML: en la página de
        // venta solo queremos texto plano corto, nunca marcado crudo.
        description: stripHtmlToExcerpt(c.description),
        thumbnailUrl: c.thumbnailUrl,
        estimatedMinutes: c.estimatedMinutes,
        amountCents: priceByCourse.get(c.id) ?? null,
      }));
    }

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
      testimonial,
    };
  }

  // ---------------- Checkout ----------------

  /**
   * Crea la Checkout Session de Stripe para un plan. `email` viene del user
   * logueado si lo hay; anónimo → Stripe lo recoge. No crea fila local: el
   * comprador puede no existir aún como user — la fila se crea en el webhook
   * `checkout.session.completed` (fulfillMembershipCheckout).
   */
  async startMembershipCheckout(args: {
    tenantId: string;
    planId: string;
    email?: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string; sessionId: string }> {
    if (!this.stripe) throw new StripeConfigMissingError('secretKey');
    const config = await this.getConfig(args.tenantId);
    if (!config.active) throw new MembershipPageInactiveError();

    const plan = await this.prisma.modSubscriptionsPlan.findFirst({
      where: { id: args.planId, tenantId: args.tenantId, active: true },
    });
    if (!plan) throw new MembershipPlanNotFoundError(args.planId);

    const priceId = await this.ensureStripePrice(plan);

    const session = await this.stripe.createCheckoutSession({
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
      },
    });
    return { url: session.url, sessionId: session.id };
  }

  /**
   * Garantiza que el plan tiene un Price recurring vigente en Stripe.
   * Product por tenant (reutilizado entre planes); price por plan, rotado si
   * el admin cambió el importe (updatePlan limpia stripePriceId).
   */
  private async ensureStripePrice(plan: PlanRow): Promise<string> {
    if (!this.stripe) throw new StripeConfigMissingError('secretKey');
    if (plan.stripePriceId) return plan.stripePriceId;

    let productId = plan.stripeProductId;
    if (!productId) {
      // Reusar el product de otro plan del tenant si ya existe.
      const sibling = await this.prisma.modSubscriptionsPlan.findFirst({
        where: { tenantId: plan.tenantId, stripeProductId: { not: null } },
        select: { stripeProductId: true },
      });
      productId =
        sibling?.stripeProductId ??
        (await this.stripe.createProduct(`Membresía — ${plan.name}`, {
          tenantId: plan.tenantId,
          didacta: 'membership',
        }));
    }

    const priceId = await this.stripe.createRecurringPrice({
      productId,
      amountCents: plan.amountCents,
      currency: plan.currency,
      intervalMonths: plan.intervalMonths,
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
  ): Promise<{ subscriptionId: string; userId: string; userCreated: boolean } | null> {
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
    });

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
        // El checkout completado implica pago OK (o trial iniciado) → ACTIVE.
        // Los eventos customer.subscription.updated posteriores ajustan estado
        // y currentPeriodEnd (mapStripeStatus trata trialing como ACTIVE).
        status: 'ACTIVE',
        unitAmount: plan.amountCents,
        currency: plan.currency,
        interval: intervalLabel(plan.intervalMonths),
      },
    });

    await this.publisher.publish(tenantId, userId, MEMBERSHIP_EVENT.ACTIVATED, {
      subscriptionId: sub.id,
      planId: plan.id,
      userId,
      userCreated: created,
    });

    return { subscriptionId: sub.id, userId, userCreated: created };
  }
}

/** 'month' | 'quarter' | 'year' para la columna interval (texto libre). */
function intervalLabel(intervalMonths: number): string {
  if (intervalMonths === 12) return 'year';
  if (intervalMonths === 3) return 'quarter';
  return 'month';
}

function configData(input: MembershipConfigInput) {
  return {
    ...(input.active !== undefined ? { active: input.active } : {}),
    ...(input.headline !== undefined ? { headline: input.headline } : {}),
    ...(input.subheadline !== undefined ? { subheadline: input.subheadline } : {}),
    ...(input.accessGroupId !== undefined ? { accessGroupId: input.accessGroupId } : {}),
    ...(input.showCourses !== undefined ? { showCourses: input.showCourses } : {}),
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
