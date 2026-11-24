/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Espacios de la comunidad y directos restringidos por nivel de membresía,
 * contra Postgres REAL conectando como `didacta_app` (NOSUPERUSER,
 * NOBYPASSRLS) y con los services públicos reales de mod.community,
 * mod.zoom-live y mod.messaging, más el puerto real de pertenencia a los grupos
 * de acceso (`buildAccessGroupMembership`).
 *
 * Piensa como un atacante con una cuenta de nivel bajo: CADA camino por el que
 * se podría leer un post, un comentario, una mención, un aviso o un directo de
 * un nivel que no tiene se intenta con él, y al lado va el control —alguien con
 * el nivel, o del equipo— que demuestra que la comprobación discrimina (un 404
 * de quien no tiene acceso no prueba nada sin un 200 de quien sí lo tiene).
 *
 * Personas del aula:
 *  - admin      tenant_admin (equipo: lo ve todo)
 *  - profe      formador (equipo: lo ve todo)
 *  - pro        miembro ACTIVO del nivel «Pro»
 *  - basico     miembro ACTIVO del nivel «Básico» (el atacante)
 *  - revocado   miembro REVOCADO de «Pro» (perdió el nivel)
 *  - zombie     miembro ACTIVO de un grupo BORRADO
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import {
  AccessGroupUnknownError,
  CommentNotFoundError,
  CommunityService,
  PostNotFoundError,
  SpaceLockedError,
  seesAllSpaces,
  type CommunityViewer,
} from '@didacta/mod-community';
import {
  MessagingService,
  NotParticipantError,
  SpaceNotFoundError,
  type MessagingCaller,
} from '@didacta/mod-messaging';
import {
  SessionAccessGroupUnknownError,
  SessionLockedError,
  ZoomLiveService,
  type SessionViewer,
} from '@didacta/mod-zoom-live';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildAccessGroupMembership,
  type AccessGroupMembershipDb,
} from '../../src/modules/access-groups/access-group-membership';
import { CommunitySidebarService } from '../../src/modules/community/community-sidebar.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runAsTenant } from '../../src/tenancy/tenant-context.storage';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

type Persona = 'admin' | 'profe' | 'pro' | 'basico' | 'revocado' | 'zombie';

interface Sent {
  templateKey: string;
  to: string;
  channel: string;
}

