/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Optional } from '@nestjs/common';
import { MemberRegistrationSettings } from '@didacta/mod-member-registration';
import { MembershipPageInactiveError, stripHtmlToExcerpt } from '@didacta/mod-subscriptions';
import { parseSocialLinks, type SocialLink } from '@didacta/mod-theming';
import { isFrozen } from '../tenancy/signup-freeze';
import { buildCourseSaleChecker, type CourseSaleCatalogDb } from '../modules/course-sale-checker';
import { ModuleRegistryService } from '../modules/module-registry.service';
import { PrismaTenantConfigService } from '../modules/prisma-tenant-config.service';
import { TenantModulesService } from '../modules/tenant-modules.service';
import { PlatformCheckoutGate } from '../modules/payouts/platform-checkout-gate';
import { PrismaService } from '../prisma/prisma.service';
import { isShareableHost, publicName } from '../modules/community/community-sidebar.service';

/**
 * La PÁGINA PÚBLICA de la academia (la raíz del aula para quien entra sin
 * sesión), en UNA lectura: quién es el aula, quién la lleva y cómo se entra.
 *
 * Solo datos PUBLICABLES, todos reales y del aula del dominio:
 *  - marca: nombre, logo, portada, descripción y enlaces (mod.theming), como
 *    la tarjeta de la comunidad;
 *  - miembros: SOLO el número (ni caras ni nombres de alumnos a un visitante),
 *    y solo cuando hay alguien además del equipo;
 *  - quien la lleva: nombre y foto de la primera persona que la administra
 *    (es pública por su rol; nunca un correo);
 *  - próximo directo: título y fecha (nunca el enlace de la sala);
 *  - opciones de acceso: cursos publicados con precio (mod.billing), la
 *    membresía con sus planes (mod.subscriptions) y el acceso gratuito por
 *    solicitud (mod.member-registration) con los cursos que no se venden.
 *
 * Lecturas cross-module de SOLO LECTURA y siempre por `tenant_id` (ADR-016),
 * por el service público del módulo cuando lo hay y bajo el RLS del aula (el
 * controller corre todo dentro de `runAsTenant`). Un módulo apagado en el aula
 * no aporta nada. Si el aula cobra por la plataforma y su cuenta aún no puede
 * vender, o tiene las altas congeladas, no se ofrece nada a la venta: la
 * página no puede llevar a un pago que después fallaría.
 *
 * Caché por aula: la marca se lee en vivo (tres lecturas por clave: quien la
 * cambia en Ajustes la ve al momento); lo demás (catálogo, membresía, cifras,
 * directo) se guarda unos segundos. La clave es SOLO el id del aula, que sale
 * del dominio: no hay parámetro que elija otra.
 */

/** Vida de la caché por aula. */
export const ACADEMY_HOME_CACHE_TTL_MS = 30_000;
/** Tope de aulas en caché (una instancia de Cloud sirve muchas). */
const ACADEMY_HOME_CACHE_MAX_TENANTS = 500;
/** Cursos a la venta que se enseñan (el resto, en el catálogo). */
export const ACADEMY_HOME_MAX_COURSES = 6;
/** Cursos gratuitos que se nombran en la opción gratuita. */
export const ACADEMY_HOME_MAX_FREE_COURSES = 3;

/**
 * El titular por defecto de la membresía (default de la columna). No lo ha
 * escrito nadie y está en español: en un aula en inglés sería un texto ajeno.
 */
const MEMBERSHIP_DEFAULT_HEADLINE = 'Hazte miembro';

/** Equipo del aula: no cuentan para decidir si hay comunidad que enseñar. */
const STAFF_ROLES = ['super_admin', 'tenant_admin', 'formador'];

export interface AcademyHomePrice {
  amountCents: number;
  currency: string;
  compareAtCents: number | null;
  discountPercent: number | null;
}

export interface AcademyHomeCourse {
  slug: string;
  title: string;
  /** Texto plano corto (la descripción es HTML del editor). */
  excerpt: string | null;
  thumbnailUrl: string | null;
  estimatedMinutes: number | null;
  /** La opción destacada (o la primera) del curso. */
  price: AcademyHomePrice;
  /** Cuántas opciones de compra tiene (formatos). */
  optionCount: number;
}

