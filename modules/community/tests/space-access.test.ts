import { describe, expect, it } from 'vitest';
import {
  NO_ACCESS_GROUPS,
  SpaceAccess,
  seesAllSpaces,
  type AccessGroupMembership,
} from '../src/space-access.js';

/**
 * Reglas de los espacios restringidos por nivel, sin base: un doble de Prisma
 * con los espacios y los roles, y un doble del puerto de pertenencia.
 */

const T = 'tenant-1';

interface SpaceRow {
  id: string;
  tenantId: string;
  slug: string;
  accessGroupIds: string[];
}

function makeAccess(opts: {
  spaces: SpaceRow[];
  staff?: string[];
  members?: Record<string, string[]>; // userId → grupos activos
  names?: Record<string, string>; // grupos vivos
}) {
  const calls = { spaces: 0, groupsOf: 0 };
  const prisma = {
    modCommunitySpace: {
      async findMany(args: { where: { tenantId: string } }) {
        calls.spaces++;
        return opts.spaces
          .filter((s) => s.tenantId === args.where.tenantId && s.accessGroupIds.length > 0)
          .map((s) => ({ id: s.id, slug: s.slug, accessGroupIds: s.accessGroupIds }));
      },
    },
    user: {
      async findMany(args: { where: { id: { in: string[] } } }) {
        return args.where.id.in
          .filter((id) => (opts.staff ?? []).includes(id))
          .map((id) => ({ id }));
      },
    },
  };
  const members = opts.members ?? {};
  const membership: AccessGroupMembership = {
    activeGroupIdsOf: async (_t, userId) => {
      calls.groupsOf++;
      return members[userId] ?? [];
    },
    activeMembersAmong: async (_t, groupIds, userIds) =>
      userIds.filter((u) => (members[u] ?? []).some((g) => groupIds.includes(g))),
    groupNames: async (_t, ids) =>
      ids.filter((id) => opts.names?.[id]).map((id) => ({ id, name: opts.names![id]! })),
  };
  return { access: new SpaceAccess(prisma as never, membership), calls };
}

const SPACES: SpaceRow[] = [
  { id: 's-general', tenantId: T, slug: 'general', accessGroupIds: [] },
  { id: 's-pro', tenantId: T, slug: 'pro', accessGroupIds: ['g-pro'] },
  { id: 's-vip', tenantId: T, slug: 'vip', accessGroupIds: ['g-pro', 'g-vip'] },
  { id: 's-otro', tenantId: 'otro', slug: 'secreto', accessGroupIds: ['g-x'] },
];

describe('SpaceAccess.blockedSlugs', () => {
  it('sin nivel: cerrados todos los espacios con nivel del aula (no los de otra)', async () => {
    const { access } = makeAccess({ spaces: SPACES });
    expect(await access.blockedSlugs(T, { userId: 'u-nadie', seesEverything: false })).toEqual([
      'pro',
      'vip',
    ]);
  });

  it('con un nivel: se abren los espacios de ese nivel', async () => {
    const { access } = makeAccess({ spaces: SPACES, members: { 'u-pro': ['g-pro'] } });
    expect(await access.blockedSlugs(T, { userId: 'u-pro', seesEverything: false })).toEqual([]);
    const { access: a2 } = makeAccess({ spaces: SPACES, members: { 'u-vip': ['g-vip'] } });
    expect(await a2.blockedSlugs(T, { userId: 'u-vip', seesEverything: false })).toEqual(['pro']);
  });

  it('el equipo lo ve todo y ni siquiera consulta', async () => {
    const { access, calls } = makeAccess({ spaces: SPACES });
    expect(await access.blockedSlugs(T, { userId: 'u-admin', seesEverything: true })).toEqual([]);
    expect(calls.spaces).toBe(0);
  });

  it('un aula sin espacios con nivel no pregunta por los grupos de nadie', async () => {
    const { access, calls } = makeAccess({ spaces: [SPACES[0]!] });
    expect(await access.blockedSlugs(T, { userId: 'u-1', seesEverything: false })).toEqual([]);
    expect(calls.groupsOf).toBe(0);
  });

  it('sin persona (anónimo) y sin puerto (falla cerrado): todo lo restringido cerrado', async () => {
    const { access } = makeAccess({ spaces: SPACES, members: { 'u-pro': ['g-pro'] } });
    expect(await access.blockedSlugs(T, { seesEverything: false })).toEqual(['pro', 'vip']);
    const sinPuerto = new SpaceAccess(
      {
        modCommunitySpace: { findMany: async () => SPACES.slice(0, 3) },
        user: { findMany: async () => [] },
      } as never,
      NO_ACCESS_GROUPS,
    );
    expect(await sinPuerto.blockedSlugs(T, { userId: 'u-pro', seesEverything: false })).toEqual([
      'pro',
      'vip',
    ]);
  });
});

