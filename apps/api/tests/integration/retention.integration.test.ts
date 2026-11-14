/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * mod.retention contra Postgres REAL conectando como `didacta_app`
 * (NOSUPERUSER, NOBYPASSRLS), con el adaptador real del host
 * (`RetentionHostPorts`) y los servicios reales de mensajería y comunidad:
 *
 *  - la bienvenida llega como mensaje directo de quien administra, una vez;
 *  - la RLS aísla de verdad: un aula no ve ni toca los mensajes, envíos ni
 *    miembros de la otra, y el barrido solo encuentra aulas con acceso global
 *    sancionado;
 *  - lecturas y respuestas se miden desde la mensajería real;
 *  - la copia por correo respeta la baja de los correos de la comunidad;
 *  - miembros en riesgo sale de las matrículas y los pedidos reales.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { CommunityService } from '@didacta/mod-community';
import { MessagingService } from '@didacta/mod-messaging';
import { RetentionService } from '@didacta/mod-retention';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RetentionHostPorts } from '../../src/modules/retention/retention-host-ports';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runAsTenant, runSanctionedGlobalAccess } from '../../src/tenancy/tenant-context.storage';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

describeWithDb('mod.retention — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let service: RetentionService;
  let messaging: MessagingService;
  const hubSends: Array<{
    tenantId: string;
    to: string;
    templateKey: string;
    variables: Record<string, unknown>;
  }> = [];
  const realtime: Array<{ tenantId: string; userIds: string[] }> = [];
  const stamp = Date.now();
  const tenants: Record<'a' | 'b', string> = { a: '', b: '' };
  const users: Record<string, string> = {};

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

    for (const k of ['a', 'b'] as const) {
      tenants[k] = (
        await admin.tenant.create({
          data: {
            id: randomUUID(),
            slug: `ret-${k}-${stamp}`,
            name: `Aula ${k.toUpperCase()} ${stamp}`,
          },
        })
      ).id;
    }
    const roles = Object.fromEntries(
      await Promise.all(
        ['tenant_admin', 'alumno'].map(async (name) => [
          name,
          (
            await admin.role.upsert({
              where: { name },
              create: { name, description: name, isSystem: true },
              update: {},
            })
          ).id,
        ]),
      ),
    ) as Record<string, string>;
    async function mkUser(key: string, tenantId: string, name: string, role: string, extra = {}) {
      const u = await admin.user.create({
        data: {
          tenantId,
          email: `${key}-${stamp}@example.com`,
          name,
          status: 'ACTIVE',
          timezone: 'UTC',
          ...extra,
        },
      });
      users[key] = u.id;
      await admin.userRole.create({ data: { userId: u.id, roleId: roles[role]! } });
    }
    await mkUser('duenaA', tenants.a, 'Lucía Dueña', 'tenant_admin', {
      createdAt: new Date(Date.now() - 400 * 24 * 3600 * 1000),
    });
    await mkUser('duenoB', tenants.b, 'Pablo Dueño', 'tenant_admin', {
      createdAt: new Date(Date.now() - 400 * 24 * 3600 * 1000),
    });

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
    const community = new CommunityService(prisma as never, ctx as never);
    messaging = new MessagingService(
      prisma as never,
      { publish: async () => undefined },
      async () => [],
      async (tenantId, ids) =>
        (
          await prisma.user.findMany({
            where: { tenantId, id: { in: ids } },
            select: { id: true, name: true, avatarUrl: true },
          })
        ).map((u) => ({ id: u.id, name: u.name, avatarUrl: u.avatarUrl })),
      async () => [],
    );
    const registry = {
      getMessagingService: () => messaging,
      getCommunityService: () => community,
      isModuleEnabledForTenant: async () => true,
      attachRetentionPorts: () => undefined,
    };
    const factory = {
      getPrisma: () => prisma,
      getTenantWebBaseUrl: async (tenantId: string) =>
        tenantId === tenants.a ? 'https://a.example.com' : 'https://b.example.com',
      getNotificationHub: () => ({
        send: async (n: {
          tenantId: string;
          to: string;
          templateKey: string;
          variables: Record<string, unknown>;
        }) => {
          hubSends.push(n);
        },
      }),
    };
    const ports = new RetentionHostPorts(
      registry as never,
      factory as never,
      {
        publishToUsers: async (tenantId: string, userIds: string[]) => {
          realtime.push({ tenantId, userIds });
        },
      } as never,
    );
    service = new RetentionService(prisma as never, () => ports);
  }, 120_000);

  afterAll(async () => {
    for (const t of Object.values(tenants).filter(Boolean)) {
      for (const del of [
        () => admin.modRetentionDelivery.deleteMany({ where: { tenantId: t } }),
        () => admin.modRetentionAutomation.deleteMany({ where: { tenantId: t } }),
        () => admin.modRetentionSettings.deleteMany({ where: { tenantId: t } }),
        () => admin.modMessagingMessage.deleteMany({ where: { tenantId: t } }),
        () => admin.modMessagingParticipant.deleteMany({ where: { tenantId: t } }),
        () => admin.modMessagingConversation.deleteMany({ where: { tenantId: t } }),
        () => admin.modCommunityUserPref.deleteMany({ where: { tenantId: t } }),
        () => admin.modLearningProgress.deleteMany({ where: { tenantId: t } }),
        () => admin.modLearningEnrollment.deleteMany({ where: { tenantId: t } }),
        () => admin.modBillingOrder.deleteMany({ where: { tenantId: t } }),
        () => admin.modBillingProduct.deleteMany({ where: { tenantId: t } }),
        () => admin.modCoursesCourse.deleteMany({ where: { tenantId: t } }),
        () => admin.userRole.deleteMany({ where: { user: { tenantId: t } } }),
        () => admin.user.deleteMany({ where: { tenantId: t } }),
        () => admin.tenant.delete({ where: { id: t } }),
      ]) {
        await del().catch(() => undefined);
      }
    }
    await admin?.$disconnect();
    await closeModule?.();
  });

  /** Una alumna que acaba de darse de alta, con la zona de un sitio donde ahora es de día. */
  async function newStudent(key: string, tenantId: string, name: string) {
    const offset = 12 - new Date().getUTCHours(); // su hora local ≈ mediodía
    const tz = offset === 0 ? 'UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
    const rol = await admin.role.findUniqueOrThrow({ where: { name: 'alumno' } });
    const u = await admin.user.create({
      data: {
        tenantId,
        email: `${key}-${stamp}@example.com`,
        name,
        status: 'ACTIVE',
        timezone: tz,
      },
    });
    await admin.userRole.create({ data: { userId: u.id, roleId: rol.id } });
    users[key] = u.id;
    return u.id;
  }

  it('bienvenida: mensaje directo REAL de quien administra, una sola vez', async () => {
    const automation = await runAsTenant(tenants.a, () =>
      service.activateTemplate(
        tenants.a,
        users['duenaA']!,
        'welcome',
        new Date(Date.now() - 60_000),
      ),
    );
    expect(automation.enabled).toBe(true);
    const ana = await newStudent('anaA', tenants.a, 'Ana Ruiz');

    const r1 = await runAsTenant(tenants.a, () => service.runTenant(tenants.a));
    const r2 = await runAsTenant(tenants.a, () => service.runTenant(tenants.a));
    expect(r1.sent).toBe(1);
    expect(r2.sent).toBe(0);

    const msgs = await admin.modMessagingMessage.findMany({ where: { tenantId: tenants.a } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.authorId).toBe(users['duenaA']);
    expect(msgs[0]!.body).toContain('¡Hola, Ana! Te doy la bienvenida a Aula A');
    expect(msgs[0]!.body).toContain('https://a.example.com/');
    const conv = await admin.modMessagingConversation.findUniqueOrThrow({
      where: { id: msgs[0]!.conversationId },
    });
    expect(conv.type).toBe('DM');
    expect(conv.dmKey).toContain(ana);
    // Push en tiempo real a la alumna (y a las otras pestañas de quien firma).
    expect(realtime.at(-1)).toEqual({ tenantId: tenants.a, userIds: [ana, users['duenaA']] });
  });

  it('la RLS aísla: un aula no ve ni toca lo de la otra', async () => {
    await runAsTenant(tenants.b, () =>
      service.activateTemplate(
        tenants.b,
        users['duenoB']!,
        'welcome',
        new Date(Date.now() - 60_000),
      ),
    );
    await newStudent('beaB', tenants.b, 'Bea Gil');

    // Desde A no se ve el mensaje de B ni se le puede apagar.
    const fromA = await runAsTenant(tenants.a, () => service.listAutomations(tenants.a));
    expect(fromA).toHaveLength(1);
    const idB = (
      await admin.modRetentionAutomation.findFirstOrThrow({ where: { tenantId: tenants.b } })
    ).id;
    const touched = await runAsTenant(tenants.a, () =>
      prisma.modRetentionAutomation.updateMany({ where: { id: idB }, data: { enabled: false } }),
    );
    expect(touched.count).toBe(0);

    // El barrido de A no escribe a nadie de B.
    await runAsTenant(tenants.a, () => service.runTenant(tenants.a));
    expect(await admin.modRetentionDelivery.count({ where: { tenantId: tenants.b } })).toBe(0);

    // Lista de aulas activas: solo con acceso global sancionado.
    const sanctioned = await runSanctionedGlobalAccess(() => service.listActiveTenantIds());
    expect(sanctioned).toEqual(expect.arrayContaining([tenants.a, tenants.b]));
    const scoped = await runAsTenant(tenants.a, () => service.listActiveTenantIds());
    expect(scoped).toEqual([tenants.a]);

    // B recibe lo suyo con su firma.
    const rb = await runAsTenant(tenants.b, () => service.runTenant(tenants.b));
    expect(rb.sent).toBe(1);
    const msgB = await admin.modMessagingMessage.findFirstOrThrow({
      where: { tenantId: tenants.b },
    });
    expect(msgB.authorId).toBe(users['duenoB']);
    expect(msgB.body).toContain('Aula B');
  });

  it('lecturas y respuestas salen de la mensajería real', async () => {
    const ana = users['anaA']!;
    const delivery = await admin.modRetentionDelivery.findFirstOrThrow({
      where: { tenantId: tenants.a, userId: ana },
    });
    const caller = { userId: ana, displayName: 'Ana Ruiz', roles: ['alumno'] };
    await runAsTenant(tenants.a, async () => {
      await messaging.markRead(tenants.a, caller, delivery.conversationId!);
      await messaging.sendMessage(tenants.a, caller, delivery.conversationId!, '¡Gracias, Lucía!');
    });
    const [list] = await runAsTenant(tenants.a, () => service.listAutomations(tenants.a));
    expect(list!.stats).toMatchObject({ sent: 1, read: 1, replied: 1 });
  });

  it('una respuesta de la alumna NO cuenta como mensaje a mano del equipo; uno del equipo sí frena', async () => {
    const ana = users['anaA']!;
    const recent = await runAsTenant(tenants.a, () =>
      messaging.recentDirectMessagesTo(
        tenants.a,
        [users['duenaA']!],
        ana,
        new Date(Date.now() - 3600_000),
      ),
    );
    // Solo el automático (que el servicio reconoce como suyo); la respuesta de Ana no está.
    expect(recent).toHaveLength(1);

    await runAsTenant(tenants.a, () =>
      service.activateTemplate(
        tenants.a,
        users['duenaA']!,
        'first_post',
        new Date(Date.now() - 60_000),
      ),
    );
    const leo = await newStudent('leoA', tenants.a, 'Leo Mar');
    const duena = { userId: users['duenaA']!, displayName: 'Lucía Dueña', roles: ['tenant_admin'] };
    await runAsTenant(tenants.a, async () => {
      const { conversationId } = await messaging.openDm(tenants.a, duena, leo);
      await messaging.sendMessage(tenants.a, duena, conversationId, 'Hola Leo, ¿todo bien?');
    });
    const r = await runAsTenant(tenants.a, () => service.runTenant(tenants.a));
    expect(r.sent).toBe(0);
    const skipped = await admin.modRetentionDelivery.findFirstOrThrow({
      where: { tenantId: tenants.a, userId: leo },
    });
    expect(skipped.status).toBe('SKIPPED');
    expect(skipped.skipReason).toBe('recent_manual_message');
  });

  it('copia por correo: sale por el hub con su baja; quien se dio de baja no la recibe', async () => {
    const welcome = await admin.modRetentionAutomation.findFirstOrThrow({
      where: { tenantId: tenants.a, templateKey: 'welcome' },
    });
    await runAsTenant(tenants.a, () =>
      service.updateAutomation(tenants.a, users['duenaA']!, welcome.id, { emailEnabled: true }),
    );
    // updateAutomation no cambia activatedAt si no cambian días: las altas de ahora cuentan.
    const mia = await newStudent('miaA', tenants.a, 'Mía Sol');
    const noe = await newStudent('noeA', tenants.a, 'Noe Paz');
    await runAsTenant(tenants.a, () =>
      prisma.modCommunityUserPref.create({
        data: { tenantId: tenants.a, userId: noe, broadcastOptOut: true, digestOptOut: true },
      }),
    );
    const before = hubSends.length;
    await runAsTenant(tenants.a, () => service.runTenant(tenants.a));
    const sends = hubSends.slice(before);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      tenantId: tenants.a,
      to: mia,
      templateKey: 'retention.message',
    });
    expect(sends[0]!.variables['subject']).toBe(`Te doy la bienvenida a Aula A ${stamp}`);
    expect(String(sends[0]!.variables['unsubUrl'])).toMatch(
      /^https:\/\/a\.example\.com\/api\/v1\/modules\/community\/unsubscribe\?token=/,
    );
    const noeDelivery = await admin.modRetentionDelivery.findFirstOrThrow({
      where: { tenantId: tenants.a, userId: noe },
    });
    expect(noeDelivery.status).toBe('SENT');
    expect(noeDelivery.emailSkipReason).toBe('opted_out');
  });

  it('miembros en riesgo: matrículas y pedidos reales, sin el equipo ni la otra aula', async () => {
    const day = 24 * 3600 * 1000;
    const course = await admin.modCoursesCourse.create({
      data: {
        tenantId: tenants.a,
        slug: `cata-${stamp}`,
        title: 'Cata para empezar',
        status: 'PUBLISHED',
      },
    });
    const paula = await newStudent('paulaA', tenants.a, 'Paula Vid');
    const tomas = await newStudent('tomasA', tenants.a, 'Tomás Uva');
    await admin.user.update({
      where: { id: tomas },
      data: {
        lastSeenAt: new Date(Date.now() - 40 * day),
        createdAt: new Date(Date.now() - 90 * day),
      },
    });
    await admin.modLearningEnrollment.create({
      data: {
        tenantId: tenants.a,
        userId: tomas,
        courseId: course.id,
        status: 'ACTIVE',
        progressPercent: 35,
        enrolledAt: new Date(Date.now() - 80 * day),
        startedAt: new Date(Date.now() - 79 * day),
      },
    });
    const product = await admin.modBillingProduct.create({
      data: {
        tenantId: tenants.a,
        courseId: course.id,
        stripeProductId: `prod_${stamp}`,
        stripePriceId: `price_${stamp}`,
        unitAmount: 4900,
      },
    });
    await admin.modBillingOrder.create({
      data: {
        tenantId: tenants.a,
        userId: paula,
        productId: product.id,
        courseId: course.id,
        stripeSessionId: `cs_test_${stamp}`,
        status: 'COMPLETED',
        completedAt: new Date(Date.now() - 5 * day),
      },
    });

    const view = await runAsTenant(tenants.a, () => service.atRisk(tenants.a, { days: 14 }));
    const byId = new Map(view.rows.map((r) => [r.id, r]));
    expect(
      byId
        .get(tomas)!
        .reasons.map((r) => r.kind)
        .sort(),
    ).toEqual(['inactive', 'stalled']);
    expect(byId.get(tomas)!.reasons.find((r) => r.kind === 'stalled')).toMatchObject({
      courseTitle: 'Cata para empezar',
      progressPercent: 35,
    });
    expect(byId.get(paula)!.reasons.map((r) => r.kind)).toEqual(['paid_not_started']);
    expect(byId.has(users['duenaA']!)).toBe(false);
    expect(byId.has(users['beaB']!)).toBe(false);

    // «Añadir a recuperación» sin mensaje de recuperación → error claro; con él, a la cola.
    await expect(
      runAsTenant(tenants.a, () => service.addToRecovery(tenants.a, tomas)),
    ).rejects.toMatchObject({ code: 'RETENTION_RECOVERY_NOT_CONFIGURED' });
    await runAsTenant(tenants.a, () =>
      service.activateTemplate(tenants.a, users['duenaA']!, 'come_back'),
    );
    const queued = await runAsTenant(tenants.a, () => service.addToRecovery(tenants.a, tomas));
    expect(queued.queued).toBe(true);
    const after = await runAsTenant(tenants.a, () => service.atRisk(tenants.a, { days: 14 }));
    expect(after.rows.find((r) => r.id === tomas)!.inRecovery).toBe(true);
  });
});