describeWithDb('Espacios y directos por nivel — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let community: CommunityService;
  let zoom: ZoomLiveService;
  let messaging: MessagingService;
  let sidebar: CommunitySidebarService;
  const sent: Sent[] = [];
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];

  const stamp = Date.now();
  let tenantId = '';
  const ids = {} as Record<Persona, string>;
  const roles = {} as Record<Persona, string[]>;
  const groups = { pro: '', basico: '', borrado: '' };
  const spaces = { general: '', pro: '', borrado: '' };
  const posts = { general: '', pro: '', proDeRevocado: '', mencionGeneral: '' };
  const comments = { pro: '', basicoEnPro: '' };
  let sessionId = '';
  let roomPro = '';

  const handle = (p: Persona) => `${p}-${stamp}`;
  const viewer = (p: Persona): CommunityViewer => ({
    canModerate: roles[p].includes('tenant_admin'),
    userId: ids[p],
    seesAllSpaces: seesAllSpaces(roles[p]),
  });
  const zViewer = (p: Persona): SessionViewer => ({
    userId: ids[p],
    isStaff: seesAllSpaces(roles[p]),
  });
  const caller = (p: Persona): MessagingCaller => ({
    userId: ids[p],
    displayName: p,
    roles: roles[p],
  });
  const asTenant = <T>(fn: () => Promise<T>) => runAsTenant(tenantId, fn);

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

    tenantId = (
      await admin.tenant.create({
        data: { id: randomUUID(), slug: `nivel-${stamp}`, name: `Aula niveles ${stamp}` },
      })
    ).id;
    const roleId = async (name: string) =>
      (
        await admin.role.upsert({
          where: { name },
          create: { name, description: name, isSystem: true },
          update: {},
        })
      ).id;
    const rolTenantAdmin = await roleId('tenant_admin');
    const rolFormador = await roleId('formador');
    for (const p of ['admin', 'profe', 'pro', 'basico', 'revocado', 'zombie'] as Persona[]) {
      const u = await admin.user.create({
        data: { tenantId, email: `${handle(p)}@example.com`, name: p, status: 'ACTIVE' },
      });
      ids[p] = u.id;
      roles[p] = [];
      if (p === 'admin') {
        await admin.userRole.create({ data: { userId: u.id, roleId: rolTenantAdmin } });
        roles[p] = ['tenant_admin'];
      }
      if (p === 'profe') {
        await admin.userRole.create({ data: { userId: u.id, roleId: rolFormador } });
        roles[p] = ['formador'];
      }
    }

    // Niveles (= grupos de acceso). «Borrado» se borró con un miembro activo.
    const mkGroup = async (name: string, deleted = false) =>
      (
        await admin.modAccessGroup.create({
          data: {
            tenantId,
            slug: `${name.toLowerCase()}-${stamp}`,
            name,
            kind: 'ALL_COURSES',
            ...(deleted ? { deletedAt: new Date() } : {}),
          },
        })
      ).id;
    groups.pro = await mkGroup('Pro');
    groups.basico = await mkGroup('Básico');
    groups.borrado = await mkGroup('Borrado', true);
    const member = (groupId: string, p: Persona, status = 'ACTIVE') =>
      admin.modAccessGroupMember.create({
        data: { groupId, tenantId, userId: ids[p], status, source: 'MANUAL' },
      });
    await member(groups.pro, 'pro');
    await member(groups.basico, 'basico');
    await member(groups.pro, 'revocado', 'REVOKED');
    await member(groups.borrado, 'zombie');

    // Espacios: uno abierto, uno «Pro» y uno solo del grupo borrado.
    const mkSpace = async (slug: string, accessGroupIds: string[]) =>
      (
        await admin.modCommunitySpace.create({
          data: {
            tenantId,
            slug,
            title: slug.toUpperCase(),
            description: `Descripción privada de ${slug}`,
            accessGroupIds,
          },
        })
      ).id;
    spaces.general = await mkSpace('general', []);
    spaces.pro = await mkSpace('pro', [groups.pro]);
    spaces.borrado = await mkSpace('solo-borrado', [groups.borrado]);

    // Contenido sembrado ANTES de que nadie mire: el post Pro con un adjunto,
    // un comentario del básico de cuando aún tenía acceso y uno de quien luego
    // lo perdió.
    const mkPost = async (author: Persona, tags: string[], title: string, body: string) =>
      (
        await admin.modCommunityPost.create({
          data: { tenantId, authorId: ids[author], title, body, tags },
        })
      ).id;
    posts.general = await mkPost('basico', ['general'], 'Hola a todos', 'Post abierto');
    posts.pro = await mkPost(
      'pro',
      ['pro'],
      'Estrategia secreta Pro',
      'Contenido solo para Pro\n<!--didacta-attachments:{"images":[{"url":"/api/v1/storage/file/pro.png","name":"pro.png"}],"files":[]}-->',
    );
    posts.proDeRevocado = await mkPost('revocado', ['pro'], 'Del que se fue', 'Viejo post Pro');
    comments.basicoEnPro = (
      await admin.modCommunityComment.create({
        data: {
          tenantId,
          postId: posts.pro,
          authorId: ids.basico,
          body: 'Comentario antiguo del básico',
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      })
    ).id;

    // Sala de chat del espacio Pro ya abierta por el básico (antes de cerrarse).
    roomPro = (
      await admin.modMessagingConversation.create({
        data: { id: randomUUID(), tenantId, type: 'SPACE', spaceId: spaces.pro },
      })
    ).id;
    await admin.modMessagingParticipant.create({
      data: { id: randomUUID(), tenantId, conversationId: roomPro, userId: ids.basico },
    });

    const ctx = {
      eventBus: {
        publish: async (e: { name: string; data: Record<string, unknown> }) => {
          events.push({ name: e.name, data: e.data });
        },
        subscribe: () => () => undefined,
      },
      auditLog: { record: async () => undefined },
      notificationHub: {
        send: async (m: { templateKey: string; to: string; channel: string }) => {
          sent.push({ templateKey: m.templateKey, to: m.to, channel: m.channel });
        },
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    };
    const membership = buildAccessGroupMembership(
      () => prisma as unknown as AccessGroupMembershipDb,
    );
    community = new CommunityService(prisma as never, ctx as never, membership);
    zoom = new ZoomLiveService(prisma as never, ctx as never, undefined, membership);
    messaging = new MessagingService(
      prisma as never,
      { publish: async () => undefined },
      async (tid, who) =>
        (
          await community.listSpaces(
            tid,
            who
              ? { canModerate: false, userId: who.userId, seesAllSpaces: seesAllSpaces(who.roles) }
              : { canModerate: false, seesAllSpaces: true },
          )
        )
          .filter((s) => !s.locked)
          .map((s) => ({
            id: s.id,
            slug: s.slug,
            title: s.title,
            icon: s.icon,
            color: s.color,
            sortOrder: s.sortOrder,
          })),
      async (_tid, userIds) => userIds.map((id) => ({ id, name: id, avatarUrl: null })),
      async () => [ids.admin, ids.profe],
      undefined,
      (tid, spaceId, userIds) => community.filterSpaceAudience(tid, spaceId, userIds),
    );
    sidebar = new CommunitySidebarService(
      prisma,
      { getCommunityService: () => community } as never,
      { list: async () => [] } as never,
    );

    // La clase Pro: creada por el servicio (enlace propio, sin Zoom), con una
    // grabación ya colgada y el básico inscrito de antes de restringirla.
    const created = await asTenant(() =>
      zoom.create(tenantId, ids.profe, {
        topic: 'Masterclass Pro',
        description: 'Agenda secreta de la masterclass',
        startTime: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        durationMinutes: 60,
        timezone: 'Europe/Madrid',
        hostEmail: `${handle('profe')}@example.com`,
        externalJoinUrl: 'https://meet.example.com/sala-pro-secreta',
        accessGroupIds: [groups.pro],
      }),
    );
    sessionId = created.id;
    await admin.modZoomSession.update({
      where: { id: sessionId },
      data: { recordingUrl: 'https://zoom.example.com/rec/pro-secreta' },
    });
    await admin.modZoomSessionRegistration.create({
      data: { id: randomUUID(), tenantId, sessionId, userId: ids.basico },
    });
  }, 120_000);

  afterAll(async () => {
    if (tenantId) {
      await admin.modMessagingParticipant.deleteMany({ where: { tenantId } }).catch(() => {});
      await admin.modMessagingMessage.deleteMany({ where: { tenantId } }).catch(() => {});
      await admin.modMessagingConversation.deleteMany({ where: { tenantId } }).catch(() => {});
      await admin.modZoomSession.deleteMany({ where: { tenantId } }).catch(() => {});
      await admin.modCommunityBroadcast.deleteMany({ where: { tenantId } }).catch(() => {});
      await admin.modCommunityMention.deleteMany({ where: { tenantId } }).catch(() => {});
      await admin.modCommunityReaction.deleteMany({ where: { tenantId } }).catch(() => {});
      await admin.modCommunityPost.deleteMany({ where: { tenantId } }).catch(() => {});
      await admin.modCommunitySpace.deleteMany({ where: { tenantId } }).catch(() => {});
      await admin.modAccessGroup.deleteMany({ where: { tenantId } }).catch(() => {});
      await admin.userRole.deleteMany({ where: { userId: { in: Object.values(ids) } } });
      await admin.user.deleteMany({ where: { tenantId } }).catch(() => {});
      await admin.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
    await admin?.$disconnect();
    await closeModule?.();
  });

  // ── Comunidad ─────────────────────────────────────────────────────────────

  it('espacios: el cerrado sale con candado, sin descripción y con su nivel', async () => {
    const delBasico = await asTenant(() => community.listSpaces(tenantId, viewer('basico')));
    const pro = delBasico.find((s) => s.slug === 'pro')!;
    expect(pro).toMatchObject({
      locked: true,
      description: null,
      accessLevels: [{ id: groups.pro, name: 'Pro' }],
      accessGroupIds: [],
    });
    expect(delBasico.find((s) => s.slug === 'general')).toMatchObject({
      locked: false,
      description: 'Descripción privada de general',
    });
    // Control: con el nivel está abierto; el equipo además ve los grupos.
    const delPro = await asTenant(() => community.listSpaces(tenantId, viewer('pro')));
    expect(delPro.find((s) => s.slug === 'pro')).toMatchObject({
      locked: false,
      description: 'Descripción privada de pro',
    });
    const delProfe = await asTenant(() => community.listSpaces(tenantId, viewer('profe')));
    expect(delProfe.find((s) => s.slug === 'pro')).toMatchObject({
      locked: false,
      accessGroupIds: [groups.pro],
    });
    // Perder el nivel cierra; un grupo borrado no abre nada.
    const delRevocado = await asTenant(() => community.listSpaces(tenantId, viewer('revocado')));
    expect(delRevocado.find((s) => s.slug === 'pro')?.locked).toBe(true);
    const delZombie = await asTenant(() => community.listSpaces(tenantId, viewer('zombie')));
    expect(delZombie.find((s) => s.slug === 'solo-borrado')).toMatchObject({
      locked: true,
      accessLevels: [],
    });
  });

  it('feed (vista «todo» y por espacio): el post del nivel no sale sin él', async () => {
    const todo = await asTenant(() =>
      community.listPosts(tenantId, { sort: 'recent', limit: 50 } as never, viewer('basico')),
    );
    expect(todo.map((p) => p.id)).toContain(posts.general);
    expect(todo.map((p) => p.id)).not.toContain(posts.pro);
    const espacio = await asTenant(() =>
      community.listPosts(tenantId, { tag: 'pro', limit: 50 } as never, viewer('basico')),
    );
    expect(espacio).toEqual([]);
    // Control.
    const delPro = await asTenant(() =>
      community.listPosts(tenantId, { tag: 'pro', limit: 50 } as never, viewer('pro')),
    );
    expect(delPro.map((p) => p.id)).toContain(posts.pro);
    const delProfe = await asTenant(() =>
      community.listPosts(tenantId, { limit: 50 } as never, viewer('profe')),
    );
    expect(delProfe.map((p) => p.id)).toContain(posts.pro);
  });

  it('detalle del post: 404 sin el nivel (igual que si no existiera)', async () => {
    await expect(
      asTenant(() => community.getPostDetail(tenantId, posts.pro, viewer('basico'))),
    ).rejects.toBeInstanceOf(PostNotFoundError);
    await expect(
      asTenant(() => community.getPostDetail(tenantId, posts.pro, viewer('revocado'))),
    ).rejects.toBeInstanceOf(PostNotFoundError);
    const ok = await asTenant(() => community.getPostDetail(tenantId, posts.pro, viewer('pro')));
    expect(ok.title).toBe('Estrategia secreta Pro');
    expect(ok.comments.map((c) => c.id)).toContain(comments.basicoEnPro);
  });

  it('galería de adjuntos: los del espacio cerrado no salen', async () => {
    const basico = await asTenant(() => community.listAttachments(tenantId, {}, viewer('basico')));
    expect(basico.map((a) => a.postId)).not.toContain(posts.pro);
    const pro = await asTenant(() => community.listAttachments(tenantId, {}, viewer('pro')));
    expect(pro.map((a) => a.postId)).toContain(posts.pro);
  });

  it('comentar y reaccionar en lo cerrado: 404; con el nivel, sí', async () => {
    await expect(
      asTenant(() =>
        community.addComment(
          tenantId,
          posts.pro,
          { id: ids.basico, displayName: 'basico' },
          { body: 'intento' } as never,
          viewer('basico'),
        ),
      ),
    ).rejects.toBeInstanceOf(PostNotFoundError);
    await expect(
      asTenant(() =>
        community.addReaction(
          tenantId,
          ids.basico,
          { postId: posts.pro, emoji: '👍' } as never,
          viewer('basico'),
        ),
      ),
    ).rejects.toBeInstanceOf(PostNotFoundError);
    await expect(
      asTenant(() =>
        community.addReaction(
          tenantId,
          ids.basico,
          { commentId: comments.basicoEnPro, emoji: '👍' } as never,
          viewer('basico'),
        ),
      ),
    ).rejects.toBeInstanceOf(CommentNotFoundError);
    // Control: el de Pro comenta (y queda como «último comentario») y reacciona.
    const c = await asTenant(() =>
      community.addComment(
        tenantId,
        posts.pro,
        { id: ids.pro, displayName: 'pro' },
        { body: 'Respuesta Pro reciente' } as never,
        viewer('pro'),
      ),
    );
    comments.pro = c.id;
    const r = await asTenant(() =>
      community.addReaction(
        tenantId,
        ids.pro,
        { postId: posts.pro, emoji: '🔥' } as never,
        viewer('pro'),
      ),
    );
    expect(r.postId).toBe(posts.pro);
  });

  it('últimos comentarios (lista y barra lateral): los del espacio cerrado no salen', async () => {
    const basico = await asTenant(() =>
      community.listRecentComments(tenantId, 10, viewer('basico')),
    );
    expect(basico.map((c) => c.postId)).not.toContain(posts.pro);
    const pro = await asTenant(() => community.listRecentComments(tenantId, 10, viewer('pro')));
    expect(pro.map((c) => c.id)).toContain(comments.pro);

    const barraBasico = await asTenant(() =>
      sidebar.get(tenantId, { userId: ids.basico, seesAllSpaces: false }),
    );
    expect(barraBasico.recentComments.map((c) => c.postId)).not.toContain(posts.pro);
    const barraPro = await asTenant(() =>
      sidebar.get(tenantId, { userId: ids.pro, seesAllSpaces: false }),
    );
    expect(barraPro.recentComments.map((c) => c.postId)).toContain(posts.pro);
  });

  it('publicar o mover un post a un espacio cerrado: 403 COMMUNITY_SPACE_LOCKED', async () => {
    await expect(
      asTenant(() =>
        community.createPost(
          tenantId,
          { id: ids.basico, displayName: 'basico' },
          { title: 'Me cuelo', body: 'x', tags: ['PRO'] } as never,
          'web',
          viewer('basico'),
        ),
      ),
    ).rejects.toBeInstanceOf(SpaceLockedError);
    await expect(
      asTenant(() =>
        community.updatePost(tenantId, { id: ids.basico, canModerate: false }, posts.general, {
          tags: ['pro'],
        }),
      ),
    ).rejects.toBeInstanceOf(SpaceLockedError);
    // Editar un post cerrado (aunque no sea suyo) responde 404, no «no eres el autor».
    await expect(
      asTenant(() =>
        community.updatePost(tenantId, { id: ids.basico, canModerate: false }, posts.pro, {
          title: 'x',
        }),
      ),
    ).rejects.toBeInstanceOf(PostNotFoundError);
    // Control.
    const ok = await asTenant(() =>
      community.createPost(
        tenantId,
        { id: ids.pro, displayName: 'pro' },
        { title: 'Nuevo Pro', body: 'ok', tags: ['pro'] } as never,
        'web',
        viewer('pro'),
      ),
    );
    expect(ok.tags).toEqual(['pro']);
  });

  it('menciones y avisos: solo a quien puede ver el post', async () => {
    sent.length = 0;
    const mencion = await asTenant(() =>
      community.createPost(
        tenantId,
        { id: ids.profe, displayName: 'profe' },
        {
          title: 'Sesión Pro',
          body: `Hola @${handle('basico')} y @${handle('pro')} y @${handle('revocado')}`,
          tags: ['pro'],
        } as never,
        'web',
        viewer('profe'),
      ),
    );
    const avisados = sent.filter((m) => m.templateKey === 'community.mention').map((m) => m.to);
    expect(avisados).toEqual([ids.pro]);

    // Mención abierta (control de «mis menciones»).
    posts.mencionGeneral = (
      await asTenant(() =>
        community.createPost(
          tenantId,
          { id: ids.profe, displayName: 'profe' },
          { title: 'Abierto', body: `Ojo @${handle('basico')}`, tags: ['general'] } as never,
          'web',
          viewer('profe'),
        ),
      )
    ).id;
    const misBasico = await asTenant(() =>
      community.listMyMentions(tenantId, ids.basico, 50, viewer('basico')),
    );
    expect(misBasico.map((m) => m.postId)).toEqual([posts.mencionGeneral]);
    const misPro = await asTenant(() =>
      community.listMyMentions(tenantId, ids.pro, 50, viewer('pro')),
    );
    expect(misPro.map((m) => m.postId)).toContain(mencion.id);

    // Aviso de comentario: al autor que perdió el nivel no se le manda el extracto.
    sent.length = 0;
    await asTenant(() =>
      community.addComment(
        tenantId,
        posts.proDeRevocado,
        { id: ids.pro, displayName: 'pro' },
        { body: 'Te respondo' } as never,
        viewer('pro'),
      ),
    );
    expect(sent.filter((m) => m.to === ids.revocado)).toEqual([]);
    // Control: el autor con nivel sí recibe el aviso.
    await asTenant(() =>
      community.addComment(
        tenantId,
        posts.pro,
        { id: ids.profe, displayName: 'profe' },
        { body: 'Buen post' } as never,
        viewer('profe'),
      ),
    );
    expect(
      sent.filter((m) => m.to === ids.pro && m.templateKey === 'community.comment.on_post'),
    ).toHaveLength(2); // in-app + email
  });

  it('resumen por correo: ni menciones ni respuestas del espacio cerrado', async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const basico = await asTenant(() => community.buildDigest(tenantId, ids.basico, since));
    // Comentó en el post Pro cuando podía, y desde entonces hay respuestas: no salen.
    expect(basico.replies.map((r) => r.postId)).not.toContain(posts.pro);
    expect(basico.mentions.map((m) => m.postId)).toEqual([posts.mencionGeneral]);
    // Control: el de Pro sí ve las respuestas de su post.
    const pro = await asTenant(() => community.buildDigest(tenantId, ids.pro, since));
    expect(pro.replies.map((r) => r.postId)).toContain(posts.pro);
  });

  it('aviso masivo de un post del espacio cerrado: solo a quien puede verlo', async () => {
    const b = await asTenant(() =>
      community.createBroadcast(tenantId, ids.admin, {
        subject: 'Nuevo en Pro',
        bodyText: 'Extracto secreto',
        postId: posts.pro,
      }),
    );
    // admin + profe + pro (equipo y nivel); ni básico, ni revocado, ni zombie.
    expect(b.total).toBe(3);
    const lote = await asTenant(() => community.claimBroadcastBatch(b.id, 50));
    const puede = Object.fromEntries(lote.recipients.map((r) => [r.userId, r.canSee]));
    expect(puede[ids.basico]).toBe(false);
    expect(puede[ids.revocado]).toBe(false);
    expect(puede[ids.zombie]).toBe(false);
    expect(puede[ids.pro]).toBe(true);
    expect(puede[ids.admin]).toBe(true);
    expect(puede[ids.profe]).toBe(true);
    // Control: un aviso de un post abierto va a todos.
    const abierto = await asTenant(() =>
      community.createBroadcast(tenantId, ids.admin, {
        subject: 'General',
        bodyText: 'x',
        postId: posts.general,
      }),
    );
    expect(abierto.total).toBe(6);
  });

  it('el creador elige niveles: solo grupos vivos de su aula', async () => {
    await expect(
      asTenant(() =>
        community.createSpace(tenantId, ids.admin, {
          slug: `x-${stamp}`,
          title: 'X',
          accessGroupIds: [groups.borrado],
        }),
      ),
    ).rejects.toBeInstanceOf(AccessGroupUnknownError);
    await expect(
      asTenant(() =>
        community.updateSpace(tenantId, 'general', { accessGroupIds: [randomUUID()] }),
      ),
    ).rejects.toBeInstanceOf(AccessGroupUnknownError);
    const ok = await asTenant(() =>
      community.createSpace(tenantId, ids.admin, {
        slug: `vip-${stamp}`,
        title: 'VIP',
        accessGroupIds: [groups.pro, groups.basico, groups.pro],
      }),
    );
    expect(ok.accessGroupIds).toEqual([groups.pro, groups.basico]);
    // Vaciar la lista lo abre a todos.
    const abierto = await asTenant(() =>
      community.updateSpace(tenantId, `vip-${stamp}`, { accessGroupIds: [] }),
    );
    expect(abierto.accessGroupIds).toEqual([]);
  });

  it('sala de chat del espacio cerrado: ni sale, ni se abre, ni se lee, ni recibe', async () => {
    const lista = await asTenant(() => messaging.listConversations(tenantId, caller('basico')));
    expect(lista.map((c) => c.space?.slug)).not.toContain('pro');
    await expect(
      asTenant(() => messaging.openSpace(tenantId, caller('basico'), 'pro')),
    ).rejects.toBeInstanceOf(SpaceNotFoundError);
    await expect(
      asTenant(() => messaging.listMessages(tenantId, caller('basico'), roomPro)),
    ).rejects.toBeInstanceOf(NotParticipantError);
    await expect(
      asTenant(() => messaging.sendMessage(tenantId, caller('basico'), roomPro, 'hola')),
    ).rejects.toBeInstanceOf(NotParticipantError);
    // Control: el de Pro abre la sala, escribe, y el push no llega al básico
    // (que la había abierto antes del cierre) pero sí al equipo que entró.
    const abre = await asTenant(() => messaging.openSpace(tenantId, caller('pro'), 'pro'));
    expect(abre.conversationId).toBe(roomPro);
    await asTenant(() => messaging.openSpace(tenantId, caller('profe'), 'pro'));
    const envio = await asTenant(() =>
      messaging.sendMessage(tenantId, caller('pro'), roomPro, 'Solo Pro'),
    );
    expect(envio.recipientUserIds).toContain(ids.profe);
    expect(envio.recipientUserIds).not.toContain(ids.basico);
    const listaPro = await asTenant(() => messaging.listConversations(tenantId, caller('pro')));
    expect(listaPro.map((c) => c.space?.slug)).toContain('pro');
  });

  // ── Directos ──────────────────────────────────────────────────────────────

  it('directo: listado y detalle cerrados (sin descripción, enlace ni grabación)', async () => {
    const lista = await asTenant(() => zoom.list(tenantId, {}, zViewer('basico')));
    const cerrada = lista.find((s) => s.id === sessionId)!;
    expect(cerrada).toMatchObject({
      locked: true,
      topic: 'Masterclass Pro',
      description: null,
      joinUrl: null,
      recordingUrl: null,
      zoomMeetingId: null,
      hostEmail: '',
      accessLevels: [{ id: groups.pro, name: 'Pro' }],
    });
    const detalle = await asTenant(() => zoom.get(tenantId, sessionId, zViewer('basico')));
    expect(detalle.locked).toBe(true);
    expect(JSON.stringify(detalle)).not.toContain('secreta');
    // Aunque estuviera inscrito, perder el nivel no le deja ver nada.
    expect(detalle.isRegistered).toBe(false);
    const revocado = await asTenant(() => zoom.get(tenantId, sessionId, zViewer('revocado')));
    expect(revocado.locked).toBe(true);
    // Control.
    const pro = await asTenant(() => zoom.get(tenantId, sessionId, zViewer('pro')));
    expect(pro).toMatchObject({ locked: false, description: 'Agenda secreta de la masterclass' });
    const profe = await asTenant(() => zoom.get(tenantId, sessionId, zViewer('profe')));
    expect(profe).toMatchObject({
      locked: false,
      joinUrl: 'https://meet.example.com/sala-pro-secreta',
      recordingUrl: 'https://zoom.example.com/rec/pro-secreta',
      accessGroupIds: [groups.pro],
    });
  });

  it('directo: inscribirse y pedir el enlace sin el nivel → ZOOM_SESSION_LOCKED', async () => {
    await expect(
      asTenant(() => zoom.register(tenantId, ids.basico, sessionId)),
    ).rejects.toBeInstanceOf(SessionLockedError);
    // Estaba inscrito de antes: aun así, ni enlace.
    await expect(
      asTenant(() => zoom.markJoinClick(tenantId, ids.basico, sessionId)),
    ).rejects.toBeInstanceOf(SessionLockedError);
    expect(await asTenant(() => zoom.canView(tenantId, sessionId, zViewer('basico')))).toBe(false);
    // Control.
    const v = await asTenant(() => zoom.register(tenantId, ids.pro, sessionId));
    expect(v.joinUrl).toBe('https://meet.example.com/sala-pro-secreta');
    expect(v.recordingUrl).toBe('https://zoom.example.com/rec/pro-secreta');
    const join = await asTenant(() => zoom.markJoinClick(tenantId, ids.pro, sessionId));
    expect(join.joinUrl).toBe('https://meet.example.com/sala-pro-secreta');
    expect(await asTenant(() => zoom.canView(tenantId, sessionId, zViewer('pro')))).toBe(true);
  });

  it('directo: recordatorios, encuestas y aviso de cancelación solo a quien puede', async () => {
    const inscritos = await asTenant(() => zoom.listRegisteredUserIds(tenantId, sessionId));
    expect(inscritos).toContain(ids.pro);
    expect(inscritos).not.toContain(ids.basico);

    events.length = 0;
    await asTenant(() => zoom.cancel(tenantId, ids.profe, sessionId));
    const cancelada = events.find((e) => e.name === 'zoom.session.cancelled');
    expect(cancelada?.data['registeredUserIds']).toEqual([ids.pro]);
  });

  it('directo: los niveles elegidos tienen que existir y estar vivos', async () => {
    await expect(
      asTenant(() =>
        zoom.create(tenantId, ids.profe, {
          topic: 'X',
          startTime: new Date(Date.now() + 86_400_000).toISOString(),
          durationMinutes: 30,
          timezone: 'Europe/Madrid',
          hostEmail: `${handle('profe')}@example.com`,
          externalJoinUrl: 'https://meet.example.com/x',
          accessGroupIds: [groups.borrado],
        }),
      ),
    ).rejects.toBeInstanceOf(SessionAccessGroupUnknownError);
    // Control: abierta (sin niveles) la ve todo el mundo.
    const abierta = await asTenant(() =>
      zoom.create(tenantId, ids.profe, {
        topic: 'Abierta',
        startTime: new Date(Date.now() + 86_400_000).toISOString(),
        durationMinutes: 30,
        timezone: 'Europe/Madrid',
        hostEmail: `${handle('profe')}@example.com`,
        externalJoinUrl: 'https://meet.example.com/abierta',
      }),
    );
    const vista = await asTenant(() => zoom.get(tenantId, abierta.id, zViewer('basico')));
    expect(vista.locked).toBe(false);
  });
});
