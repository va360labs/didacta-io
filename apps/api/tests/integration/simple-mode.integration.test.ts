/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Modo sencillo contra Postgres REAL conectando como `didacta_app`
 * (NOSUPERUSER, NOBYPASSRLS): el alta en 3 preguntas crea filas reales en el
 * aula A y la RLS impide que el aula B vea ninguna; «Empieza aquí» lee datos
 * reales; publicar sin cobros se niega; y `tenant.simple_mode` nace apagado.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { CoursesService } from '@didacta/mod-courses';
import { CommunityService } from '@didacta/mod-community';
import { BillingService } from '@didacta/mod-billing';
import { MembershipService } from '@didacta/mod-subscriptions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SimpleModeService } from '../../src/simple-mode/simple-mode.service';
import { runAsTenant } from '../../src/tenancy/tenant-context.storage';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

describeWithDb('Modo sencillo — Postgres real como didacta_app (RLS forzada)', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let service: SimpleModeService;
  let tenantA: string;
  let tenantB: string;
  let creadoraA: string;
  let creadoraB: string;

  beforeAll(async () => {
    const prepared = await prepareDidactaAppRole();
    admin = prepared.admin;
    // PrismaService lee DATABASE_URL al construirse: la de didacta_app solo
    // durante el arranque del módulo.
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

    const stamp = Date.now();
    // Sin pedir modo sencillo: así nace cualquier aula que no crea Cloud.
    tenantA = (
      await admin.tenant.create({
        data: { id: randomUUID(), slug: `sencillo-a-${stamp}`, name: `sencillo-a-${stamp}` },
      })
    ).id;
    tenantB = (
      await admin.tenant.create({
        data: { id: randomUUID(), slug: `sencillo-b-${stamp}`, name: `sencillo-b-${stamp}` },
      })
    ).id;
    creadoraA = (
      await admin.user.create({
        data: { tenantId: tenantA, email: `creadora-a-${stamp}@example.test`, status: 'ACTIVE' },
      })
    ).id;
    creadoraB = (
      await admin.user.create({
        data: { tenantId: tenantB, email: `creadora-b-${stamp}@example.test`, status: 'ACTIVE' },
      })
    ).id;
    // Como en Cloud: quien crea el aula es su tenant_admin (no cuenta como alumno).
    const rol = await admin.role.upsert({
      where: { name: 'tenant_admin' },
      create: { name: 'tenant_admin', description: 'Gestor de un tenant', isSystem: true },
      update: {},
    });
    await admin.userRole.createMany({
      data: [
        { userId: creadoraA, roleId: rol.id },
        { userId: creadoraB, roleId: rol.id },
      ],
    });

    // Servicios PÚBLICOS reales de cada módulo sobre el PrismaService de la
    // app (extensión de RLS); el bus de eventos no es parte de esta prueba.
    const ctx = {
      eventBus: { publish: async () => undefined, subscribe: () => () => undefined },
      auditLog: { record: async () => undefined },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    };
    const sinStripe = async () => {
      throw new Error('Stripe no se usa en esta prueba');
    };
    const publisher = { publish: async () => undefined };
    const registry = {
      getCoursesService: () => new CoursesService(prisma as never, ctx as never),
      getCommunityService: () => new CommunityService(prisma as never, ctx as never),
      getMembershipService: () =>
        new MembershipService(prisma as never, sinStripe as never, publisher as never),
      getBillingService: () =>
        new BillingService(
          prisma as never,
          sinStripe as never,
          publisher as never,
          { successUrl: () => '', cancelUrl: () => '' } as never,
        ),
    };
    // Sin cobros de plataforma ni claves: el aula aún no puede cobrar.
    const stripeResolver = { resolve: async () => null };
    service = new SimpleModeService(prisma, registry as never, stripeResolver as never);
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      await admin.tenant.delete({ where: { id: t } }).catch(() => undefined);
    }
    await admin?.$disconnect();
    await closeModule?.();
  });

  it('(d) tenant.simple_mode nace apagado en un aula creada sin pedirlo', async () => {
    const rows = await admin.tenant.findMany({
      where: { id: { in: [tenantA, tenantB] } },
      select: { simpleMode: true },
    });
    expect(rows.map((r) => r.simpleMode)).toEqual([false, false]);
  });

  it('(a) el alta en 3 preguntas crea filas reales en A y la RLS no deja verlas desde B', async () => {
    await runAsTenant(tenantA, () =>
      service.quickStart(
        tenantA,
        { id: creadoraA },
        {
          academyName: 'Taller de Acuarela',
          offer: 'course',
          title: 'Acuarela desde cero',
          amountCents: 4900,
          currency: 'eur',
          locale: 'es',
        },
      ),
    );

    // Lo creado, visto por la base sin RLS (administrador).
    const cursos = await admin.modCoursesCourse.findMany({ where: { tenantId: tenantA } });
    expect(cursos).toHaveLength(1);
    expect(cursos[0]).toMatchObject({
      slug: 'acuarela-desde-cero',
      title: 'Acuarela desde cero',
      status: 'DRAFT',
    });
    expect(await admin.modCoursesModule.count({ where: { tenantId: tenantA } })).toBe(1);
    const espacios = await admin.modCommunitySpace.findMany({
      where: { tenantId: tenantA },
      orderBy: { sortOrder: 'asc' },
    });
    expect(espacios.map((e) => e.slug)).toEqual(['general', 'anuncios', 'preguntas']);
    const posts = await admin.modCommunityPost.findMany({ where: { tenantId: tenantA } });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ authorId: creadoraA, tags: ['general'] });
    const ajustes = await admin.tenantSetting.findMany({
      where: { tenantId: tenantA },
      select: { moduleName: true, key: true },
    });
    expect(ajustes.map((a) => `${a.moduleName}/${a.key}`).sort()).toEqual([
      'onboarding/academy',
      'simple-mode/offer',
      'simple-mode/state',
    ]);
    expect((await admin.tenant.findUnique({ where: { id: tenantA } }))?.name).toBe(
      'Taller de Acuarela',
    );
    expect(
      (await admin.user.findUnique({ where: { id: creadoraA } }))?.onboardingCompletedAt,
    ).toBeInstanceOf(Date);

    // Como didacta_app en el contexto de B: nada de A es visible.
    const desdeB = await runAsTenant(tenantB, async () => ({
      cursos: await prisma.modCoursesCourse.count(),
      espacios: await prisma.modCommunitySpace.count({ where: { tenantId: tenantA } }),
      posts: await prisma.modCommunityPost.count(),
      ajustes: await prisma.tenantSetting.count({ where: { tenantId: tenantA } }),
    }));
    expect(desdeB).toEqual({ cursos: 0, espacios: 0, posts: 0, ajustes: 0 });
    // Control: en el contexto de A, como didacta_app, sí se ven.
    const desdeA = await runAsTenant(tenantA, async () => ({
      cursos: await prisma.modCoursesCourse.count(),
      posts: await prisma.modCommunityPost.count(),
    }));
    expect(desdeA).toEqual({ cursos: 1, posts: 1 });
    // Y el «Empieza aquí» de B no encuentra la oferta de A.
    const vistaB = await runAsTenant(tenantB, () => service.startHere(tenantB));
    expect(vistaB.offer).toBeNull();
    expect(vistaB.quickStartDone).toBe(false);
    // B sigue sin alta (su creadora no se tocó).
    expect(
      (await admin.user.findUnique({ where: { id: creadoraB } }))?.onboardingCompletedAt,
    ).toBeNull();
  });

  it('(b) «Empieza aquí» de A marca los pasos con datos reales', async () => {
    let vista = await runAsTenant(tenantA, () => service.startHere(tenantA));
    expect(Object.fromEntries(vista.steps.map((s) => [s.id, s.done]))).toEqual({
      academy: true,
      course: false,
      price: true,
      payments: false,
      publish: false,
      invite: false,
    });
    expect(vista.offer).toMatchObject({
      kind: 'course',
      amountCents: 4900,
      currency: 'eur',
      courseSlug: 'acuarela-desde-cero',
    });
    expect(vista.salePath).toBeNull();

    // Una lección CON texto completa el paso 2 (fila real, creada como didacta_app).
    const moduleId = (
      await admin.modCoursesModule.findFirstOrThrow({ where: { tenantId: tenantA } })
    ).id;
    await runAsTenant(tenantA, () =>
      new CoursesService(
        prisma as never,
        {
          eventBus: { publish: async () => undefined },
          auditLog: { record: async () => undefined },
          logger: console,
        } as never,
      ).createLesson(tenantA, creadoraA, moduleId, {
        type: 'TEXT',
        title: 'Bienvenida',
        content: { text: 'Hola' },
      } as never),
    );
    vista = await runAsTenant(tenantA, () => service.startHere(tenantA));
    expect(vista.steps.find((s) => s.id === 'course')?.done).toBe(true);
  });

  it('(c) publicar sin cobros conectados se niega con SIMPLE_MODE_PAYMENTS_NOT_READY', async () => {
    await expect(
      runAsTenant(tenantA, () => service.publish(tenantA, creadoraA)),
    ).rejects.toMatchObject({
      code: 'SIMPLE_MODE_PAYMENTS_NOT_READY',
    });
    const curso = await admin.modCoursesCourse.findFirstOrThrow({ where: { tenantId: tenantA } });
    expect(curso.status).toBe('DRAFT');
  });
});
