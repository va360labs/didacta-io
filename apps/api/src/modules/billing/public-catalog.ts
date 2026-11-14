/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { CourseOfferOption } from '@didacta/mod-billing';
import type { PlatformCheckoutGate, PublicCheckoutInfo } from '../payouts/platform-checkout-gate';

/**
 * Los cursos que un visitante puede COMPRAR en un aula: publicados, sin borrar
 * y con al menos una opción de compra activa en mod.billing. Si el aula cobra
 * por la plataforma y su cuenta aún no puede vender, ninguno.
 *
 * Una sola regla para todo lo que enseña la venta de cursos sueltos: el
 * catálogo público (`/catalog`), su ficha (`/catalog/<slug>`) y lo que se
 * ofrece a los buscadores (`GET /public/seo`, de donde salen el sitemap y la
 * decisión de indexar una ficha). Antes vivía dentro del controlador del
 * catálogo; con dos copias, el sitemap podría acabar listando una ficha que el
 * catálogo ya no enseña, o al revés.
 *
 * Lectura first-party de mod.courses con `tenant_id` (ADR-016): el paquete de
 * billing no toca tablas de otros módulos, el cruce lo hace el host. Corre bajo
 * el RLS del aula: el caller la envuelve en `runAsTenant`.
 */

/** Lo que se lee de mod.courses de cada curso a la venta. */
export interface CourseForSaleRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  category: string | null;
  estimatedMinutes: number | null;
  updatedAt: Date;
}

export interface CourseForSale {
  course: CourseForSaleRow;
  options: CourseOfferOption[];
}

export interface CoursesForSale {
  /**
   * Lo que dice la puerta de cobros de plataforma (solo con el modo plataforma
   * encendido; `undefined` en Community). Con `blockedReason`, `courses` va vacío.
   */
  checkoutInfo: PublicCheckoutInfo | undefined;
  /** En el orden del catálogo: los publicados más recientes primero. */
  courses: CourseForSale[];
}

/** Lo mínimo de Prisma: los cursos del aula. */
export interface CoursesForSaleDb {
  modCoursesCourse: {
    findMany(args: {
      where: {
        id: { in: string[] };
        tenantId: string;
        status: 'PUBLISHED';
        deletedAt: null;
      };
      orderBy: { publishedAt: 'desc' };
      select: Record<keyof CourseForSaleRow, true>;
    }): Promise<CourseForSaleRow[]>;
  };
}

export interface CoursesForSaleDeps {
  prisma: CoursesForSaleDb;
  billing: {
    getCatalog(
      tenantId: string,
    ): Promise<Array<{ courseId: string; options: CourseOfferOption[] }>>;
  };
  payoutsGate?: Pick<PlatformCheckoutGate, 'publicCheckoutInfo'>;
}

export async function listCoursesForSale(
  deps: CoursesForSaleDeps,
  tenantId: string,
): Promise<CoursesForSale> {
  // Cobros de plataforma sin terminar de conectar: no se ofrece nada.
  const checkoutInfo = await deps.payoutsGate?.publicCheckoutInfo(tenantId);
  if (checkoutInfo?.blockedReason) return { checkoutInfo, courses: [] };

  const offers = await deps.billing.getCatalog(tenantId);
  if (offers.length === 0) return { checkoutInfo, courses: [] };

  const optionsByCourse = new Map(offers.map((o) => [o.courseId, o.options]));
  const rows = await deps.prisma.modCoursesCourse.findMany({
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
      category: true,
      estimatedMinutes: true,
      updatedAt: true,
    },
  });
  return {
    checkoutInfo,
    courses: rows.map((course) => ({ course, options: optionsByCourse.get(course.id) ?? [] })),
  };
}
