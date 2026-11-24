/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * MembershipService — venta de MEMBRESÍA por suscripción (página pública /join).
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

import { Prisma, type PrismaClient } from '@didacta/database';
import type Stripe from 'stripe';
import {
  MembershipAlreadySubscribedError,
  MembershipConfigIncompleteError,
  MembershipNotTrialingError,
  MembershipPageInactiveError,
  MembershipPlanChangeNotAllowedError,
  MembershipPlanIntervalInvalidError,
  MembershipPlanNameTakenError,
  MembershipPlanNotFoundError,
  MembershipTierInvalidError,
  MembershipTierIsFreeError,
  MembershipTierNotFoundError,
  WebhookTenantMismatchError,
} from './errors.js';
import {
  MEMBERSHIP_PLAN_CHANGED_EVENT,
  applyMembershipPlanChange,
  intervalLabel,
  planChangeDirection,
  type PlanChangeDirection,
} from './plan-change.js';
import type {
  PlanChangeProrationBehavior,
  SubscriptionsStripeAdapter,
} from './stripe-subscriptions.client.js';
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
  /** El alumno cambió de plan desde su cuenta (o lo reconcilió el webhook). */
  PLAN_CHANGED: MEMBERSHIP_PLAN_CHANGED_EVENT,
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
 * El titular que la columna ponía por defecto antes, en español para todas las
 * aulas. Hoy la columna nace vacía: el titular por defecto no se guarda, lo
 * pone la web desde su catálogo en el idioma del aula («Become a member»). Las
 * filas que ya lo tienen guardado se leen como «sin titular propio» — nadie lo
 * escribió, y en un aula inglesa era un texto ajeno.
 */
export const MEMBERSHIP_LEGACY_DEFAULT_HEADLINE = 'Hazte miembro';

/** El titular que escribió el aula, o `null` si es el de por defecto (vacío o el de antes). */
export function customMembershipHeadline(raw: string | null | undefined): string | null {
  const headline = raw?.trim();
  return headline && headline !== MEMBERSHIP_LEGACY_DEFAULT_HEADLINE ? headline : null;
}

/** La fila de configuración con el titular por defecto como vacío (lo que ve el admin). */
function withCustomHeadline<T extends { headline: string }>(row: T): T {
  return { ...row, headline: customMembershipHeadline(row.headline) ?? '' };
}

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
 *
 * `PAUSED` también: es una pausa que pidió el propio alumno y que se reanuda
 * sola. Venderle otra membresía le cobraría dos veces cuando vuelva.
 */
export const MEMBERSHIP_LIVE_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED'] as const;

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
  /**
   * Nivel del plan (solo al crearlo; no cambia después: quien ya lo paga no
   * cambia de contenido). Sin él, el plan de siempre (grupo de la config).
   */
  tierId?: string | null;
  intervalMonths: number;
  amountCents: number;
  currency?: string;
  /**
   * Precios fijos extra por mercado (`currency_options`): moneda → importe en
   * su unidad mínima. `null`/`{}` = ninguno. Cambiarlos rota el Price.
   */
  currencyOptions?: Readonly<Record<string, number>> | null;
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

/** Un curso tal y como se nombra en la tarjeta de un nivel. */
export interface MembershipTierCourseView {
  id: string;
  title: string;
  thumbnailUrl: string | null;
}

/**
 * Un nivel de la membresía tal y como lo pinta /join. `includes` es lo que da
 * el nivel; hoy los cursos de su grupo. Es un objeto (y no una lista suelta)
 * para que se le puedan añadir más cosas que dé el nivel (espacios de la
 * comunidad, directos) sin romper a quien ya lo lee.
 */
export interface MembershipPublicTier {
  id: string;
  name: string;
  description: string | null;
  isFree: boolean;
  sortOrder: number;
  /** Id del grupo de acceso que da el nivel (lo que restringe contenido). */
  accessGroupId: string | null;
  includes: {
    /** `true`: todos los cursos publicados, también los que se publiquen después. */
    allCourses: boolean;
    courses: MembershipTierCourseView[];
    /**
     * Espacios de la comunidad restringidos a este nivel (solo el nombre). Los
     * añade el host al componer la página con mod.community; ausente si no.
     */
    spaces?: Array<{ name: string }>;
    /**
     * Próximos directos restringidos a este nivel (título y fecha ISO). Los
     * añade el host con mod.zoom-live; ausente si no.
     */
    lives?: Array<{ title: string; startTime: string }>;
  };
  /** Planes del nivel (periodicidades), en el orden de la página. Vacío en el gratis. */
  planIds: string[];
}