export interface AcademyHomeMembership {
  /** El titular que escribió el aula; `null` si es el de por defecto. */
  headline: string | null;
  subheadline: string | null;
  /** El plan destacado (o el primero). */
  plan: {
    name: string;
    amountCents: number;
    currency: string;
    compareAtCents: number | null;
    intervalMonths: number;
    trialDays: number;
  };
  planCount: number;
  /** Cursos publicados que entran con la membresía (si el aula los enseña). */
  courseCount: number | null;
}

export interface AcademyHomeFree {
  /** Cursos publicados que no se venden: los de cualquier miembro. */
  courses: Array<{ slug: string; title: string; thumbnailUrl: string | null }>;
}

export interface AcademyHomeData {
  academy: {
    name: string;
    logoUrl: string | null;
    logoDisplayMode: 'logo_only' | 'logo_and_name';
    coverUrl: string | null;
    description: string | null;
    /** Dominio público del aula; `null` si solo hay uno local. */
    host: string | null;
    links: SocialLink[];
    brandHue: number | null;
    brandSaturation: number | null;
  };
  /** Número de miembros activos; `null` si no hay nadie además del equipo. */
  members: number | null;
  creator: { name: string; avatarUrl: string | null } | null;
  nextLive: { title: string; startTime: string; durationMinutes: number } | null;
  offers: {
    courses: AcademyHomeCourse[];
    /** Todos los cursos a la venta (si pasan del tope, la página enlaza al catálogo). */
    coursesTotal: number;
    membership: AcademyHomeMembership | null;
    free: AcademyHomeFree | null;
  };
}

/**
 * La descripción pública del aula. Igual que la tarjeta de la comunidad: la
 * descripción propia y, si no la hay, el titular con el que el aula ya se
 * presenta en su acceso. La comparte la portada con lo que se da a los
 * buscadores (`public-seo.service.ts`): una sola regla para las dos.
 */
export function academyDescription(
  theme: { about?: string | null; signinHeadline?: string | null } | null | undefined,
): string | null {
  const description = theme?.about?.trim() || theme?.signinHeadline?.trim();
  return description ? description : null;
}

/** Lo del aula que se cachea (todo menos la marca). */
type CachedPart = Omit<AcademyHomeData, 'academy'>;

interface CacheEntry {
  at: number;
  value: CachedPart;
}

