/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import {
  CommunitySidebarService,
  isShareableHost,
  publicName,
  SIDEBAR_CACHE_TTL_MS,
  SIDEBAR_FACES,
} from './community-sidebar.service';

/**
 * Barra lateral de la comunidad: cada bloque sale de datos REALES de un aula y
 * desaparece (null / vacío) cuando no los hay. La base falsa guarda filas de
 * DOS aulas y EXIGE `tenantId` en cada consulta: si una se olvidara del filtro,
 * el test revienta en vez de pasar por casualidad.
 */

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';

interface UserRow {
  id: string;
  tenantId: string;
  name: string | null;
  avatarUrl: string | null;
  status: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'DEACTIVATED';
  deletedAt: Date | null;
  createdAt: Date;
  roles: string[];
}

interface World {
  tenants: Record<string, string>;
  themes: Record<
    string,
    {
      logoUrl: string | null;
      logoDisplayMode: string;
      signinHeadline: string | null;
      about?: string | null;
      coverUrl?: string | null;
      socialLinks?: unknown;
    }
  >;
  domains: Array<{ tenantId: string; hostname: string; isPrimary: boolean; surface: string }>;
  users: UserRow[];
  enabled: Record<string, string[]>;
  presence: Record<string, string[]>;
  points: Record<string, Array<{ userId: string; points: number }>>;
  comments: Record<
    string,
    Array<{
      id: string;
      postId: string;
      postTitle: string;
      authorId: string;
      authorDisplayName: string | null;
      excerpt: string;
      createdAt: Date;
    }>
  >;
}

let seq = 0;
function user(tenantId: string, name: string | null, extra: Partial<UserRow> = {}): UserRow {
  seq += 1;
  return {
    id: `${tenantId.slice(-1)}-u${seq}`,
    tenantId,
    name,
    avatarUrl: `https://cdn.example.com/${seq}.png`,
    status: 'ACTIVE',
    deletedAt: null,
    createdAt: new Date(Date.UTC(2026, 0, seq)),
    roles: [],
    ...extra,
  };
}

interface UserWhere {
  tenantId?: string;
  status?: string;
  deletedAt?: null;
  id?: { in: string[] };
  roles?: { some: { role: { name: { in: string[] } } } };
}
interface UserQuery {
  where: UserWhere;
  orderBy?: { createdAt?: 'asc' | 'desc' };
  take?: number;
}
interface TenantWhere {
  tenantId?: string;
  isPrimary?: boolean;
  surface?: string;
}

function requireTenant(where: { tenantId?: unknown } | undefined, model: string): string {
  const t = where?.tenantId;
  if (typeof t !== 'string') throw new Error(`${model}: consulta sin tenantId`);
  return t;
}

function matchesUser(u: UserRow, where: UserWhere): boolean {
  if (u.tenantId !== requireTenant(where, 'user')) return false;
  if (where.status && u.status !== where.status) return false;
  if ('deletedAt' in where && where.deletedAt === null && u.deletedAt !== null) return false;
  if (where.id?.in && !where.id.in.includes(u.id)) return false;
  const roleIn = where.roles?.some.role.name.in;
  if (roleIn && !u.roles.some((r) => roleIn.includes(r))) return false;
  return true;
}