export interface MembershipPublicPage {
  /** El titular del aula, o `null` para que la web ponga el suyo en el idioma del aula. */
  headline: string | null;
  subheadline: string | null;
  plans: Array<{
    id: string;
    name: string;
    /** Nivel del plan, o `null` en un aula sin niveles (lo de siempre). */
    tierId: string | null;
    intervalMonths: number;
    amountCents: number;
    currency: string;
    compareAtCents: number | null;
    trialDays: number;
    isFeatured: boolean;
  }>;
  /**
   * Niveles encendidos, en su orden (con el gratis si lo hay). Vacío en un aula
   * sin niveles: la página se pinta como siempre, con `plans`.
   */
  tiers: MembershipPublicTier[];
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
    const tierId = input.tierId ?? null;
    if (tierId) {
      const tier = await this.prisma.modSubscriptionsTier.findFirst({
        where: { id: tierId, tenantId },
        select: { id: true, isFree: true },
      });
      if (!tier) throw new MembershipTierNotFoundError(tierId);
      if (tier.isFree) throw new MembershipTierIsFreeError(tierId);
    } else if (
      (await this.prisma.modSubscriptionsTier.count({ where: { tenantId, isFree: false } })) > 0
    ) {
      // Con niveles, un plan suelto no se vería en ningún sitio de /join.
      throw new MembershipTierInvalidError('tier_required');
    }
    await this.assertPlanNameFree(tenantId, input.name, null);
    return this.prisma.modSubscriptionsPlan.create({
      data: {
        tenantId,
        tierId,
        name: input.name,
        intervalMonths: input.intervalMonths,
        amountCents: input.amountCents,
        currency: input.currency ?? PLAN_DEFAULT_CURRENCY,
        ...(normalizeCurrencyOptions(input.currencyOptions)
          ? { currencyOptions: normalizeCurrencyOptions(input.currencyOptions)! }
          : {}),
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
    const optionsBefore = normalizeCurrencyOptions(
      plan.currencyOptions as Record<string, number> | null,
    );
    const optionsAfter =
      input.currencyOptions === undefined
        ? optionsBefore
        : normalizeCurrencyOptions(input.currencyOptions);
    const optionsChanged = JSON.stringify(optionsBefore) !== JSON.stringify(optionsAfter);
    const priceChanged =
      optionsChanged ||
      (input.amountCents !== undefined && input.amountCents !== plan.amountCents) ||
      (input.currency !== undefined && input.currency !== plan.currency) ||
      (input.intervalMonths !== undefined && input.intervalMonths !== plan.intervalMonths);
    const nameChanged = input.name !== undefined && input.name !== plan.name;
    if (nameChanged) await this.assertPlanNameFree(tenantId, input.name!, plan.id);

    const updated = await this.prisma.modSubscriptionsPlan.update({
      where: { id: plan.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.intervalMonths !== undefined ? { intervalMonths: input.intervalMonths } : {}),
        ...(input.amountCents !== undefined ? { amountCents: input.amountCents } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(optionsChanged ? { currencyOptions: optionsAfter ?? Prisma.DbNull } : {}),
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

  /**
   * Los nombres de plan son únicos por aula (índice de la tabla). Se mira antes
   * para responder un 409 claro en vez del error de la base.
   */
  private async assertPlanNameFree(
    tenantId: string,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await this.prisma.modSubscriptionsPlan.findFirst({
      where: { tenantId, name, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    });
    if (clash) throw new MembershipPlanNameTakenError(name);
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

  /**
   * Configuración de la página. El titular por defecto sale VACÍO (`''`): el
   * admin ve el de su idioma como placeholder y, si no escribe nada, la página
   * pública pone el del idioma del aula. Guardar `''` vuelve al de por defecto.
   */
  async getConfig(tenantId: string): Promise<ConfigRow> {
    return withCustomHeadline(
      await this.prisma.modSubscriptionsMembershipConfig.upsert({
        where: { tenantId },
        create: { tenantId },
        update: {},
      }),
    );
  }

  async updateConfig(tenantId: string, input: MembershipConfigInput): Promise<ConfigRow> {
    return withCustomHeadline(
      await this.prisma.modSubscriptionsMembershipConfig.upsert({
        where: { tenantId },
        create: { tenantId, ...configData(input) },
        update: configData(input),
      }),
    );
  }

  // ---------------- Página pública ----------------

  /**
   * Datos que pinta /join. Lanza MembershipPageInactiveError si la página no
   * está activada por el admin. Lee cursos PUBLISHED de mod.courses (lectura
   * cross-module permitida en core first-party, filtrada por tenant y
   * declarada en el manifest).
   */
  async getPublicPage(tenantId: string): Promise<MembershipPublicPage> {
    const config = await this.getConfig(tenantId);
    if (!config.active) throw new MembershipPageInactiveError();

    const allPlans = await this.prisma.modSubscriptionsPlan.findMany({
      where: { tenantId, active: true },
      orderBy: [{ sortOrder: 'asc' }, { amountCents: 'asc' }],
    });
    const tierRows = await this.prisma.modSubscriptionsTier.findMany({
      where: { tenantId, active: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    // Con niveles, solo se venden los planes de un nivel de pago encendido; un
    // plan de un nivel apagado no se ofrece (quien ya lo paga lo conserva).
    const sellingTierIds = new Set(tierRows.filter((t) => !t.isFree).map((t) => t.id));
    const plans = allPlans.filter((p) => !p.tierId || sellingTierIds.has(p.tierId));
    const tiers = await this.publicTiers(tenantId, tierRows, plans);

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
      headline: customMembershipHeadline(config.headline),
      subheadline: config.subheadline,
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        tierId: p.tierId ?? null,
        intervalMonths: p.intervalMonths,
        amountCents: p.amountCents,
        currency: p.currency,
        compareAtCents: p.compareAtCents,
        trialDays: p.trialDays,
        isFeatured: p.isFeatured,
      })),
      tiers,
      courses,
      standaloneTotalCents,
      stats,
      testimonial,
      // Transparencia: la página de venta anuncia cuántas clases por curso se
      // ven durante la prueba (0 = acceso completo también en trial).
      trialLessonLimit: config.trialLessonLimit,
    };
  }

  /**
   * Los niveles de /join con lo que incluye cada uno: los cursos PUBLICADOS de
   * su grupo de acceso (lectura cross-module de mod.access-groups y
   * mod.courses, permitida en core first-party: solo lectura, filtrada por
   * tenant y declarada en el manifest).
   */
  private async publicTiers(
    tenantId: string,
    tierRows: Array<{
      id: string;
      name: string;
      description: string | null;
      isFree: boolean;
      sortOrder: number;
      accessGroupId: string | null;
    }>,
    plans: Array<{ id: string; tierId: string | null }>,
  ): Promise<MembershipPublicTier[]> {
    if (tierRows.length === 0) return [];
    const groupIds = tierRows.map((t) => t.accessGroupId).filter((x): x is string => !!x);
    const groups = groupIds.length
      ? await this.prisma.modAccessGroup.findMany({
          where: { tenantId, id: { in: groupIds }, deletedAt: null },
          select: { id: true, kind: true, courses: { select: { courseId: true } } },
        })
      : [];
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const published = await this.prisma.modCoursesCourse.findMany({
      where: { tenantId, status: 'PUBLISHED', deletedAt: null },
      orderBy: { publishedAt: 'desc' },
      select: { id: true, title: true, thumbnailUrl: true },
    });
    const publishedById = new Map(published.map((c) => [c.id, c]));
    return tierRows.map((tier) => {
      const group = tier.accessGroupId ? groupById.get(tier.accessGroupId) : undefined;
      const allCourses = group?.kind === 'ALL_COURSES';
      const courseIds = new Set((group?.courses ?? []).map((c) => c.courseId));
      const courses = allCourses ? published : published.filter((c) => courseIds.has(c.id));
      return {
        id: tier.id,
        name: tier.name,
        description: tier.description,
        isFree: tier.isFree,
        sortOrder: tier.sortOrder,
        accessGroupId: tier.accessGroupId,
        includes: {
          allCourses,
          courses: courses
            .filter((c) => publishedById.has(c.id))
            .map((c) => ({ id: c.id, title: c.title, thumbnailUrl: c.thumbnailUrl })),
        },
        planIds: tier.isFree ? [] : plans.filter((p) => p.tierId === tier.id).map((p) => p.id),
      };
    });
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
    /**
     * `embedded`: el pago dentro de la página de venta del aula (vuelve a
     * `returnUrl`). Sin él, el redirect de siempre a la página de Stripe.
     */
    uiMode?: 'hosted' | 'embedded';
    /** Vuelta del embebido, con `{CHECKOUT_SESSION_ID}`. */
    returnUrl?: string;
    /** Idioma de la pantalla de pago de Stripe; sin él, el del navegador. */
    checkoutLocale?: 'es' | 'en' | 'pt-BR';
  }): Promise<{
    url: string | null;
    sessionId: string;
    clientSecret: string | null;
    /** Lo que cobra HOY la sesión creada (0 con prueba gratis) y su moneda. */
    amountTotal: number | null;
    currency: string | null;
  }> {
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
    // Un plan de un nivel apagado (o gratis) no se vende, igual que no sale en /join.
    if (plan.tierId) {
      const tier = await this.prisma.modSubscriptionsTier.findFirst({
        where: { id: plan.tierId, tenantId: args.tenantId, active: true, isFree: false },
        select: { id: true },
      });
      if (!tier) throw new MembershipPlanNotFoundError(args.planId);
    }

    const stripe = await this.stripeFor(args.tenantId);
    const priceId = await this.ensureStripePrice(plan, stripe);

    const session = await stripe.createCheckoutSession({
      priceId,
      successUrl: args.successUrl,
      cancelUrl: args.cancelUrl,
      ...(args.uiMode === 'embedded'
        ? { uiMode: 'embedded' as const, returnUrl: args.returnUrl }
        : {}),
      ...(args.checkoutLocale ? { locale: args.checkoutLocale } : {}),
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
    return {
      url: session.url,
      sessionId: session.id,
      clientSecret: session.clientSecret ?? null,
      amountTotal: session.amountTotal ?? null,
      currency: session.currency ?? null,
    };
  }

  /**
   * Estado de una sesión de pago de la membresía de ESTE tenant, para la
   * pantalla de vuelta. La membresía no deja fila hasta el webhook, así que la
   * pertenencia se comprueba con la metadata que pone `startMembershipCheckout`
   * (`tenantId` + `membership`): una sesión de otra academia, o que no es de
   * membresía, es «no existe» (`null`). No concede nada.
   */
  async getCheckoutSessionState(
    tenantId: string,
    sessionId: string,
  ): Promise<{
    status: 'open' | 'complete' | 'expired' | null;
    paid: boolean;
    planId: string | null;
    amount: number | null;
    currency: string | null;
    at: string | null;
  } | null> {
    const stripe = await this.stripeFor(tenantId);
    const session = await stripe.retrieveCheckoutSession(sessionId);
    if (session.metadata['tenantId'] !== tenantId || session.metadata['membership'] !== '1') {
      return null;
    }
    return {
      planId: session.metadata['planId'] ?? null,
      amount: session.amountTotal ?? null,
      currency: session.currency ?? null,
      at: session.created ? new Date(session.created * 1000).toISOString() : null,
      status: session.status,
      // Con prueba gratis no hay cobro hoy: `no_payment_required` también vale.
      paid:
        session.status === 'complete' &&
        (session.paymentStatus === 'paid' || session.paymentStatus === 'no_payment_required'),
    };
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
    return this.createStripeCatalog(plan, stripe, plan.stripeProductId);
  }

  /**
   * Vuelve a crear en la cuenta de Stripe ACTUAL del tenant el Product y el
   * Price de cada plan activo que ya tenía precio, y apunta el plan a los
   * nuevos.
   *
   * Para qué: cuando un tenant cambia de cuenta de Stripe (p. ej. deja de
   * cobrar con sus claves y pasa a cobrar a través del operador de la
   * instalación), sus `price_…` siguen en la cuenta vieja y un checkout con
   * ellos fallaría con «No such price». Las suscripciones ya vendidas no se
   * tocan: siguen en la cuenta donde nacieron, con su precio de entonces.
   *
   * El módulo no sabe en qué cuenta vive cada precio. Lo dice quien llama con
   * `isCurrent(priceId)`: `true` = ya está en la cuenta actual, no se toca. Sin
   * `isCurrent`, se recrean todos. Un plan que nunca se vendió (sin Product ni
   * Price) no se toca: el primer checkout lo crea en la cuenta actual.
   */
  async resyncStripeCatalog(
    tenantId: string,
    opts: {
      /** Limita la pasada a un plan. */
      planId?: string;
      isCurrent?: (stripePriceId: string) => Promise<boolean>;
    } = {},
  ): Promise<{ resynced: number; skipped: number }> {
    const plans = await this.prisma.modSubscriptionsPlan.findMany({
      where: { tenantId, active: true, ...(opts.planId ? { id: opts.planId } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    let resynced = 0;
    let skipped = 0;
    let stripe: SubscriptionsStripeAdapter | null = null;
    for (const plan of plans) {
      // El precio, o si se limpió al cambiar el importe, el Product que el
      // próximo checkout reutilizaría: los dos tienen que estar en esta cuenta.
      const stripeRef = plan.stripePriceId ?? plan.stripeProductId;
      if (!stripeRef) {
        skipped += 1;
        continue;
      }
      if (opts.isCurrent && (await opts.isCurrent(stripeRef))) {
        skipped += 1;
        continue;
      }
      stripe ??= await this.stripeFor(tenantId);
      // Product nuevo: el viejo vive en la otra cuenta y no sirve para un
      // precio de esta.
      await this.createStripeCatalog(plan, stripe, null);
      resynced += 1;
    }
    return { resynced, skipped };
  }

  /** Crea (si hace falta) el Product y el Price del plan y los apunta en el plan. */
  private async createStripeCatalog(
    plan: PlanRow,
    stripe: SubscriptionsStripeAdapter,
    existingProductId: string | null,
  ): Promise<string> {
    let productId = existingProductId;
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
      currencyOptions: normalizeCurrencyOptions(
        plan.currencyOptions as Record<string, number> | null,
      ),
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
   * Tenants a los que un `checkout.session.completed` de MEMBRESÍA nombra o
   * toca, sin procesarlo: el `tenantId` de su metadata y el dueño de la
   * suscripción local que ya exista con ese id de Stripe. Mismo contrato que
   * `SubscriptionsService.resolveWebhookTenantClaims`: el host solo procesa el
   * evento si todo pertenece al tenant cuyo secreto verificó la firma.
   */
  async resolveWebhookTenantClaims(event: Stripe.Event): Promise<string[]> {
    if (event.type !== 'checkout.session.completed') return [];
    const session = event.data.object as Stripe.Checkout.Session;
    const meta = (session.metadata ?? {}) as Record<string, string>;
    if (meta['membership'] !== '1') return [];
    const claims = new Set<string>();
    if (meta['tenantId']) claims.add(meta['tenantId']);
    const stripeSubscriptionId =
      typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    if (stripeSubscriptionId) {
      const existing = await this.prisma.modSubscriptionsSubscription.findUnique({
        where: { stripeSubscriptionId },
        select: { tenantId: true },
      });
      if (existing) claims.add(existing.tenantId);
    }
    return [...claims];
  }

  /**
   * Procesa un `checkout.session.completed` de MEMBRESÍA (metadata.membership).
   * Idempotente por stripeSubscriptionId. El host inyecta `provisionUser` para
   * crear/buscar el user (el módulo no escribe la tabla user).
   *
   * Devuelve null si la session no es de membresía o le faltan datos.
   *
   * `opts.tenantId` es OBLIGATORIO: el tenant para el que el host verificó el
   * evento (el dueño del secreto que validó la firma). La metadata de la
   * session lo escribe quien firma, así que NO decide a qué aula se le crea la
   * membresía: si nombra a otra, se lanza `WebhookTenantMismatchError` antes de
   * crear usuario ni suscripción. Era el agujero: un admin de otra aula firmaba
   * con su secreto una session con `tenantId` de esta y obtenía aquí una
   * membresía ACTIVE sin pagar.
   */
  async fulfillMembershipCheckout(
    session: Stripe.Checkout.Session,
    provisionUser: UserProvisioner,
    opts: { tenantId: string },
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
    const tenantId = opts?.tenantId;
    if (!tenantId) throw new WebhookTenantMismatchError('membresía sin tenant verificado');
    const planId = meta['planId'];
    const stripeSubscriptionId =
      typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    const email = session.customer_details?.email ?? session.customer_email ?? null;
    if (!meta['tenantId'] || !planId || !stripeSubscriptionId || !email) {
      throw new MembershipConfigIncompleteError(
        `checkout.session.completed de membresía sin datos: tenantId=${meta['tenantId'] ?? '∅'} planId=${planId ?? '∅'} sub=${stripeSubscriptionId ?? '∅'} email=${email ?? '∅'}`,
      );
    }
    // La metadata nombra un aula y el host verificó el evento para otra.
    if (meta['tenantId'] !== tenantId) {
      throw new WebhookTenantMismatchError(`metadata de la session ${session.id}`);
    }

    // Idempotencia: si ya materializamos esta suscripción de Stripe, no-op.
    const existing = await this.prisma.modSubscriptionsSubscription.findUnique({
      where: { stripeSubscriptionId },
    });
    if (existing && existing.tenantId !== tenantId) {
      throw new WebhookTenantMismatchError(`suscripción ${stripeSubscriptionId}`);
    }
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
        customerCountry: checkoutBuyerCountry(session),
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

  // ---------------- Cambiar de nivel (cuenta del alumno) ----------------

  /**
   * La membresía del alumno que se puede cambiar de plan: la viva más reciente
   * (con su plan y nivel). `null` si no tiene.
   */
  private async liveMembership(tenantId: string, userId: string) {
    return this.prisma.modSubscriptionsSubscription.findFirst({
      where: {
        tenantId,
        userId,
        planId: { not: null },
        status: { in: [...MEMBERSHIP_LIVE_STATUSES] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Por qué esta membresía no se puede cambiar ahora, o `null` si se puede.
   * Solo al día (ACTIVE) o en prueba (TRIALING), sin baja ni pausa programadas:
   * con un impago o una pausa, lo primero es arreglar eso.
   */
  private changeBlocker(sub: {
    status: string;
    cancelAtPeriodEnd: boolean;
    pauseStartsAt: Date | null;
    stripeSubscriptionId: string | null;
  }): PlanChangeBlockReason | null {
    if (sub.status !== 'ACTIVE' && sub.status !== 'TRIALING') return 'not_active';
    if (!sub.stripeSubscriptionId) return 'not_active';
    if (sub.cancelAtPeriodEnd) return 'cancel_scheduled';
    if (sub.pauseStartsAt) return 'pause_scheduled';
    return null;
  }

  /**
   * A qué planes puede pasar el alumno desde su cuenta: los de los niveles de
   * pago encendidos, en la misma moneda que paga (Stripe no mezcla monedas en
   * una suscripción). Solo en aulas con niveles: sin ellos, la cuenta sigue
   * como siempre (sin opciones). También dice cuál es el nivel gratis, si hay:
   * pasar a él es darse de baja (el flujo de siempre).
   */
  async getPlanChangeOptions(tenantId: string, userId: string): Promise<PlanChangeOptions> {
    const tiers = await this.prisma.modSubscriptionsTier.findMany({
      where: { tenantId, active: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const freeTier = tiers.find((t) => t.isFree) ?? null;
    const sub = await this.liveMembership(tenantId, userId);
    const paidTiers = tiers.filter((t) => !t.isFree);
    const base: PlanChangeOptions = {
      subscription: null,
      blockedReason: null,
      options: [],
      freeTier: freeTier ? { id: freeTier.id, name: freeTier.name } : null,
    };
    if (!sub) return { ...base, blockedReason: 'no_membership' };

    const currentPlan = sub.planId
      ? await this.prisma.modSubscriptionsPlan.findFirst({ where: { id: sub.planId, tenantId } })
      : null;
    const currentTier = currentPlan?.tierId
      ? ((await this.prisma.modSubscriptionsTier.findFirst({
          where: { id: currentPlan.tierId, tenantId },
        })) ?? null)
      : null;
    const current = {
      amountCents: currentPlan?.amountCents ?? sub.unitAmount,
      intervalMonths: currentPlan?.intervalMonths ?? 1,
    };
    const view: PlanChangeOptions['subscription'] = {
      id: sub.id,
      status: sub.status,
      planId: sub.planId,
      planName: currentPlan?.name ?? null,
      tierId: currentTier?.id ?? null,
      tierName: currentTier?.name ?? null,
      amountCents: current.amountCents,
      currency: sub.currency,
      intervalMonths: current.intervalMonths,
    };
    if (paidTiers.length === 0) return { ...base, subscription: view };

    const plans = await this.prisma.modSubscriptionsPlan.findMany({
      where: {
        tenantId,
        active: true,
        tierId: { in: paidTiers.map((t) => t.id) },
        ...(sub.planId ? { NOT: { id: sub.planId } } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { amountCents: 'asc' }],
    });
    const tierOrder = new Map(paidTiers.map((t, i) => [t.id, i]));
    const tierById = new Map(paidTiers.map((t) => [t.id, t]));
    const options: PlanChangeOption[] = plans
      .filter((p) => p.currency === sub.currency)
      .sort(
        (a, b) =>
          (tierOrder.get(a.tierId!) ?? 0) - (tierOrder.get(b.tierId!) ?? 0) ||
          a.intervalMonths - b.intervalMonths,
      )
      .map((p) => ({
        planId: p.id,
        planName: p.name,
        tierId: p.tierId!,
        tierName: tierById.get(p.tierId!)?.name ?? '',
        intervalMonths: p.intervalMonths,
        amountCents: p.amountCents,
        currency: p.currency,
        compareAtCents: p.compareAtCents,
        isFeatured: p.isFeatured,
        direction: planChangeDirection(current, p),
      }));
    return {
      ...base,
      subscription: view,
      blockedReason: this.changeBlocker(sub),
      options,
    };
  }

  /**
   * Lo que pasaría al cambiar a `planId` AHORA: cuánto se cobra hoy (subir) o
   * cuánto queda a favor para las próximas facturas (bajar). En la prueba
   * gratis no se cobra nada: el precio nuevo se paga al acabar la prueba.
   */
  async previewPlanChange(
    tenantId: string,
    userId: string,
    planId: string,
  ): Promise<PlanChangePreview> {
    const { sub, target, current } = await this.resolveChange(tenantId, userId, planId);
    const direction = planChangeDirection(current, target);
    if (sub.status === 'TRIALING') {
      return {
        planId: target.id,
        direction,
        trialing: true,
        amountDueNow: 0,
        creditCents: 0,
        currency: sub.currency,
      };
    }
    const stripe = await this.stripeFor(tenantId);
    const priceId = await this.ensureStripePrice(target, stripe);
    const preview = await stripe.previewSubscriptionPriceChange({
      subscriptionId: sub.stripeSubscriptionId!,
      priceId,
    });
    return {
      planId: target.id,
      direction,
      trialing: false,
      // Bajar no cobra nada hoy: la diferencia queda para las próximas facturas.
      amountDueNow: direction === 'upgrade' ? preview.amountDue : 0,
      creditCents: preview.total < 0 ? -preview.total : 0,
      currency: preview.currency || sub.currency,
    };
  }

  /**
   * Cambia la membresía del alumno a `planId` (otro nivel u otra periodicidad),
   * al momento y con prorrateo de Stripe:
   *   - SUBIR (cuesta más al mes): Stripe factura y cobra la diferencia ya. Si
   *     el cobro falla, NO cambia nada (`MembershipPlanChangePaymentFailedError`).
   *   - BAJAR: la diferencia queda a favor del alumno en su próxima factura.
   *   - En PRUEBA GRATIS: sin prorrateo; sigue la prueba y al acabar paga el
   *     plan nuevo.
   * Con Stripe confirmado, la fila cambia de plan (compare-and-swap) y se avisa
   * `subscriptions.membership.plan_changed`: el host da el grupo del nivel
   * nuevo y quita el del viejo. Vale igual con cobros de plataforma (la
   * suscripción ya lleva su `on_behalf_of` y la comisión se calcula por
   * factura) y con las claves propias del aula.
   */
  async changePlan(tenantId: string, userId: string, planId: string): Promise<PlanChangeResult> {
    const { sub, target, current } = await this.resolveChange(tenantId, userId, planId);
    const direction = planChangeDirection(current, target);
    const proration: PlanChangeProrationBehavior =
      sub.status === 'TRIALING'
        ? 'none'
        : direction === 'upgrade'
          ? 'always_invoice'
          : 'create_prorations';

    const stripe = await this.stripeFor(tenantId);
    const priceId = await this.ensureStripePrice(target, stripe);
    const change = await stripe.changeSubscriptionPrice({
      subscriptionId: sub.stripeSubscriptionId!,
      priceId,
      prorationBehavior: proration,
      // El webhook `customer.subscription.updated` reconcilia por aquí si esta
      // petición se corta después de Stripe.
      metadata: { planId: target.id, ...(target.tierId ? { tierId: target.tierId } : {}) },
      // Un doble clic no cobra dos veces; un cambio posterior (la fila ya
      // cambió `updatedAt`) lleva otra clave.
      idempotencyKey: `plan-change:${sub.id}:${sub.planId ?? 'none'}:${target.id}:${sub.updatedAt.getTime()}`,
    });

    await applyMembershipPlanChange(this.prisma, this.publisher, {
      tenantId,
      subscriptionId: sub.id,
      userId,
      fromPlanId: sub.planId,
      toPlan: target,
      stripePriceId: change.priceId ?? priceId,
      currentPeriodEnd: change.currentPeriodEnd ? new Date(change.currentPeriodEnd * 1000) : null,
      via: 'account',
      direction,
    });

    const updated = await this.prisma.modSubscriptionsSubscription.findFirstOrThrow({
      where: { id: sub.id, tenantId },
    });
    const invoice = change.latestInvoice;
    return {
      subscription: updated,
      direction,
      charged:
        proration === 'always_invoice' && invoice && invoice.amountPaid > 0
          ? { amountCents: invoice.amountPaid, currency: invoice.currency || sub.currency }
          : null,
    };
  }

  /** Comprobaciones comunes de la vista previa y del cambio. */
  private async resolveChange(tenantId: string, userId: string, planId: string) {
    const sub = await this.liveMembership(tenantId, userId);
    if (!sub) throw new MembershipPlanChangeNotAllowedError('no_membership');
    const blocker = this.changeBlocker(sub);
    if (blocker) throw new MembershipPlanChangeNotAllowedError(blocker);
    if (sub.planId === planId) throw new MembershipPlanChangeNotAllowedError('same_plan');

    const target = await this.prisma.modSubscriptionsPlan.findFirst({
      where: { id: planId, tenantId, active: true, tierId: { not: null } },
    });
    const targetTier = target?.tierId
      ? await this.prisma.modSubscriptionsTier.findFirst({
          where: { id: target.tierId, tenantId, active: true, isFree: false },
          select: { id: true },
        })
      : null;
    if (!target || !targetTier) {
      throw new MembershipPlanChangeNotAllowedError('target_unavailable');
    }
    if (target.currency !== sub.currency) {
      throw new MembershipPlanChangeNotAllowedError('currency_mismatch');
    }
    const currentPlan = sub.planId
      ? await this.prisma.modSubscriptionsPlan.findFirst({ where: { id: sub.planId, tenantId } })
      : null;
    const current = {
      amountCents: currentPlan?.amountCents ?? sub.unitAmount,
      intervalMonths: currentPlan?.intervalMonths ?? 1,
    };
    return { sub, target, current };
  }
}

export type PlanChangeBlockReason =
  | 'no_membership'
  | 'not_active'
  | 'cancel_scheduled'
  | 'pause_scheduled';

export interface PlanChangeOption {
  planId: string;
  planName: string;
  tierId: string;
  tierName: string;
  intervalMonths: number;
  amountCents: number;
  currency: string;
  compareAtCents: number | null;
  isFeatured: boolean;
  /** Respecto al plan actual, por precio al mes. */
  direction: PlanChangeDirection;
}

export interface PlanChangeOptions {
  /** La membresía viva del alumno, o `null` si no tiene. */
  subscription: {
    id: string;
    status: string;
    planId: string | null;
    planName: string | null;
    tierId: string | null;
    tierName: string | null;
    amountCents: number;
    currency: string;
    intervalMonths: number;
  } | null;
  /** Por qué no puede cambiar ahora (o `null` si puede). */
  blockedReason: PlanChangeBlockReason | null;
  /** Planes a los que puede pasar (vacío en un aula sin niveles). */
  options: PlanChangeOption[];
  /** Nivel gratis del aula: pasar a él es darse de baja. */
  freeTier: { id: string; name: string } | null;
}

export interface PlanChangePreview {
  planId: string;
  direction: PlanChangeDirection;
  trialing: boolean;
  /** Lo que se cobra hoy (unidad mínima). */
  amountDueNow: number;
  /** Lo que queda a favor del alumno para sus próximas facturas. */
  creditCents: number;
  currency: string;
}

export interface PlanChangeResult {
  subscription: MembershipSubscriptionRow;
  direction: PlanChangeDirection;
  /** Lo cobrado hoy al subir, o `null` si no se cobró nada. */
  charged: { amountCents: number; currency: string } | null;
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
 * País del comprador que confirmó Stripe en el checkout del alta
 * (`customer_details.address.country`), en ISO alfa-2 y mayúsculas; `null` si
 * no viene. Para «Ventas»: cada cuota cobrada hereda el de su suscripción.
 */
export function checkoutBuyerCountry(
  session: Pick<Stripe.Checkout.Session, 'customer_details'>,
): string | null {
  const raw = session.customer_details?.address?.country;
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return /^[A-Z]{2}$/.test(code) ? code : null;
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

/**
 * Precios extra por mercado normalizados (moneda en minúsculas, ordenadas) o
 * `null` si no hay ninguno: dos mapas iguales dan el mismo JSON, y así se sabe
 * si hace falta un Price nuevo.
 */
export function normalizeCurrencyOptions(
  options: Readonly<Record<string, number>> | null | undefined,
): Record<string, number> | null {
  const entries = Object.entries(options ?? {})
    .map(([code, amount]) => [code.toLowerCase(), amount] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? Object.fromEntries(entries) : null;
}
