/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Optional } from '@nestjs/common';
import { parseSocialLinks } from '@didacta/mod-theming';
import {
  academyLocale,
  type AcademyDefaultsPrisma,
  type AcademyLocale,
} from '../common/academy-defaults';
import { resolvePublicHome, type PublicHomeReader } from '../common/academy-public-home';
import { listCoursesForSale, type CoursesForSaleDb } from '../modules/billing/public-catalog';
import { isShareableHost } from '../modules/community/community-sidebar.service';
import { ModuleRegistryService } from '../modules/module-registry.service';
import { PlatformCheckoutGate } from '../modules/payouts/platform-checkout-gate';
import { TenantModulesService } from '../modules/tenant-modules.service';
import { PrismaService } from '../prisma/prisma.service';
import { isFrozen } from '../tenancy/signup-freeze';
import { academyDescription } from './academy-home.service';

/**
 * Lo que un aula enseña a los BUSCADORES (decisión de Valentín, ADR en Notion
 * «Indexar la portada y las fichas de venta»): qué se indexa, bajo qué dominio
 * y con qué datos. Lo consume el web para `robots.txt`, `sitemap.xml`, el
 * `noindex` y el JSON-LD de la portada (`/`), del catálogo (`/catalog`) y de
 * cada ficha de venta (`/catalog/<slug>`).
 *
 * La regla, de una pieza:
 *  - el aula es indexable SOLO con su «Página pública de la academia»
 *    encendida (el mismo ajuste que decide si `/` es la portada). Apagada, no
 *    sale nada más que `{ indexable: false }` y el web lo cierra todo;
 *  - una ficha es indexable si su curso está a la venta según la MISMA regla
 *    que el catálogo (`listCoursesForSale`), con mod.billing encendido y las
 *    altas abiertas (con las altas congeladas la portada no ofrece nada y la
 *    compra fallaría: no se lleva a nadie desde Google a un pago imposible);
 *  - el dominio canónico es el PRIMARIO y verificado del aula, si es uno que
 *    se pueda compartir (no `localhost`, ni una IP, ni `.test`). Sin él, el
 *    web usa el de la petición.
 *
 * Solo datos reales y publicables: los mismos que ya enseña la portada (nombre,
 * descripción, logo, portada y enlaces), más las fechas de última modificación
 * de lo que se lista. Ninguna fila de alumnos, ninguna cifra.
 *
 * Caché por aula (la clave es SOLO el id, que sale del dominio): el sitemap lo
 * piden los buscadores y no tiene que costar una ronda de consultas cada vez.
 */

/** Vida de la caché por aula. Apagar la portada se nota en, como mucho, esto. */
export const PUBLIC_SEO_CACHE_TTL_MS = 60_000;
/** Tope de aulas en caché (una instancia de Cloud sirve muchas). */
const PUBLIC_SEO_CACHE_MAX_TENANTS = 500;

/**
 * Enlaces que NO identifican al aula para `sameAs`: un `wa.me/<número>` es un
 * teléfono y un `chat.whatsapp.com/…` una invitación a un grupo, no una página
 * que diga quién es.
 */
const NOT_SAME_AS = new Set(['whatsapp']);

export interface PublicSeoCourse {
  slug: string;
  /** Última modificación (ISO): el curso o su precio, lo que cambiara después. */
  lastmod: string;
}

export interface PublicSeoIndexable {
  indexable: true;
  /** Dominio canónico del aula; `null` = el de la petición. */
  canonicalHost: string | null;
  /** Idioma del aula (`es` | `en` | `pt`). */
  locale: AcademyLocale;
  academy: {
    name: string;
    description: string | null;
    logoUrl: string | null;
    coverUrl: string | null;
    /** Perfiles del aula en otras webs (para `sameAs`), en su orden. */
    sameAs: string[];
  };
  /** Última modificación de la portada (ISO). */
  home: { lastmod: string };
  /** Fichas de venta indexables, en el orden del catálogo. */
  courses: PublicSeoCourse[];
}

export type PublicSeoResponse = { indexable: false } | PublicSeoIndexable;

interface CacheEntry {
  at: number;
  value: PublicSeoResponse;
}

