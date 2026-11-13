/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Puerta de agentes contra Postgres REAL conectando como `didacta_app`
 * (NOSUPERUSER, NOBYPASSRLS): dos aulas, una clave de agente por aula, y las
 * herramientas reales sobre los servicios reales de cursos y comunidad.
 *
 * Lo que tiene que ser cierto, y se mira con el cliente administrador (que se
 * salta la RLS) para no fiarse de lo que diga la propia app:
 *   - con la clave del aula A solo se lee y se escribe en el aula A;
 *   - un id del aula B, pasado como argumento, «no existe» para la clave A;
 *   - aunque el contexto de tenant fuese el de OTRA aula (fallo hipotético del
 *     guard o del middleware), la RLS impide escribir: falla, no cruza;
 *   - una clave revocada deja de abrir la puerta en ese momento.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { CoursesService } from '@didacta/mod-courses';
import { CommunityService } from '@didacta/mod-community';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentKeyGuard } from '../../src/agent/agent-key.guard';
import { AgentRateLimiter } from '../../src/agent/agent-rate-limiter';
import { PANEL_AGENT_SCOPES } from '../../src/agent/agent-scopes';
import { AgentService, AgentToolError } from '../../src/agent/agent.service';
import { ApiKeyService } from '../../src/auth/api-key.service';
import type { SessionClaims } from '../../src/auth/token.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TenantContextService } from '../../src/tenancy/tenant-context.service';
import { runAsTenant } from '../../src/tenancy/tenant-context.storage';
import { TenantResolverService } from '../../src/tenancy/tenant-resolver.service';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

