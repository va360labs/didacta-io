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
import { revisar } from '../../scripts/activar-modo-sencillo-cloud';
import { CoursesService } from '@didacta/mod-courses';
import { CommunityService } from '@didacta/mod-community';
import { BillingService } from '@didacta/mod-billing';
import { MembershipService } from '@didacta/mod-subscriptions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SimpleModeService } from '../../src/simple-mode/simple-mode.service';
import { runAsTenant } from '../../src/tenancy/tenant-context.storage';
import { ADMIN_DATABASE_URL, didactaAppUrl, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

describeWithDb('Modo sencillo — Postgres real como didacta_app (RLS forzada)', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let service: SimpleModeService;
  let tenantA: string;
  let tenantB: string;
  let tenantC: string;
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
    for (const t of [tenantA, tenantB, tenantC].filter(Boolean)) {
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
    // El alta en 3 preguntas guarda también el idioma del aula como ajuste
    // (`academy/locale`): manda sobre la deducción en el resto del producto.
    expect(ajustes.map((a) => `${a.moduleName}/${a.key}`).sort()).toEqual([
      'academy/locale',
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

  /**
   * (e) Aula de Cloud que ya vendía en modo completo antes de existir el modo
   * sencillo: curso publicado con precio, una alumna y una venta. Ni rastro
   * del modo sencillo en sus ajustes.
   */
  async function aulaQueYaVendia(): Promise<string> {
    const stamp = Date.now();
    const t = (
      await admin.tenant.create({
        data: { id: randomUUID(), slug: `cloud-vieja-${stamp}`, name: 'Escuela de Cerámica' },
      })
    ).id;
    const curso = await admin.modCoursesCourse.create({
      data: { tenantId: t, slug: 'torno-basico', title: 'Torno básico', status: 'PUBLISHED' },
    });
    const modulo = await admin.modCoursesModule.create({
      data: { tenantId: t, courseId: curso.id, title: 'Primeros pasos', position: 0 } as never,
    });
    await admin.modCoursesLesson.create({
      data: {
        tenantId: t,
        moduleId: modulo.id,
        type: 'TEXT',
        title: 'Bienvenida',
        content: { text: 'Hola' },
        position: 0,
      } as never,
    });
    const producto = await admin.modBillingProduct.create({
      data: {
        tenantId: t,
        courseId: curso.id,
        stripeProductId: `prod_${stamp}`,
        stripePriceId: `price_${stamp}`,
        unitAmount: 8900,
        currency: 'eur',
      },
    });
    const alumna = await admin.user.create({
      data: { tenantId: t, email: `alumna-${stamp}@example.test`, status: 'ACTIVE' },
    });
    await admin.modBillingOrder.create({
      data: {
        tenantId: t,
        userId: alumna.id,
        productId: producto.id,
        courseId: curso.id,
        stripeSessionId: `cs_${stamp}`,
        status: 'COMPLETED',
        amountPaid: 8900,
        currency: 'eur',
        completedAt: new Date(),
      },
    });
    await admin.auditLog.create({
      data: {
        tenantId: t,
        action: 'admin.tenant.created',
        resourceType: 'tenant',
        resourceId: t,
        metadata: { slug: `cloud-vieja-${stamp}`, actorKind: 'provisioning' },
      },
    });
    return t;
  }

  it('(e) un aula de Cloud que ya vendía: Empieza aquí deduce la oferta y no empieza de cero; B no ve nada', async () => {
    tenantC = await aulaQueYaVendia();
    const conCobros = new SimpleModeService(
      prisma,
      (service as unknown as { registry: never }).registry,
      { resolve: async () => ({ secretKey: 'sk_test_x' }) } as never,
    );

    const vista = await runAsTenant(tenantC, () => conCobros.startHere(tenantC));
    expect(vista.steps.every((s) => s.done)).toBe(true);
    expect(vista.offer).toMatchObject({
      kind: 'course',
      amountCents: 8900,
      courseSlug: 'torno-basico',
    });
    expect(vista.salePath).toBe('/catalog/torno-basico');
    expect(vista.sales.count).toBe(1);
    expect(vista.students).toBe(1);

    // Aislamiento: desde B (vacía) no se deduce la oferta de C ni se la adopta.
    const vistaB = await runAsTenant(tenantB, () => conCobros.startHere(tenantB));
    expect(vistaB.offer).toBeNull();
    expect(vistaB.sales.count).toBe(0);
    expect(await runAsTenant(tenantB, () => conCobros.adoptExisting(tenantB, creadoraB))).toEqual({
      adopted: false,
    });

    // C se adopta (sin alta en 3 preguntas) y deja el asistente por terminado.
    const creadoraC = (
      await admin.user.create({
        data: {
          tenantId: tenantC,
          email: `creadora-c-${Date.now()}@example.test`,
          status: 'ACTIVE',
        },
      })
    ).id;
    expect(await runAsTenant(tenantC, () => conCobros.adoptExisting(tenantC, creadoraC))).toEqual({
      adopted: true,
    });
    const asistente = await admin.tenantSetting.findFirst({
      where: { tenantId: tenantC, moduleName: 'onboarding', key: 'academy' },
    });
    expect((asistente?.valueJson as { completedAt?: string }).completedAt).toEqual(
      expect.any(String),
    );
    expect(await admin.modCoursesCourse.count({ where: { tenantId: tenantC } })).toBe(1);
    expect((await admin.tenant.findUnique({ where: { id: tenantC } }))?.name).toBe(
      'Escuela de Cerámica',
    );
  });

  it('(f) el script de Cloud, como didacta_app, solo señala las aulas con la marca de provisioning', async () => {
    const app = new PrismaClient({
      datasources: { db: { url: didactaAppUrl(ADMIN_DATABASE_URL!) } },
    });
    try {
      const [c] = await revisar(app, tenantC);
      expect(c).toMatchObject({ id: tenantC, creadaPorCloud: true, simpleMode: false });
      const [a] = await revisar(app, tenantA);
      expect(a).toMatchObject({ id: tenantA, creadaPorCloud: false });
      const [b] = await revisar(app, tenantB);
      expect(b).toMatchObject({ id: tenantB, creadaPorCloud: false });
    } finally {
      await app.$disconnect();
    }
  });
});
