/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Indexación del aula (`GET /public/seo`) contra Postgres REAL conectando como
 * `didacta_app` (NOSUPERUSER, NOBYPASSRLS): dos aulas con portada pública y
 * cursos a la venta y una con la portada apagada. Cada dominio ve SOLO lo de
 * su aula (también lo que se cachea), el dominio canónico es el primario
 * verificado, un dominio ajeno da 404 y la portada apagada no suelta nada.
 */

import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublicSeoController } from '../../src/public/public-seo.controller';
import { PublicSeoService, type PublicSeoIndexable } from '../../src/public/public-seo.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TenantResolverService } from '../../src/tenancy/tenant-resolver.service';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

describeWithDb('Indexación del aula — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let controller: PublicSeoController;
  const stamp = Date.now();
  const tenants: Record<'a' | 'b' | 'apagada', string> = { a: '', b: '', apagada: '' };
  const host = (k: string) => `seo-${k}-${stamp}.example.com`;
  const local = (k: string) => `seo-${k}-${stamp}.localhost`;

  beforeAll(async () => {
    const prepared = await prepareDidactaAppRole();
    admin = prepared.admin;
    const previousUrl = process.env['DATABASE_URL'];
    const previousMode = process.env['RLS_ENFORCEMENT'];
    process.env['DATABASE_URL'] = prepared.appUrl;
    process.env['RLS_ENFORCEMENT'] = 'on';
    try {
      const moduleRef = await Test.createTestingModule({ imports: [PrismaModule] }).compile();
      await moduleRef.init();
      prisma = moduleRef.get(PrismaService);
      closeModule = () => moduleRef.close();
    } finally {
      process.env['DATABASE_URL'] = previousUrl;
      if (previousMode === undefined) delete process.env['RLS_ENFORCEMENT'];
      else process.env['RLS_ENFORCEMENT'] = previousMode;
    }

    for (const k of ['a', 'b', 'apagada'] as const) {
      tenants[k] = (
        await admin.tenant.create({
          data: {
            id: randomUUID(),
            slug: `seo-${k}-${stamp}`,
            name: `Aula ${k} ${stamp}`,
            // A y B en el modo sencillo (portada encendida por defecto); la
            // tercera en el completo (apagada por defecto).
            simpleMode: k !== 'apagada',
          },
        })
      ).id;
      // Dominio primario verificado + uno secundario (el de laboratorio).
      await admin.tenantDomain.create({
        data: { tenantId: tenants[k], hostname: host(k), isPrimary: true, isVerified: true },
      });
      await admin.tenantDomain.create({
        data: { tenantId: tenants[k], hostname: local(k), isPrimary: false, isVerified: true },
      });
      await admin.modThemingTenantTheme.create({
        data: {
          tenantId: tenants[k],
          about: `Descripción ${k}`,
          socialLinks: [{ kind: 'instagram', url: `https://instagram.com/aula${k}` }],
        },
      });
      const course = await admin.modCoursesCourse.create({
        data: {
          tenantId: tenants[k],
          slug: `curso-${k}-${stamp}`,
          title: `Curso ${k}`,
          status: 'PUBLISHED',
          publishedAt: new Date(),
        },
      });
      await admin.modBillingProduct.create({
        data: {
          tenantId: tenants[k],
          courseId: course.id,
          stripeProductId: `prod_seo_${k}_${stamp}`,
          stripePriceId: `price_seo_${k}_${stamp}`,
          unitAmount: k === 'a' ? 4900 : 2900,
          currency: 'eur',
        },
      });
      // Un borrador con precio: no está a la venta.
      const draft = await admin.modCoursesCourse.create({
        data: { tenantId: tenants[k], slug: `borrador-${k}-${stamp}`, title: `Borrador ${k}` },
      });
      await admin.modBillingProduct.create({
        data: {
          tenantId: tenants[k],
          courseId: draft.id,
          stripeProductId: `prod_seo_d_${k}_${stamp}`,
          stripePriceId: `price_seo_d_${k}_${stamp}`,
          unitAmount: 1900,
          currency: 'eur',
        },
      });
    }

    // El catálogo de mod.billing, a propósito SIN filtrar por aula: lo que
    // impide ver productos de otra es la RLS, no la buena voluntad del módulo.
    const registry = {
      getBillingService: () => ({
        getCatalog: async () => {
          const rows = await prisma.modBillingProduct.findMany({ where: { active: true } });
          return rows.map((p) => ({
            courseId: p.courseId,
            options: [
              {
                id: p.id,
                name: '',
                perks: [],
                unitAmount: p.unitAmount,
                compareAtAmount: null,
                currency: p.currency,
                discountPercent: null,
                isFeatured: false,
              },
            ],
          }));
        },
      }),
    };
    const tenantModules = {
      list: async () => [{ name: 'mod.billing', enabled: true }],
    };
    const service = new PublicSeoService(prisma, registry as never, tenantModules as never);
    controller = new PublicSeoController(new TenantResolverService(prisma), service);
  }, 120_000);

  afterAll(async () => {
    for (const t of Object.values(tenants).filter(Boolean)) {
      await admin.modBillingProduct.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await admin.modCoursesCourse.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await admin.modThemingTenantTheme
        .deleteMany({ where: { tenantId: t } })
        .catch(() => undefined);
      await admin.tenantSetting.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await admin.tenantDomain.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await admin.tenant.delete({ where: { id: t } }).catch(() => undefined);
    }
    await admin?.$disconnect();
    await closeModule?.();
  });

  const req = (h: string, query: Record<string, string> = {}) =>
    ({ headers: { host: 'localhost:4000', 'x-forwarded-host': h }, query }) as never;

  const indexable = (r: unknown): PublicSeoIndexable => {
    const v = r as PublicSeoIndexable;
    if (!v.indexable) throw new Error('se esperaba un aula indexable');
    return v;
  };

  it('cada dominio ve SOLO su aula, también lo que se cachea, y el canónico es el primario', async () => {
    const a = indexable(await controller.publicSeo(req(host('a'), { tenant: tenants.b })));
    const b = indexable(await controller.publicSeo(req(host('b'))));
    // A por su dominio secundario: sale de la caché, sigue siendo A y su
    // canónico es el primario.
    const a2 = indexable(await controller.publicSeo(req(local('a'))));
    for (const [res, k, otra] of [
      [a, 'a', 'b'],
      [b, 'b', 'a'],
      [a2, 'a', 'b'],
    ] as const) {
      expect(res.canonicalHost).toBe(host(k));
      expect(res.academy).toMatchObject({
        name: `Aula ${k} ${stamp}`,
        description: `Descripción ${k}`,
        sameAs: [`https://instagram.com/aula${k}`],
      });
      expect(res.courses.map((c) => c.slug)).toEqual([`curso-${k}-${stamp}`]);
      expect(Number.isNaN(Date.parse(res.home.lastmod))).toBe(false);
      const json = JSON.stringify(res);
      for (const ajeno of [`Aula ${otra}`, `curso-${otra}`, `aula${otra}`, 'borrador']) {
        expect(json).not.toContain(ajeno);
      }
    }
  });

  it('un dominio que no es de ningún aula: 404', async () => {
    await expect(controller.publicSeo(req(`nadie-${stamp}.example.com`))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('el aula del modo completo tiene la portada apagada por defecto: no suelta nada', async () => {
    expect(await controller.publicSeo(req(host('apagada')))).toEqual({ indexable: false });
  });
});
