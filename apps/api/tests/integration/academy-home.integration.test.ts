/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Página pública de la academia contra Postgres REAL conectando como
 * `didacta_app` (NOSUPERUSER, NOBYPASSRLS): dos aulas con marca, cursos a la
 * venta, directos y miembros; cada dominio ve solo lo de su aula (también lo
 * que se cachea), un dominio ajeno da 404 y el ajuste apagado no suelta nada.
 */

import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { MembershipPageInactiveError } from '@didacta/mod-subscriptions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcademyHomeController } from '../../src/public/academy-home.controller';
import { AcademyHomeService } from '../../src/public/academy-home.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TenantResolverService } from '../../src/tenancy/tenant-resolver.service';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

describeWithDb('Página pública de la academia — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let controller: AcademyHomeController;
  const stamp = Date.now();
  const tenants: Record<'a' | 'b' | 'apagada', string> = { a: '', b: '', apagada: '' };
  const host = (k: string) => `home-${k}-${stamp}.example.com`;

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
            slug: `home-${k}-${stamp}`,
            name: `Aula ${k} ${stamp}`,
            // A y B en el modo sencillo (portada encendida por defecto); la
            // tercera en el completo (apagada por defecto).
            simpleMode: k !== 'apagada',
          },
        })
      ).id;
      await admin.tenantDomain.create({
        data: { tenantId: tenants[k], hostname: host(k), isPrimary: true, isVerified: true },
      });
    }
    const rol = await admin.role.upsert({
      where: { name: 'tenant_admin' },
      create: { name: 'tenant_admin', description: 'Gestor de un tenant', isSystem: true },
      update: {},
    });
    for (const k of ['a', 'b'] as const) {
      const duena = await admin.user.create({
        data: {
          tenantId: tenants[k],
          email: `duena-${k}-${stamp}@example.com`,
          name: `Dueña ${k.toUpperCase()}`,
          status: 'ACTIVE',
          avatarUrl: `https://cdn.example.com/duena-${k}.png`,
        },
      });
      await admin.userRole.create({ data: { userId: duena.id, roleId: rol.id } });
      await admin.user.create({
        data: {
          tenantId: tenants[k],
          email: `alumna-${k}-${stamp}@example.com`,
          name: `Alumna ${k.toUpperCase()}`,
          status: 'ACTIVE',
        },
      });
      await admin.modThemingTenantTheme.create({
        data: { tenantId: tenants[k], about: `Descripción ${k}`, coverUrl: `/cover-${k}.jpg` },
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
          stripeProductId: `prod_${k}_${stamp}`,
          stripePriceId: `price_${k}_${stamp}`,
          unitAmount: k === 'a' ? 4900 : 2900,
          currency: 'eur',
        },
      });
      await admin.modZoomSession.create({
        data: {
          tenantId: tenants[k],
          topic: `Directo ${k}`,
          startTime: new Date(Date.now() + 86_400_000),
          durationMinutes: 60,
          timezone: 'Europe/Madrid',
          hostEmail: `duena-${k}-${stamp}@example.com`,
          joinUrl: `https://zoom.example.com/j/${k}`,
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
      getMembershipService: () => ({
        getPublicPage: async () => {
          throw new MembershipPageInactiveError();
        },
      }),
    };
    const tenantModules = {
      list: async () =>
        ['mod.billing', 'mod.subscriptions', 'mod.zoom-live'].map((name) => ({
          name,
          enabled: true,
        })),
    };
    const service = new AcademyHomeService(
      prisma,
      registry as never,
      tenantModules as never,
      { get: async () => undefined } as never,
    );
    controller = new AcademyHomeController(new TenantResolverService(prisma), prisma, service);
  }, 120_000);

  afterAll(async () => {
    for (const t of Object.values(tenants).filter(Boolean)) {
      await admin.modZoomSession.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await admin.modBillingProduct.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await admin.modCoursesCourse.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await admin.modThemingTenantTheme
        .deleteMany({ where: { tenantId: t } })
        .catch(() => undefined);
      await admin.tenantSetting.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await admin.userRole.deleteMany({ where: { user: { tenantId: t } } }).catch(() => undefined);
      await admin.user.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await admin.tenantDomain.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await admin.tenant.delete({ where: { id: t } }).catch(() => undefined);
    }
    await admin?.$disconnect();
    await closeModule?.();
  });

  const req = (h: string, query: Record<string, string> = {}) =>
    ({ headers: { host: 'localhost:4000', 'x-forwarded-host': h }, query }) as never;

  it('cada dominio ve SOLO su aula, también lo que se cachea', async () => {
    const a = await controller.academyHome(req(host('a'), { tenant: tenants.b }));
    const b = await controller.academyHome(req(host('b')));
    // Otra vez A: ahora sale de la caché y sigue siendo de A.
    const a2 = await controller.academyHome(req(host('a')));
    for (const [res, k, otra] of [
      [a, 'a', 'b'],
      [b, 'b', 'a'],
      [a2, 'a', 'b'],
    ] as const) {
      if (!res.enabled) throw new Error('portada apagada');
      expect(res.academy).toMatchObject({
        name: `Aula ${k} ${stamp}`,
        description: `Descripción ${k}`,
        host: host(k),
      });
      expect(res.members).toBe(2);
      expect(res.creator).toEqual({
        name: `Dueña ${k.toUpperCase()}`,
        avatarUrl: `https://cdn.example.com/duena-${k}.png`,
      });
      expect(res.nextLive?.title).toBe(`Directo ${k}`);
      expect(res.offers.courses.map((c) => c.slug)).toEqual([`curso-${k}-${stamp}`]);
      const json = JSON.stringify(res);
      for (const ajeno of [
        `Aula ${otra}`,
        `Descripción ${otra}`,
        `curso-${otra}`,
        `Directo ${otra}`,
        `Dueña ${otra.toUpperCase()}`,
        'zoom.example.com',
        'Alumna',
        '@example.com',
      ]) {
        expect(json).not.toContain(ajeno);
      }
    }
  });

  it('un dominio que no es de ningún aula: 404', async () => {
    await expect(controller.academyHome(req(`nadie-${stamp}.example.com`))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('el aula del modo completo la tiene apagada por defecto y no suelta nada', async () => {
    expect(await controller.academyHome(req(host('apagada')))).toEqual({ enabled: false });
  });

  it('apagarla en un aula sencilla corta la portada al momento', async () => {
    await admin.tenantSetting.create({
      data: {
        tenantId: tenants.b,
        moduleName: 'academy',
        key: 'public-home',
        valueJson: { enabled: false },
        isSecret: false,
      },
    });
    expect(await controller.academyHome(req(host('b')))).toEqual({ enabled: false });
    // A no se entera: su ajuste es suyo.
    expect((await controller.academyHome(req(host('a')))).enabled).toBe(true);
  });
});