const latest = (dates: Array<Date | null | undefined>): Date =>
  new Date(
    Math.max(0, ...dates.filter((d): d is Date => d instanceof Date).map((d) => d.getTime())),
  );

@Injectable()
export class PublicSeoService {
  private readonly cache = new Map<string, CacheEntry>();
  /** Reloj; los tests de la caché lo sustituyen. */
  clock: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModuleRegistryService,
    private readonly tenantModules: TenantModulesService,
    // Solo existe con los cobros de plataforma encendidos (Didacta Cloud).
    @Optional() private readonly payoutsGate?: PlatformCheckoutGate,
  ) {}

  async get(tenantId: string): Promise<PublicSeoResponse> {
    const now = this.clock();
    const hit = this.cache.get(tenantId);
    if (hit && now - hit.at < PUBLIC_SEO_CACHE_TTL_MS) return hit.value;
    const value = await this.build(tenantId);
    if (this.cache.size >= PUBLIC_SEO_CACHE_MAX_TENANTS) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.delete(tenantId);
    this.cache.set(tenantId, { at: now, value });
    return value;
  }

  /** Olvida la caché de un aula (o de todas). */
  invalidate(tenantId?: string): void {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }

  private async build(tenantId: string): Promise<PublicSeoResponse> {
    const home = await resolvePublicHome(this.prisma as unknown as PublicHomeReader, tenantId);
    if (!home.enabled) return { indexable: false };

    const [tenant, theme, domain, locale, courses] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, updatedAt: true, signupsFrozenAt: true, signupsFrozenReason: true },
      }),
      this.prisma.modThemingTenantTheme.findUnique({
        where: { tenantId },
        select: {
          logoUrl: true,
          about: true,
          signinHeadline: true,
          coverUrl: true,
          socialLinks: true,
          updatedAt: true,
        },
      }),
      this.prisma.tenantDomain.findFirst({
        where: { tenantId, isPrimary: true, isVerified: true, surface: 'APP' },
        select: { hostname: true },
      }),
      academyLocale(this.prisma as unknown as AcademyDefaultsPrisma, tenantId),
      this.coursesForSale(tenantId),
    ]);
    // Sin nombre no hay nada que enseñar en un buscador (aula a medio crear).
    if (!tenant?.name.trim()) return { indexable: false };
    const live = isFrozen(tenant) ? [] : courses;

    return {
      indexable: true,
      canonicalHost: domain && isShareableHost(domain.hostname) ? domain.hostname : null,
      locale,
      academy: {
        name: tenant.name.trim(),
        description: academyDescription(theme),
        logoUrl: theme?.logoUrl ?? null,
        coverUrl: theme?.coverUrl ?? null,
        sameAs: parseSocialLinks(theme?.socialLinks)
          .filter((l) => !NOT_SAME_AS.has(l.kind))
          .map((l) => l.url),
      },
      home: {
        lastmod: latest([
          tenant.updatedAt,
          theme?.updatedAt,
          ...live.map((c) => new Date(c.lastmod)),
        ]).toISOString(),
      },
      courses: live,
    };
  }

  /**
   * Las fichas a la venta, con la fecha de lo último que cambió en cada una: el
   * curso (título, descripción, portada) o una de sus opciones de compra (el
   * precio también se ve en la ficha).
   */
  private async coursesForSale(tenantId: string): Promise<PublicSeoCourse[]> {
    const modules = await this.tenantModules.list(tenantId);
    if (!modules.some((m) => m.name === 'mod.billing' && m.enabled)) return [];
    const { courses } = await listCoursesForSale(
      {
        prisma: this.prisma as unknown as CoursesForSaleDb,
        billing: this.registry.getBillingService(),
        payoutsGate: this.payoutsGate,
      },
      tenantId,
    );
    const forSale = courses.filter((c) => c.options.length > 0);
    if (forSale.length === 0) return [];
    const products = await this.prisma.modBillingProduct.findMany({
      where: { tenantId, active: true, courseId: { in: forSale.map((c) => c.course.id) } },
      select: { courseId: true, updatedAt: true },
    });
    return forSale.map(({ course }) => ({
      slug: course.slug,
      lastmod: latest([
        course.updatedAt,
        ...products.filter((p) => p.courseId === course.id).map((p) => p.updatedAt),
      ]).toISOString(),
    }));
  }
}