@Injectable()
export class AcademyHomeService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly registration: MemberRegistrationSettings;
  /** Reloj; los tests de la caché lo sustituyen. */
  clock: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
    private readonly tenantModules: TenantModulesService,
    tenantConfig: PrismaTenantConfigService,
    // Solo existe con los cobros de plataforma encendidos (Didacta Cloud).
    @Optional() private readonly payoutsGate?: PlatformCheckoutGate,
  ) {
    this.registration = new MemberRegistrationSettings(tenantConfig);
  }

  async get(tenantId: string): Promise<AcademyHomeData> {
    const [academy, part] = await Promise.all([this.academy(tenantId), this.cached(tenantId)]);
    return { academy, ...part };
  }

  /** Olvida la caché de un aula (o de todas). */
  invalidate(tenantId?: string): void {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }

  private async cached(tenantId: string): Promise<CachedPart> {
    const now = this.clock();
    const hit = this.cache.get(tenantId);
    if (hit && now - hit.at < ACADEMY_HOME_CACHE_TTL_MS) return hit.value;
    const value = await this.build(tenantId);
    if (this.cache.size >= ACADEMY_HOME_CACHE_MAX_TENANTS) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.delete(tenantId);
    this.cache.set(tenantId, { at: now, value });
    return value;
  }

  private async build(tenantId: string): Promise<CachedPart> {
    const enabled = await this.enabledModules(tenantId);
    const [members, creator, nextLive, offers] = await Promise.all([
      this.members(tenantId),
      this.creator(tenantId),
      enabled.has('mod.zoom-live') ? this.nextLive(tenantId) : Promise.resolve(null),
      this.offers(tenantId, enabled),
    ]);
    return { members, creator, nextLive, offers };
  }

  private async enabledModules(tenantId: string): Promise<Set<string>> {
    const list = await this.tenantModules.list(tenantId);
    return new Set(list.filter((m) => m.enabled).map((m) => m.name));
  }

  private async academy(tenantId: string): Promise<AcademyHomeData['academy']> {
    const [tenant, theme, domain] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      this.prisma.modThemingTenantTheme.findUnique({
        where: { tenantId },
        select: {
          logoUrl: true,
          logoDisplayMode: true,
          signinHeadline: true,
          about: true,
          coverUrl: true,
          socialLinks: true,
          brandHue: true,
          brandSaturation: true,
        },
      }),
      this.prisma.tenantDomain.findFirst({
        where: { tenantId, isPrimary: true, surface: 'APP' },
        select: { hostname: true },
      }),
    ]);
    return {
      name: tenant?.name ?? '',
      logoUrl: theme?.logoUrl ?? null,
      logoDisplayMode: theme?.logoDisplayMode === 'logo_and_name' ? 'logo_and_name' : 'logo_only',
      coverUrl: theme?.coverUrl ?? null,
      description: academyDescription(theme),
      host: domain && isShareableHost(domain.hostname) ? domain.hostname : null,
      links: parseSocialLinks(theme?.socialLinks),
      brandHue: theme?.brandHue ?? null,
      brandSaturation: theme?.brandSaturation ?? null,
    };
  }

  /**
   * Miembros activos del aula. Solo el número, y solo si hay alguien que no
   * sea del equipo: un aula recién creada no presume de «1 miembro» (que es
   * quien la creó).
   */
  private async members(tenantId: string): Promise<number | null> {
    const active = { tenantId, status: 'ACTIVE' as const, deletedAt: null };
    const [total, students] = await Promise.all([
      this.prisma.user.count({ where: active }),
      this.prisma.user.count({
        where: { ...active, NOT: { roles: { some: { role: { name: { in: STAFF_ROLES } } } } } },
      }),
    ]);
    return students > 0 ? total : null;
  }

  /**
   * Quien lleva el aula: la primera persona que la administra (`tenant_admin`;
   * si no hay, `super_admin`, el caso de una instalación propia). Su nombre
   * público y su foto; sin nombre publicable, no se enseña nada.
   */
  private async creator(tenantId: string): Promise<AcademyHomeData['creator']> {
    for (const role of ['tenant_admin', 'super_admin']) {
      const u = await this.prisma.user.findFirst({
        where: {
          tenantId,
          status: 'ACTIVE',
          deletedAt: null,
          roles: { some: { role: { name: role } } },
        },
        orderBy: { createdAt: 'asc' },
        select: { name: true, avatarUrl: true },
      });
      if (!u) continue;
      const name = publicName(u.name);
      return name ? { name, avatarUrl: u.avatarUrl ?? null } : null;
    }
    return null;
  }

  /** El próximo directo (o el que está en marcha): título y fecha, sin enlace. */
  private async nextLive(tenantId: string): Promise<AcademyHomeData['nextLive']> {
    const now = this.clock();
    // Margen de un día hacia atrás para encontrar el que está en marcha; el
    // filtro fino (que no haya terminado) va abajo con su duración.
    const rows = await this.prisma.modZoomSession.findMany({
      where: {
        tenantId,
        status: { in: ['SCHEDULED', 'STARTED'] },
        startTime: { gte: new Date(now - 24 * 60 * 60_000) },
      },
      orderBy: { startTime: 'asc' },
      take: 10,
      select: { topic: true, startTime: true, durationMinutes: true },
    });
    const next = rows.find((r) => r.startTime.getTime() + r.durationMinutes * 60_000 > now);
    return next
      ? {
          title: next.topic,
          startTime: next.startTime.toISOString(),
          durationMinutes: next.durationMinutes,
        }
      : null;
  }

  private async offers(tenantId: string, enabled: Set<string>): Promise<AcademyHomeData['offers']> {
    const none: AcademyHomeData['offers'] = {
      courses: [],
      coursesTotal: 0,
      membership: null,
      free: null,
    };
    // Altas congeladas: nadie nuevo puede entrar, así que no se ofrece nada.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { signupsFrozenAt: true, signupsFrozenReason: true },
    });
    if (isFrozen(tenant)) return none;

    // Cobros de plataforma sin terminar de conectar: nada a la venta (el
    // catálogo y /join tampoco ofrecen nada). El acceso gratuito sí sigue.
    const checkout = await this.payoutsGate?.publicCheckoutInfo(tenantId);
    const canSell = !checkout?.blockedReason;

    const [forSale, membership, free] = await Promise.all([
      canSell && enabled.has('mod.billing') ? this.coursesForSale(tenantId) : Promise.resolve(null),
      canSell && enabled.has('mod.subscriptions')
        ? this.membership(tenantId)
        : Promise.resolve(null),
      enabled.has('mod.member-registration') ? this.free(tenantId) : Promise.resolve(null),
    ]);
    return {
      courses: forSale?.courses ?? [],
      coursesTotal: forSale?.total ?? 0,
      membership,
      free,
    };
  }

  private async coursesForSale(
    tenantId: string,
  ): Promise<{ courses: AcademyHomeCourse[]; total: number }> {
    const offers = await this.registry.getBillingService().getCatalog(tenantId);
    if (offers.length === 0) return { courses: [], total: 0 };
    const optionsByCourse = new Map(offers.map((o) => [o.courseId, o.options]));
    const rows = await this.prisma.modCoursesCourse.findMany({
      where: {
        id: { in: [...optionsByCourse.keys()] },
        tenantId,
        status: 'PUBLISHED',
        deletedAt: null,
      },
      orderBy: { publishedAt: 'desc' },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        thumbnailUrl: true,
        estimatedMinutes: true,
      },
    });
    const courses: AcademyHomeCourse[] = [];
    for (const c of rows) {
      const options = optionsByCourse.get(c.id) ?? [];
      const option = options.find((o) => o.isFeatured) ?? options[0];
      if (!option) continue;
      courses.push({
        slug: c.slug,
        title: c.title,
        excerpt: stripHtmlToExcerpt(c.description),
        thumbnailUrl: c.thumbnailUrl,
        estimatedMinutes: c.estimatedMinutes,
        price: {
          amountCents: option.unitAmount,
          currency: option.currency,
          compareAtCents: option.compareAtAmount,
          discountPercent: option.discountPercent,
        },
        optionCount: options.length,
      });
    }
    return { courses: courses.slice(0, ACADEMY_HOME_MAX_COURSES), total: courses.length };
  }

  private async membership(tenantId: string): Promise<AcademyHomeMembership | null> {
    let page;
    try {
      page = await this.registry.getMembershipService().getPublicPage(tenantId);
    } catch (err) {
      // Página de membresía apagada: no es una opción de acceso.
      if (err instanceof MembershipPageInactiveError) return null;
      throw err;
    }
    const plan = page.plans.find((p) => p.isFeatured) ?? page.plans[0];
    if (!plan) return null;
    const headline = page.headline?.trim();
    return {
      headline: headline && headline !== MEMBERSHIP_DEFAULT_HEADLINE ? headline : null,
      subheadline: page.subheadline?.trim() || null,
      plan: {
        name: plan.name,
        amountCents: plan.amountCents,
        currency: plan.currency,
        compareAtCents: plan.compareAtCents,
        intervalMonths: plan.intervalMonths,
        trialDays: plan.trialDays,
      },
      planCount: page.plans.length,
      courseCount: page.courses.length > 0 ? page.courses.length : null,
    };
  }

  /**
   * Acceso gratuito: solo si el aula admite solicitudes de alta (la única
   * puerta pública para crear una cuenta sin pagar) y está operativa. Nombra
   * los cursos publicados que no se venden: en ellos se matricula cualquier
   * miembro (`LearningService.isFreeCourse`, misma regla).
   */
  private async free(tenantId: string): Promise<AcademyHomeFree | null> {
    const policy = await this.registration.resolveEffectivePolicy(tenantId);
    if (!policy.enabled || !policy.operational) return null;
    const published = await this.prisma.modCoursesCourse.findMany({
      where: { tenantId, status: 'PUBLISHED', deletedAt: null, externalPurchaseUrl: null },
      orderBy: { publishedAt: 'desc' },
      take: 20,
      select: { id: true, slug: true, title: true, thumbnailUrl: true },
    });
    const isSold = buildCourseSaleChecker(() => this.prisma as unknown as CourseSaleCatalogDb);
    const courses: AcademyHomeFree['courses'] = [];
    for (const c of published) {
      if (courses.length >= ACADEMY_HOME_MAX_FREE_COURSES) break;
      if (await isSold(tenantId, c.id)) continue;
      courses.push({ slug: c.slug, title: c.title, thumbnailUrl: c.thumbnailUrl });
    }
    return { courses };
  }
}