function build(world: World) {
  // `academy` cuenta las lecturas de la tarjeta (en vivo, fuera de la caché);
  // `queries`, todo lo demás.
  const calls = { queries: 0, academy: 0 };
  const prisma = {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        calls.academy++;
        const name = world.tenants[where.id];
        return name === undefined ? null : { name };
      },
    },
    modThemingTenantTheme: {
      findUnique: async ({ where }: { where: TenantWhere }) => {
        calls.academy++;
        return world.themes[requireTenant(where, 'theme')] ?? null;
      },
    },
    tenantDomain: {
      findFirst: async ({ where }: { where: TenantWhere }) => {
        calls.academy++;
        const t = requireTenant(where, 'tenantDomain');
        return (
          world.domains.find(
            (d) =>
              d.tenantId === t &&
              (where.isPrimary === undefined || d.isPrimary === where.isPrimary) &&
              (where.surface === undefined || d.surface === where.surface),
          ) ?? null
        );
      },
    },
    user: {
      count: async ({ where }: UserQuery) => {
        calls.queries++;
        return world.users.filter((u) => matchesUser(u, where)).length;
      },
      findMany: async ({ where, orderBy, take }: UserQuery) => {
        calls.queries++;
        let rows = world.users.filter((u) => matchesUser(u, where));
        if (orderBy?.createdAt) {
          const dir = orderBy.createdAt === 'desc' ? -1 : 1;
          rows = [...rows].sort((a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime()));
        }
        if (take) rows = rows.slice(0, take);
        return rows.map((u) => ({ id: u.id, name: u.name, avatarUrl: u.avatarUrl }));
      },
    },
  };
  const registry = {
    getGamificationService: () => ({
      leaderboard: async (tenantId: string, range: string, limit: number) => {
        calls.queries++;
        expect(range).toBe('month');
        const rows = [...(world.points[tenantId] ?? [])]
          .filter((r) => r.points > 0)
          .sort((a, b) => b.points - a.points)
          .slice(0, limit)
          .map((r, i) => ({ ...r, rank: i + 1 }));
        return { rows, total: rows.length };
      },
    }),
    getCommunityService: () => ({
      listRecentComments: async (tenantId: string, limit: number) => {
        calls.queries++;
        return (world.comments[tenantId] ?? []).slice(0, limit);
      },
    }),
  };
  const tenantModules = {
    list: async (tenantId: string) => {
      calls.queries++;
      const on = world.enabled[tenantId] ?? [];
      return ['mod.community', 'mod.gamification', 'mod.messaging'].map((name) => ({
        name,
        enabled: on.includes(name),
      }));
    },
  };
  const presence = {
    snapshot: async (tenantId: string) => {
      calls.queries++;
      const ids = world.presence[tenantId] ?? [];
      return { onlineCount: ids.length, onlineUserIds: ids };
    },
  };
  const service = new CommunitySidebarService(
    prisma as never,
    registry as never,
    tenantModules as never,
    presence as never,
  );
  return { service, calls };
}

/** Dos aulas con datos de todo tipo; B existe para que nada suyo se cuele en A. */
type AcademyA = Record<'owner' | 'ana' | 'bea' | 'carla' | 'gone' | 'pending', UserRow>;
type AcademyB = Record<'owner' | 'zoe', UserRow>;

function twoAcademies(): World & { a: AcademyA; b: AcademyB } {
  const a: AcademyA = {
    owner: user(A, 'Lucía Admin', { roles: ['tenant_admin'] }),
    ana: user(A, 'Ana'),
    bea: user(A, 'Bea'),
    carla: user(A, null),
    gone: user(A, 'Borrada', { deletedAt: new Date() }),
    pending: user(A, 'Pendiente', { status: 'PENDING' }),
  };
  const b: AcademyB = {
    owner: user(B, 'Admin de B', { roles: ['tenant_admin', 'super_admin'] }),
    zoe: user(B, 'Zoe de B'),
  };
  return {
    a,
    b,
    tenants: { [A]: 'Morning Pour', [B]: 'Otra Academia' },
    themes: {
      [A]: {
        logoUrl: 'https://cdn.example.com/logo-a.png',
        logoDisplayMode: 'logo_and_name',
        signinHeadline: '  Brew better coffee at home.  ',
      },
      [B]: {
        logoUrl: 'https://cdn.example.com/logo-b.png',
        logoDisplayMode: 'logo_only',
        signinHeadline: 'B',
      },
    },
    domains: [
      { tenantId: A, hostname: 'morningpour.example.com', isPrimary: true, surface: 'APP' },
      { tenantId: B, hostname: 'otra.example.com', isPrimary: true, surface: 'APP' },
    ],
    users: [...Object.values(a), ...Object.values(b)],
    enabled: {
      [A]: ['mod.community', 'mod.gamification', 'mod.messaging'],
      [B]: ['mod.community', 'mod.gamification', 'mod.messaging'],
    },
    // La presencia de A trae a una persona de B y a una borrada: no cuentan.
    presence: { [A]: [a.bea.id, a.gone.id, b.zoe.id], [B]: [b.zoe.id] },
    points: {
      [A]: [
        { userId: a.ana.id, points: 120 },
        { userId: a.gone.id, points: 90 },
        { userId: a.bea.id, points: 40 },
      ],
      [B]: [{ userId: b.zoe.id, points: 999 }],
    },
    comments: {
      [A]: [
        {
          id: 'c1',
          postId: 'p1',
          postTitle: 'Best grinder?',
          authorId: a.ana.id,
          authorDisplayName: 'Ana',
          excerpt: 'Burr, always.',
          createdAt: new Date('2026-11-10T10:00:00Z'),
        },
      ],
      [B]: [
        {
          id: 'cb',
          postId: 'pb',
          postTitle: 'De B',
          authorId: b.zoe.id,
          authorDisplayName: 'Zoe de B',
          excerpt: 'secreto de B',
          createdAt: new Date('2026-11-11T10:00:00Z'),
        },
      ],
    },
  };
}