describeWithDb('Puerta de agentes — Postgres real como didacta_app (RLS forzada)', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let agent: AgentService;
  let guard: AgentKeyGuard;
  let apiKeys: ApiKeyService;
  let tenantA: string;
  let tenantB: string;
  let ownerA: string;
  let ownerB: string;
  let courseB: string;
  let tokenA: string;
  let keyIdA: string;
  let userA: SessionClaims;
  const stamp = Date.now();
  const hostA = `agentes-a-${stamp}.example.com`;
  const hostB = `agentes-b-${stamp}.example.com`;

  /** Pasa por el guard real: el usuario sale de la fila de la clave. */
  async function viaGuard(
    token: string,
    host: string,
  ): Promise<{ user: SessionClaims; keyId: string }> {
    const req: Record<string, unknown> = {
      headers: { authorization: `Bearer ${token}`, host },
    };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as never;
    await guard.canActivate(ctx);
    return {
      user: req['user'] as SessionClaims,
      keyId: (req['agentKey'] as { apiKeyId: string }).apiKeyId,
    };
  }

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

    tenantA = (
      await admin.tenant.create({
        data: { id: randomUUID(), slug: `agentes-a-${stamp}`, name: 'Morning Pour' },
      })
    ).id;
    tenantB = (
      await admin.tenant.create({
        data: { id: randomUUID(), slug: `agentes-b-${stamp}`, name: 'Harbor Bakes' },
      })
    ).id;
    await admin.tenantDomain.createMany({
      data: [
        { tenantId: tenantA, hostname: hostA, isVerified: true },
        { tenantId: tenantB, hostname: hostB, isVerified: true },
      ] as never,
    });
    ownerA = (
      await admin.user.create({
        data: {
          tenantId: tenantA,
          email: `hello-a-${stamp}@example.com`,
          status: 'ACTIVE',
          locale: 'en-US',
        },
      })
    ).id;
    ownerB = (
      await admin.user.create({
        data: { tenantId: tenantB, email: `hello-b-${stamp}@example.com`, status: 'ACTIVE' },
      })
    ).id;
    const rol = await admin.role.upsert({
      where: { name: 'tenant_admin' },
      create: { name: 'tenant_admin', description: 'Gestor de un tenant', isSystem: true },
      update: {},
    });
    await admin.userRole.createMany({
      data: [
        { userId: ownerA, roleId: rol.id },
        { userId: ownerB, roleId: rol.id },
      ],
    });
    // Curso del aula B, sembrado por fuera: el que la clave A no debe ver.
    courseB = (
      await admin.modCoursesCourse.create({
        data: { tenantId: tenantB, slug: `pan-${stamp}`, title: 'Sourdough Basics' },
      })
    ).id;

    // Servicios PÚBLICOS reales de los módulos sobre el PrismaService de la
    // app (con la extensión de RLS); el bus de eventos no es parte de esto.
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
    const registry = {
      getCoursesService: () => new CoursesService(prisma as never, ctx as never),
      getCommunityService: () => new CommunityService(prisma as never, ctx as never),
    };
    const audits: unknown[] = [];
    agent = new AgentService(
      prisma,
      registry as never,
      { isEnabled: async () => true } as never,
      { record: async (e: unknown) => void audits.push(e) } as never,
      { activeRestrictions: async () => [] } as never,
      new AgentRateLimiter(null),
    );
    apiKeys = new ApiKeyService(prisma);
    guard = new AgentKeyGuard(
      apiKeys,
      new TenantContextService(),
      new TenantResolverService(prisma),
    );

    // Claves reales, creadas en el contexto de su aula (api_key tiene RLS).
    const createdA = await runAsTenant(tenantA, () =>
      apiKeys.create({
        tenantId: tenantA,
        userId: ownerA,
        name: 'Agente',
        scopes: [...PANEL_AGENT_SCOPES],
      }),
    );
    tokenA = createdA.token;
    keyIdA = createdA.id;
    await runAsTenant(tenantB, () =>
      apiKeys.create({
        tenantId: tenantB,
        userId: ownerB,
        name: 'Agente',
        scopes: [...PANEL_AGENT_SCOPES],
      }),
    );
    userA = (await viaGuard(tokenA, hostA)).user;
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      await admin.apiKey.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await admin.modCoursesLesson.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await admin.modCoursesModule.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await admin.modCoursesCourse.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await admin.modCommunityPost.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await admin.tenant.delete({ where: { id: t } }).catch(() => undefined);
    }
    await admin?.$disconnect();
    await closeModule?.();
  });

  it('el guard saca el aula y el dueño de la fila de la clave', () => {
    expect(userA.tenantId).toBe(tenantA);
    expect(userA.sub).toBe(ownerA);
    expect(userA.roles).toEqual([...PANEL_AGENT_SCOPES]);
  });

  it('la clave A por el dominio del aula B → rechazada', async () => {
    await expect(viaGuard(tokenA, hostB)).rejects.toMatchObject({
      response: { code: 'AGENT_KEY_OTHER_ACADEMY' },
    });
  });

  it('crea curso y lecciones en el aula A, y solo en el A', async () => {
    const course = (await runAsTenant(tenantA, () =>
      agent.call(userA, keyIdA, 'create_course', { title: 'Espresso at Home' }),
    )) as { id: string; status: string };
    expect(course.status).toBe('DRAFT');
    for (const title of ['Beans', 'Grind', 'Tamping']) {
      await runAsTenant(tenantA, () =>
        agent.call(userA, keyIdA, 'create_lesson', {
          courseId: course.id,
          title,
          type: 'text',
          text: `About ${title}.`,
        }),
      );
    }

    // Visto desde FUERA de la app (administrador, sin RLS).
    const row = await admin.modCoursesCourse.findUnique({
      where: { id: course.id },
      select: { tenantId: true, status: true, createdById: true },
    });
    expect(row).toEqual({ tenantId: tenantA, status: 'DRAFT', createdById: ownerA });
    const lessons = await admin.modCoursesLesson.findMany({
      where: { module: { courseId: course.id } },
      select: { tenantId: true, title: true, type: true, content: true },
      orderBy: { position: 'asc' },
    });
    expect(lessons.map((l) => l.title)).toEqual(['Beans', 'Grind', 'Tamping']);
    expect(lessons.every((l) => l.tenantId === tenantA && l.type === 'TEXT')).toBe(true);
    expect(lessons[0]!.content).toEqual({ text: 'About Beans.' });
    expect(await admin.modCoursesCourse.count({ where: { tenantId: tenantB } })).toBe(1);
  });

  it('list_courses con la clave A no enseña nada del aula B', async () => {
    const r = (await runAsTenant(tenantA, () => agent.call(userA, keyIdA, 'list_courses', {}))) as {
      courses: Array<{ id: string }>;
    };
    expect(r.courses.length).toBeGreaterThan(0);
    expect(r.courses.map((c) => c.id)).not.toContain(courseB);
  });

  it('un id del aula B como argumento «no existe» para la clave A (y no se escribe nada)', async () => {
    const before = await admin.modCoursesLesson.count({ where: { tenantId: tenantB } });
    await expect(
      runAsTenant(tenantA, () =>
        agent.call(userA, keyIdA, 'create_lesson', {
          courseId: courseB,
          title: 'Intrusa',
          type: 'text',
        }),
      ),
    ).rejects.toBeInstanceOf(AgentToolError);
    await expect(
      runAsTenant(tenantA, () => agent.call(userA, keyIdA, 'get_course', { courseId: courseB })),
    ).rejects.toMatchObject({ code: 'COURSE_NOT_FOUND' });
    expect(await admin.modCoursesLesson.count({ where: { tenantId: tenantB } })).toBe(before);
    expect(await admin.modCoursesModule.count({ where: { tenantId: tenantB } })).toBe(0);
  });

  it('defensa en profundidad: con el contexto de OTRA aula abierto, la RLS no deja escribir', async () => {
    // Simula un fallo hipotético del guard/middleware: claims del aula A pero
    // el contexto (GUC de RLS) del aula B. El servicio filtra por tenant A,
    // la RLS solo deja ver el B: no hay curso ni se crea nada en ningún lado.
    const before = await admin.modCoursesCourse.count();
    await expect(
      runAsTenant(tenantB, () => agent.call(userA, keyIdA, 'create_course', { title: 'Cruzado' })),
    ).rejects.toBeInstanceOf(AgentToolError);
    expect(await admin.modCoursesCourse.count()).toBe(before);
    expect(await admin.modCoursesCourse.count({ where: { title: 'Cruzado' } })).toBe(0);
  });

  it('una clave revocada deja de abrir la puerta en ese momento', async () => {
    await runAsTenant(tenantA, () => apiKeys.revokeForTenant(tenantA, keyIdA));
    await expect(viaGuard(tokenA, hostA)).rejects.toMatchObject({
      response: { code: 'AGENT_KEY_INVALID' },
    });
  });
});