describe('SpaceAccess: filtro de posts', () => {
  it('postWhere excluye por etiqueta y no añade nada si no hay cierres', () => {
    expect(SpaceAccess.postWhere([])).toEqual({});
    expect(SpaceAccess.postWhere(['pro'])).toEqual({ NOT: { tags: { hasSome: ['pro'] } } });
  });

  it('isBlocked: manda el cierre si el post está en dos espacios; no distingue mayúsculas', () => {
    expect(SpaceAccess.isBlocked(['general', 'pro'], ['pro'])).toBe(true);
    expect(SpaceAccess.isBlocked(['PRO'], ['pro'])).toBe(true);
    expect(SpaceAccess.isBlocked(['general'], ['pro'])).toBe(false);
    expect(SpaceAccess.isBlocked(['pro'], [])).toBe(false);
  });
});

describe('SpaceAccess: audiencia de avisos', () => {
  it('de un post en un espacio con nivel: equipo + miembros del nivel', async () => {
    const { access } = makeAccess({
      spaces: SPACES,
      staff: ['u-admin'],
      members: { 'u-pro': ['g-pro'], 'u-vip': ['g-vip'] },
    });
    const a = await access.audienceForTags(T, ['pro'], ['u-admin', 'u-pro', 'u-vip', 'u-nadie']);
    expect([...a].sort()).toEqual(['u-admin', 'u-pro']);
  });

  it('en dos espacios con nivel: hay que poder ver los dos', async () => {
    const { access } = makeAccess({
      spaces: [...SPACES, { id: 's-b', tenantId: T, slug: 'b', accessGroupIds: ['g-b'] }],
      members: { 'u-pro': ['g-pro'], 'u-ambos': ['g-pro', 'g-b'] },
    });
    const a = await access.audienceForTags(T, ['pro', 'b'], ['u-pro', 'u-ambos']);
    expect([...a]).toEqual(['u-ambos']);
  });

  it('de un post abierto: todos (sin consultar roles ni grupos)', async () => {
    const { access, calls } = makeAccess({ spaces: SPACES });
    const a = await access.audienceForTags(T, ['general'], ['u-1', 'u-2']);
    expect([...a].sort()).toEqual(['u-1', 'u-2']);
    expect(calls.groupsOf).toBe(0);
  });

  it('de una sala de espacio (por id)', async () => {
    const { access } = makeAccess({ spaces: SPACES, members: { 'u-pro': ['g-pro'] } });
    expect([...(await access.audienceForSpace(T, 's-pro', ['u-pro', 'u-x']))]).toEqual(['u-pro']);
    expect([...(await access.audienceForSpace(T, 's-general', ['u-pro', 'u-x']))]).toEqual([
      'u-pro',
      'u-x',
    ]);
  });
});

describe('SpaceAccess.checkGroups y roles del equipo', () => {
  it('solo grupos vivos del aula; quita repetidos', async () => {
    const { access } = makeAccess({ spaces: SPACES, names: { 'g-pro': 'Pro' } });
    expect(await access.checkGroups(T, ['g-pro', 'g-pro'])).toEqual({ ok: true, ids: ['g-pro'] });
    expect(await access.checkGroups(T, ['g-pro', 'g-borrado'])).toEqual({
      ok: false,
      missing: 'g-borrado',
    });
    expect(await access.checkGroups(T, [])).toEqual({ ok: true, ids: [] });
  });

  it('admin, tenant_admin y formador son equipo; un alumno no', () => {
    expect(seesAllSpaces(['formador'])).toBe(true);
    expect(seesAllSpaces(['tenant_admin'])).toBe(true);
    expect(seesAllSpaces(['super_admin'])).toBe(true);
    expect(seesAllSpaces(['alumno'])).toBe(false);
    expect(seesAllSpaces([])).toBe(false);
  });
});