describe('CommunitySidebarService', () => {
  it('compone la barra con los datos reales del aula y nada de la otra', async () => {
    const world = twoAcademies();
    const { service } = build(world);
    const data = await service.get(A);

    expect(data.academy).toEqual({
      name: 'Morning Pour',
      logoUrl: 'https://cdn.example.com/logo-a.png',
      logoDisplayMode: 'logo_and_name',
      // Sin portada, descripción propia ni enlaces: banda de color, titular de
      // acceso y nada de enlaces, como antes de que existieran.
      coverUrl: null,
      description: 'Brew better coffee at home.',
      host: 'morningpour.example.com',
      links: [],
    });
    // 4 activos: la borrada y la pendiente no cuentan. 1 admin.
    expect(data.members.total).toBe(4);
    expect(data.members.admins).toBe(1);
    // Online: solo Bea (la de B y la borrada se descartan).
    expect(data.members.online).toBe(1);
    expect(data.members.faces[0]).toMatchObject({ id: world.a.bea.id, online: true });
    expect(data.members.faces.map((f) => f.id)).not.toContain(world.b.zoe.id);
    // Ranking: la borrada sale y los puestos se renumeran sin huecos.
    expect(data.leaderboard).toEqual({
      range: 'month',
      entries: [
        expect.objectContaining({ id: world.a.ana.id, name: 'Ana', rank: 1, points: 120 }),
        expect.objectContaining({ id: world.a.bea.id, name: 'Bea', rank: 2, points: 40 }),
      ],
    });
    expect(data.recentComments).toEqual([
      {
        id: 'c1',
        postId: 'p1',
        postTitle: 'Best grinder?',
        author: { id: world.a.ana.id, name: 'Ana', avatarUrl: world.a.ana.avatarUrl },
        excerpt: 'Burr, always.',
        createdAt: '2026-11-10T10:00:00.000Z',
      },
    ]);
    const todo = JSON.stringify(data);
    for (const deB of ['Otra Academia', 'Zoe de B', 'secreto de B', 'logo-b', 'otra.example.com']) {
      expect(todo).not.toContain(deB);
    }
  });

  it('el aula B ve lo suyo, con su propia caché', async () => {
    const world = twoAcademies();
    const { service } = build(world);
    await service.get(A);
    const b = await service.get(B);
    expect(b.academy.name).toBe('Otra Academia');
    expect(b.members.total).toBe(2);
    expect(b.leaderboard?.entries.map((e) => e.name)).toEqual(['Zoe de B']);
    expect(b.recentComments.map((c) => c.id)).toEqual(['cb']);
  });

  it('cada bloque desaparece sin datos: nada de huecos ni ceros', async () => {
    const solo = user(A, 'Solo Alumno');
    const { service } = build({
      tenants: { [A]: 'Aula Vacía' },
      themes: {},
      domains: [{ tenantId: A, hostname: 'localhost', isPrimary: true, surface: 'APP' }],
      users: [solo],
      enabled: { [A]: ['mod.community', 'mod.gamification', 'mod.messaging'] },
      presence: {},
      points: {},
      comments: {},
    });
    const data = await service.get(A);
    expect(data.academy).toEqual({
      name: 'Aula Vacía',
      logoUrl: null,
      logoDisplayMode: 'logo_only',
      coverUrl: null,
      description: null,
      host: null,
      links: [],
    });
    expect(data.members).toEqual({
      total: 1,
      admins: null,
      online: null,
      faces: [{ id: solo.id, name: 'Solo Alumno', avatarUrl: solo.avatarUrl, online: false }],
    });
    expect(data.leaderboard).toBeNull();
    expect(data.recentComments).toEqual([]);
  });

  it('quien mira cuenta como en línea aunque su stream aún no se haya registrado', async () => {
    const world = twoAcademies();
    world.presence[A] = [];
    const { service } = build(world);
    const data = await service.get(A, world.a.ana.id);
    expect(data.members.online).toBe(1);
    expect(data.members.faces[0]).toMatchObject({ id: world.a.ana.id, online: true });
  });

  it('la presencia es en vivo: no se queda en la caché del aula', async () => {
    const world = twoAcademies();
    const { service } = build(world);
    let now = 1_000_000;
    service.clock = () => now;
    expect((await service.get(A)).members.online).toBe(1);
    world.presence[A] = [world.a.bea.id, world.a.ana.id, world.a.carla.id];
    now += 1_000;
    expect((await service.get(A)).members.online).toBe(3);
  });

  it('un visitante de otra aula no suma en línea ni sale entre las caras', async () => {
    const world = twoAcademies();
    world.presence[A] = [];
    const { service } = build(world);
    const data = await service.get(A, world.b.zoe.id);
    expect(data.members.online).toBeNull();
    expect(data.members.faces.map((f) => f.id)).not.toContain(world.b.zoe.id);
  });

  it('la tarjeta con portada, descripción propia y enlaces (y nada de la otra aula)', async () => {
    const world = twoAcademies();
    world.themes[A] = {
      ...world.themes[A]!,
      about: '  Home baristas learning together.  ',
      coverUrl: '/api/v1/modules/theming/tenants/a/cover?v=1',
      socialLinks: [
        { kind: 'instagram', url: 'https://instagram.com/' },
        { kind: 'whatsapp', url: 'https://wa.me/' },
      ],
    };
    world.themes[B] = {
      ...world.themes[B]!,
      about: 'Descripción de B',
      coverUrl: '/api/v1/modules/theming/tenants/b/cover?v=1',
      socialLinks: [{ kind: 'youtube', url: 'https://youtube.com/@de-b' }],
    };
    const { service } = build(world);
    const a = await service.get(A);
    expect(a.academy).toMatchObject({
      coverUrl: '/api/v1/modules/theming/tenants/a/cover?v=1',
      // La descripción propia manda sobre el titular de acceso.
      description: 'Home baristas learning together.',
      links: [
        { kind: 'instagram', url: 'https://instagram.com/' },
        { kind: 'whatsapp', url: 'https://wa.me/' },
      ],
    });
    const todo = JSON.stringify(a);
    for (const deB of ['Descripción de B', 'tenants/b/cover', '@de-b']) {
      expect(todo).not.toContain(deB);
    }
    expect((await service.get(B)).academy.description).toBe('Descripción de B');
  });

  it('sin descripción propia (o en blanco) cae al titular de acceso', async () => {
    const world = twoAcademies();
    world.themes[A]!.about = '   ';
    const { service } = build(world);
    expect((await service.get(A)).academy.description).toBe('Brew better coffee at home.');
  });

  it('enlaces de la base que el DTO no aceptaría no llegan a la tarjeta', async () => {
    const world = twoAcademies();
    world.themes[A]!.socialLinks = [
      { kind: 'whatsapp', url: 'https://evil.example.com/wa' },
      { kind: 'web', url: 'javascript:alert(1)' },
      { kind: 'instagram', url: 'http://instagram.com/x' },
      { kind: 'fax', url: 'https://fax.example.com' },
      'https://suelto.example.com',
      { kind: 'web', url: 'https://morningpour.example.com' },
    ];
    const { service } = build(world);
    expect((await service.get(A)).academy.links).toEqual([
      { kind: 'web', url: 'https://morningpour.example.com' },
    ]);
  });

  it('la tarjeta se lee en vivo: un cambio en Ajustes se ve sin esperar a la caché', async () => {
    const world = twoAcademies();
    const { service } = build(world);
    let now = 1_000_000;
    service.clock = () => now;
    await service.get(A);
    now += 1_000;
    world.themes[A]!.about = 'Nueva descripción';
    world.themes[A]!.coverUrl = '/api/v1/modules/theming/tenants/a/cover?v=2';
    const data = await service.get(A);
    expect(data.academy.description).toBe('Nueva descripción');
    expect(data.academy.coverUrl).toBe('/api/v1/modules/theming/tenants/a/cover?v=2');
  });

  it('un titular en blanco no es una descripción', async () => {
    const world = twoAcademies();
    world.themes[A]!.signinHeadline = '   ';
    const { service } = build(world);
    expect((await service.get(A)).academy.description).toBeNull();
  });

  it('sin mod.gamification no hay ranking aunque haya puntos; sin mensajería no hay «en línea»', async () => {
    const world = twoAcademies();
    world.enabled[A] = ['mod.community'];
    const { service, calls } = build(world);
    const data = await service.get(A, world.a.ana.id);
    expect(data.leaderboard).toBeNull();
    expect(data.members.online).toBeNull();
    expect(data.members.faces.every((f) => !f.online)).toBe(true);
    expect(calls.queries).toBeGreaterThan(0);
  });

  it('puntos solo a cero o de gente que ya no está: sin ranking', async () => {
    const world = twoAcademies();
    world.points[A] = [{ userId: world.a.gone.id, points: 50 }];
    const { service } = build(world);
    expect((await service.get(A)).leaderboard).toBeNull();
  });

  it('caras: primero quien está en línea, sin repetir, con tope', async () => {
    const many = Array.from({ length: 12 }, (_, i) => user(A, `Miembro ${i}`));
    const last = many[many.length - 1]!;
    const first = many[0]!;
    const { service } = build({
      tenants: { [A]: 'Aula' },
      themes: {},
      domains: [],
      users: many,
      enabled: { [A]: ['mod.messaging'] },
      presence: { [A]: [first.id, last.id] },
      points: {},
      comments: {},
    });
    const { members } = await service.get(A);
    expect(members.faces).toHaveLength(SIDEBAR_FACES);
    expect(members.faces.slice(0, 2).map((f) => f.online)).toEqual([true, true]);
    expect(new Set(members.faces.map((f) => f.id)).size).toBe(SIDEBAR_FACES);
    // Tras los de en línea, los que llegaron últimos.
    expect(members.faces[2]?.id).toBe(many[10]!.id);
  });

  it('nunca enseña un correo como nombre', async () => {
    const world = twoAcademies();
    world.a.carla.name = 'carla@example.com';
    world.comments[A] = [
      {
        id: 'c2',
        postId: 'p1',
        postTitle: 'Hola',
        authorId: world.a.carla.id,
        authorDisplayName: 'carla@example.com',
        excerpt: 'hola',
        createdAt: new Date(),
      },
    ];
    const { service } = build(world);
    const data = await service.get(A);
    expect(JSON.stringify(data)).not.toContain('carla@example.com');
    expect(data.recentComments[0]?.author.name).toBeNull();
  });

  it('cachea por aula unos segundos y vuelve a leer al caducar', async () => {
    const world = twoAcademies();
    // Sin mensajería: así no hay lecturas EN VIVO de la presencia y cada
    // consulta contada es de la parte cacheable.
    world.enabled[A] = ['mod.community', 'mod.gamification'];
    const { service, calls } = build(world);
    let now = 1_000_000;
    service.clock = () => now;
    await service.get(A);
    const tras1 = calls.queries;
    world.points[A] = [{ userId: world.a.bea.id, points: 999 }];
    // Dentro de la vida de la caché no se repiten ni los COUNT ni el ranking.
    expect((await service.get(A)).leaderboard?.entries[0]?.name).toBe('Ana');
    expect(calls.queries).toBe(tras1);
    now += SIDEBAR_CACHE_TTL_MS + 1;
    expect((await service.get(A)).leaderboard?.entries[0]?.name).toBe('Bea');
    expect(calls.queries).toBeGreaterThan(tras1);
  });

  it('invalidate() olvida un aula concreta', async () => {
    const world = twoAcademies();
    const { service } = build(world);
    await service.get(A);
    world.points[A] = [{ userId: world.a.bea.id, points: 999 }];
    service.invalidate(A);
    expect((await service.get(A)).leaderboard?.entries[0]?.name).toBe('Bea');
  });
});

describe('isShareableHost', () => {
  it.each([
    ['morningpour.example.com', true],
    ['aula.va.didacta.app', true],
    ['localhost', false],
    ['aula.localhost', false],
    ['127.0.0.1', false],
    ['demo.test', false],
    ['intranet', false],
    ['aula.local', false],
  ])('%s → %s', (host, ok) => {
    expect(isShareableHost(host)).toBe(ok);
  });
});

describe('publicName', () => {
  it('descarta vacíos y correos', () => {
    expect(publicName('  Ana  ')).toBe('Ana');
    expect(publicName('')).toBeNull();
    expect(publicName(null)).toBeNull();
    expect(publicName('ana@example.com')).toBeNull();
  });
});
