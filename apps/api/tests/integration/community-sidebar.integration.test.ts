/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Barra lateral de la comunidad contra Postgres REAL conectando como
 * `didacta_app` (NOSUPERUSER, NOBYPASSRLS), con los services públicos reales
 * de mod.community y mod.gamification: dos aulas con datos de todo tipo y la
 * barra de cada una solo enseña lo suyo; un aula sin nada no pinta bloques.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { CommunityService } from '@didacta/mod-community';
import { GamificationService } from '@didacta/mod-gamification';
import { CoverNotFoundError, ThemingService } from '@didacta/mod-theming';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommunitySidebarService } from '../../src/modules/community/community-sidebar.service';
import { MessagingPresenceService } from '../../src/modules/messaging/messaging-presence.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runAsTenant } from '../../src/tenancy/tenant-context.storage';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

describeWithDb('Barra lateral de la comunidad — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let service: CommunitySidebarService;
  let presence: MessagingPresenceService;
  const stamp = Date.now();
  const tenants: Record<'a' | 'b' | 'vacia', string> = { a: '', b: '', vacia: '' };
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

    for (const k of ['a', 'b', 'vacia'] as const) {
      tenants[k] = (
        await admin.tenant.create({
          data: { id: randomUUID(), slug: `sidebar-${k}-${stamp}`, name: `Aula ${k} ${stamp}` },
        })
      ).id;
    }
    const rol = await admin.role.upsert({
      where: { name: 'tenant_admin' },
      create: { name: 'tenant_admin', description: 'Gestor de un tenant', isSystem: true },
      update: {},
    });
    async function mkUser(key: string, tenantId: string, name: string, admin_ = false) {
      const u = await admin.user.create({
        data: {
          tenantId,
          email: `${key}-${stamp}@example.com`,
          name,
          status: 'ACTIVE',
          avatarUrl: `https://cdn.example.com/${key}.png`,
        },
      });
      users[key] = u.id;
      if (admin_) await admin.userRole.create({ data: { userId: u.id, roleId: rol.id } });
    }
    await mkUser('duenaA', tenants.a, 'Dueña A', true);
    await mkUser('anaA', tenants.a, 'Ana A');
    await mkUser('duenoB', tenants.b, 'Dueño B', true);
    await mkUser('zoeB', tenants.b, 'Zoe B');
    await mkUser('soloVacia', tenants.vacia, 'Solo Vacía');

    await admin.modThemingTenantTheme.createMany({
      data: [
        {
          tenantId: tenants.a,
          logoUrl: 'https://cdn.example.com/a.png',
          signinHeadline: 'Titular A',
        },
        {
          tenantId: tenants.b,
          logoUrl: 'https://cdn.example.com/b.png',
          signinHeadline: 'Titular B',
        },
      ],
    });
    await admin.tenantDomain.createMany({
      data: [
        {
          tenantId: tenants.a,
          hostname: `a-${stamp}.example.com`,
          isPrimary: true,
          isVerified: true,
        },
        {
          tenantId: tenants.b,
          hostname: `b-${stamp}.example.com`,
          isPrimary: true,
          isVerified: true,
        },
      ],
    });
    for (const [k, tenantId, author] of [
      ['a', tenants.a, users['anaA']!],
      ['b', tenants.b, users['zoeB']!],
    ] as const) {
      const post = await admin.modCommunityPost.create({
        data: { tenantId, authorId: author, title: `Post ${k}`, body: 'x', tags: ['general'] },
      });
      await admin.modCommunityComment.create({
        data: { tenantId, postId: post.id, authorId: author, body: `Comentario de ${k}` },
      });
      await admin.modGamificationLedgerEntry.create({
        data: {
          tenantId,
          userId: author,
          ruleKey: 'community.post',
          points: k === 'a' ? 15 : 999,
          sourceKey: `post:${post.id}`,
          occurredAt: new Date(),
        },
      });
    }

    presence = new MessagingPresenceService();
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
      getCommunityService: () => new CommunityService(prisma as never, ctx as never),
      getGamificationService: () =>
        new GamificationService(prisma as never, { publish: async () => undefined }),
    };
    const tenantModules = {
      list: async () => [
        { name: 'mod.gamification', enabled: true },
        { name: 'mod.messaging', enabled: true },
      ],
    };
    service = new CommunitySidebarService(
      prisma,
      registry as never,
      tenantModules as never,
      presence,
    );
  }, 120_000);

  afterAll(async () => {
    for (const t of Object.values(tenants).filter(Boolean)) {
      await admin.modGamificationLedgerEntry
        .deleteMany({ where: { tenantId: t } })
        .catch(() => undefined);
      await admin.modThemingTenantTheme
        .deleteMany({ where: { tenantId: t } })
        .catch(() => undefined);
      await admin.modCommunityPost.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await admin.user.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await admin.tenant.delete({ where: { id: t } }).catch(() => undefined);
    }
    await admin?.$disconnect();
    await closeModule?.();
  });

  it('el aula A solo ve lo suyo, con la RLS real', async () => {
    // La presencia de A trae, por error, a alguien de B: no cuenta.
    presence.touch(tenants.a, users['anaA']!);
    presence.touch(tenants.a, users['zoeB']!);

    const a = await runAsTenant(tenants.a, () => service.get(tenants.a));
    expect(a.academy).toMatchObject({
      name: `Aula a ${stamp}`,
      logoUrl: 'https://cdn.example.com/a.png',
      description: 'Titular A',
      host: `a-${stamp}.example.com`,
    });
    expect(a.members.total).toBe(2);
    expect(a.members.admins).toBe(1);
    expect(a.members.online).toBe(1);
    expect(a.members.faces[0]).toMatchObject({ id: users['anaA'], online: true });
    expect(a.leaderboard?.entries).toEqual([
      expect.objectContaining({ id: users['anaA'], name: 'Ana A', rank: 1, points: 15 }),
    ]);
    expect(a.recentComments.map((c) => c.excerpt)).toEqual(['Comentario de a']);

    const json = JSON.stringify(a);
    for (const deB of ['Titular B', 'Zoe B', 'Dueño B', 'Comentario de b', `b-${stamp}`, '999']) {
      expect(json).not.toContain(deB);
    }
  });

  it('el aula B ve lo suyo', async () => {
    const b = await runAsTenant(tenants.b, () => service.get(tenants.b));
    expect(b.academy.description).toBe('Titular B');
    expect(b.leaderboard?.entries.map((e) => e.points)).toEqual([999]);
    expect(b.recentComments.map((c) => c.excerpt)).toEqual(['Comentario de b']);
    expect(JSON.stringify(b)).not.toContain('Ana A');
  });

  it('portada, descripción y enlaces de A por el service real de mod.theming: solo en la barra de A', async () => {
    const blobs = new Map<string, Buffer>();
    const storage = {
      uploadImage: async (key: string, data: Buffer, contentType: string) => {
        blobs.set(key, data);
        return { key, contentType, optimized: false, size: data.length, previousSize: data.length };
      },
      download: async (key: string) => blobs.get(key)!,
      delete: async (key: string) => void blobs.delete(key),
    };
    const theming = new ThemingService(
      prisma as never,
      {
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        storage,
        eventBus: { publish: async () => undefined },
      } as never,
    );
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
    await runAsTenant(tenants.a, async () => {
      await theming.update(tenants.a, {
        about: 'Descripción propia de A',
        socialLinks: [
          { kind: 'instagram', url: 'https://instagram.com/' },
          { kind: 'whatsapp', url: 'https://wa.me/' },
        ],
      });
      await theming.uploadCover(tenants.a, {
        data: png,
        filename: 'a.png',
        contentType: 'image/png',
      });
    });

    const a = await runAsTenant(tenants.a, () => service.get(tenants.a));
    expect(a.academy).toMatchObject({
      description: 'Descripción propia de A',
      coverUrl: expect.stringContaining(`/modules/theming/tenants/${tenants.a}/cover?v=`),
      links: [
        { kind: 'instagram', url: 'https://instagram.com/' },
        { kind: 'whatsapp', url: 'https://wa.me/' },
      ],
    });
    // B sigue con su titular, sin portada ni enlaces…
    const b = await runAsTenant(tenants.b, () => service.get(tenants.b));
    expect(b.academy).toMatchObject({ description: 'Titular B', coverUrl: null, links: [] });
    expect(JSON.stringify(b)).not.toContain('Descripción propia de A');
    // …y desde B la fila de A no existe (RLS): ni su portada se sirve.
    await expect(
      runAsTenant(tenants.b, () => theming.getCoverBlob(tenants.a)),
    ).rejects.toBeInstanceOf(CoverNotFoundError);
    expect(
      (await runAsTenant(tenants.a, () => theming.getCoverBlob(tenants.a))).buffer.length,
    ).toBeGreaterThan(0);
  });

  it('un aula sin nada no pinta bloques: sin descripción, ranking ni comentarios', async () => {
    const v = await runAsTenant(tenants.vacia, () => service.get(tenants.vacia));
    expect(v.academy).toMatchObject({
      logoUrl: null,
      coverUrl: null,
      description: null,
      host: null,
      links: [],
    });
    expect(v.members).toMatchObject({ total: 1, admins: null, online: null });
    expect(v.leaderboard).toBeNull();
    expect(v.recentComments).toEqual([]);
  });
});
