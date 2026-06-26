/**
 * Tests de `AccessGroupsService` (mod.access-groups, Fase 2).
 *
 * Cubre la lógica de negocio central:
 *  - createGroup: validación ALL_COURSES sin cursos explícitos, slug derivado y único.
 *  - assignMembers: fan-out a enrollments (ALL_COURSES → todos los publicados;
 *    COURSE → cursos del grupo), idempotencia (no duplica membresía/grant ni memberCount).
 *  - revokeMember: refcount — desmatricula solo si ningún otro grupo vivo otorga el curso.
 *  - setGroupCourses: reconciliación (otorga añadidos, revoca quitados por refcount).
 *  - assignDefaultGroupOnApproval: usa el grupo por defecto; fallback enroll-all-published.
 *  - onCoursePublished: otorga el curso nuevo a miembros de grupos ALL_COURSES autoGrant.
 *
 * Usa fake-prisma in-memory + mocks de ModuleRegistryService (courses/learning).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AlreadyEnrolledError } from '@didacta/mod-learning';
import { AccessGroupsService } from '../src/modules/access-groups/access-groups.service';

const TENANT = 'tenant-1';

interface GroupRow {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  kind: 'ALL_COURSES' | 'COURSE' | 'MULTI_COURSE';
  isDefaultForApproval: boolean;
  autoGrantNewCourses: boolean;
  memberCount: number;
  createdAt: Date;
  deletedAt: Date | null;
}
interface CourseRow {
  id: string;
  groupId: string;
  tenantId: string;
  courseId: string;
}
interface MemberRow {
  id: string;
  groupId: string;
  tenantId: string;
  userId: string;
  status: string;
  revokedAt: Date | null;
}
interface GrantRow {
  id: string;
  tenantId: string;
  groupId: string;
  userId: string;
  courseId: string;
  revokedAt: Date | null;
}

function makeHarness(opts: { publishedCourses?: string[] } = {}) {
  const groups: GroupRow[] = [];
  const groupCourses: CourseRow[] = [];
  const members: MemberRow[] = [];
  const grants: GrantRow[] = [];
  let seq = 1;
  const id = (p: string) => `${p}-${seq++}`;

  const prisma = {
    modAccessGroup: {
      async create({ data }: { data: Partial<GroupRow> }) {
        const row: GroupRow = {
          id: id('grp'),
          tenantId: data.tenantId!,
          slug: data.slug!,
          name: data.name!,
          description: data.description ?? null,
          kind: data.kind!,
          isDefaultForApproval: data.isDefaultForApproval ?? false,
          autoGrantNewCourses: data.autoGrantNewCourses ?? true,
          memberCount: 0,
          createdAt: new Date(),
          deletedAt: null,
        };
        groups.push(row);
        return row;
      },
      async findFirst({
        where,
        include,
      }: {
        where: Record<string, unknown>;
        include?: { courses?: unknown; members?: unknown };
      }) {
        const g =
          groups.find(
            (x) =>
              (where.id === undefined || x.id === where.id) &&
              (where.tenantId === undefined || x.tenantId === where.tenantId) &&
              (where.slug === undefined || x.slug === where.slug) &&
              (where.deletedAt === undefined || x.deletedAt === where.deletedAt) &&
              (where.isDefaultForApproval === undefined ||
                x.isDefaultForApproval === where.isDefaultForApproval),
          ) ?? null;
        if (!g) return null;
        if (include) {
          return {
            ...g,
            courses: include.courses
              ? groupCourses
                  .filter((c) => c.groupId === g.id)
                  .map((c) => ({ courseId: c.courseId }))
              : undefined,
            members: include.members
              ? members
                  .filter((m) => m.groupId === g.id && m.status === 'ACTIVE')
                  .map((m) => ({ userId: m.userId, grantedAt: new Date() }))
              : undefined,
          };
        }
        return g;
      },
      async findMany({ where, include }: { where: Record<string, unknown>; include?: unknown }) {
        const rows = groups.filter(
          (g) =>
            (where.tenantId === undefined || g.tenantId === where.tenantId) &&
            (where.deletedAt === undefined || g.deletedAt === where.deletedAt) &&
            (where.kind === undefined || g.kind === where.kind) &&
            (where.autoGrantNewCourses === undefined ||
              g.autoGrantNewCourses === where.autoGrantNewCourses),
        );
        if (include) {
          return rows.map((g) => ({
            ...g,
            _count: { courses: groupCourses.filter((c) => c.groupId === g.id).length },
          }));
        }
        return rows;
      },
      async count({ where }: { where: Record<string, unknown> }) {
        return groups.filter(
          (g) =>
            (where.tenantId === undefined || g.tenantId === where.tenantId) &&
            (where.deletedAt === undefined || g.deletedAt === where.deletedAt),
        ).length;
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        const g = groups.find((x) => x.id === where.id)!;
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in v) {
            (g as never as Record<string, number>)[k] += (v as { increment: number }).increment;
          } else if (v && typeof v === 'object' && 'decrement' in v) {
            (g as never as Record<string, number>)[k] -= (v as { decrement: number }).decrement;
          } else if (v !== undefined) {
            (g as never as Record<string, unknown>)[k] = v;
          }
        }
        return g;
      },
      async updateMany({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) {
        let count = 0;
        for (const g of groups) {
          if (
            (where.tenantId === undefined || g.tenantId === where.tenantId) &&
            (where.isDefaultForApproval === undefined ||
              g.isDefaultForApproval === where.isDefaultForApproval) &&
            (where.NOT === undefined || g.id !== (where.NOT as { id: string }).id)
          ) {
            Object.assign(g, data);
            count++;
          }
        }
        return { count };
      },
    },
    modAccessGroupCourse: {
      async findMany({ where }: { where: Record<string, unknown> }) {
        return groupCourses.filter(
          (c) =>
            (where.tenantId === undefined || c.tenantId === where.tenantId) &&
            (where.groupId === undefined || c.groupId === where.groupId),
        );
      },
      async createMany({ data }: { data: Array<Partial<CourseRow>> }) {
        for (const d of data) {
          if (!groupCourses.some((c) => c.groupId === d.groupId && c.courseId === d.courseId)) {
            groupCourses.push({
              id: id('gc'),
              groupId: d.groupId!,
              tenantId: d.tenantId!,
              courseId: d.courseId!,
            });
          }
        }
        return { count: data.length };
      },
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        const inList = (where.courseId as { in?: string[] } | undefined)?.in ?? null;
        let count = 0;
        for (let i = groupCourses.length - 1; i >= 0; i--) {
          const c = groupCourses[i];
          if (
            c.tenantId === where.tenantId &&
            c.groupId === where.groupId &&
            (inList === null || inList.includes(c.courseId))
          ) {
            groupCourses.splice(i, 1);
            count++;
          }
        }
        return { count };
      },
    },
    modAccessGroupMember: {
      async findUnique({
        where,
      }: {
        where: { mod_access_groups_member_unique: { groupId: string; userId: string } };
      }) {
        const k = where.mod_access_groups_member_unique;
        return members.find((m) => m.groupId === k.groupId && m.userId === k.userId) ?? null;
      },
      async findMany({ where }: { where: Record<string, unknown> }) {
        return members.filter(
          (m) =>
            (where.tenantId === undefined || m.tenantId === where.tenantId) &&
            (where.groupId === undefined || m.groupId === where.groupId) &&
            (where.status === undefined || m.status === where.status),
        );
      },
      async create({ data }: { data: Partial<MemberRow> }) {
        const row: MemberRow = {
          id: id('mem'),
          groupId: data.groupId!,
          tenantId: data.tenantId!,
          userId: data.userId!,
          status: data.status ?? 'ACTIVE',
          revokedAt: null,
        };
        members.push(row);
        return row;
      },
      async update({
        where,
        data,
      }: {
        where: { mod_access_groups_member_unique: { groupId: string; userId: string } };
        data: Record<string, unknown>;
      }) {
        const k = where.mod_access_groups_member_unique;
        const m = members.find((x) => x.groupId === k.groupId && x.userId === k.userId)!;
        Object.assign(m, data);
        return m;
      },
      async updateMany({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) {
        let count = 0;
        for (const m of members) {
          if (
            m.tenantId === where.tenantId &&
            m.groupId === where.groupId &&
            (where.status === undefined || m.status === where.status)
          ) {
            Object.assign(m, data);
            count++;
          }
        }
        return { count };
      },
    },
    modAccessGroupGrant: {
      async upsert({
        where,
        create,
      }: {
        where: {
          mod_access_groups_grant_unique: {
            tenantId: string;
            groupId: string;
            userId: string;
            courseId: string;
          };
        };
        create: Partial<GrantRow>;
        update: Record<string, unknown>;
      }) {
        const k = where.mod_access_groups_grant_unique;
        const found = grants.find(
          (g) =>
            g.tenantId === k.tenantId &&
            g.groupId === k.groupId &&
            g.userId === k.userId &&
            g.courseId === k.courseId,
        );
        if (found) {
          found.revokedAt = null;
          return found;
        }
        const row: GrantRow = {
          id: id('grant'),
          tenantId: create.tenantId!,
          groupId: create.groupId!,
          userId: create.userId!,
          courseId: create.courseId!,
          revokedAt: null,
        };
        grants.push(row);
        return row;
      },
      async updateMany({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) {
        let count = 0;
        for (const g of grants) {
          if (
            g.tenantId === where.tenantId &&
            g.groupId === where.groupId &&
            g.userId === where.userId &&
            g.courseId === where.courseId &&
            (where.revokedAt === undefined || g.revokedAt === where.revokedAt)
          ) {
            Object.assign(g, data);
            count++;
          }
        }
        return { count };
      },
      async count({ where }: { where: Record<string, unknown> }) {
        return grants.filter(
          (g) =>
            g.tenantId === where.tenantId &&
            g.userId === where.userId &&
            g.courseId === where.courseId &&
            (where.revokedAt === undefined || g.revokedAt === where.revokedAt),
        ).length;
      },
      async findMany({ where }: { where: Record<string, unknown> }) {
        return grants.filter(
          (g) =>
            g.tenantId === where.tenantId &&
            g.groupId === where.groupId &&
            g.userId === where.userId &&
            (where.revokedAt === undefined || g.revokedAt === where.revokedAt),
        );
      },
    },
    user: {
      async findMany() {
        return [];
      },
    },
    async $transaction(arg: unknown) {
      if (typeof arg === 'function') return (arg as (t: unknown) => unknown)(prisma);
      if (Array.isArray(arg)) return Promise.all(arg);
      return undefined;
    },
  };

  const published = (opts.publishedCourses ?? ['c1', 'c2']).map((cid) => ({
    id: cid,
    title: `Curso ${cid}`,
    slug: cid,
  }));
  const listCourses = vi.fn().mockResolvedValue(published);
  const enrollFromGroup = vi.fn().mockResolvedValue({ id: 'enr' });
  const unenrollFromGroup = vi.fn().mockResolvedValue(undefined);
  const enrollByAdmin = vi.fn().mockResolvedValue({ id: 'enr' });
  const registry = {
    getCoursesService: () => ({ listCourses }),
    getLearningService: () => ({ enrollFromGroup, unenrollFromGroup, enrollByAdmin }),
  } as never;
  const tenantContext = {
    run: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
    get: vi.fn(() => ({ tenantId: TENANT, traceId: 't' })),
  } as never;
  const auditLog = { record: vi.fn().mockResolvedValue(undefined) } as never;
  const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

  const service = new AccessGroupsService(
    prisma as never,
    registry,
    tenantContext,
    auditLog,
    logger,
  );

  return {
    service,
    groups,
    groupCourses,
    members,
    grants,
    listCourses,
    enrollFromGroup,
    unenrollFromGroup,
    enrollByAdmin,
  };
}

describe('AccessGroupsService.createGroup', () => {
  it('rechaza ALL_COURSES con cursos explícitos', async () => {
    const h = makeHarness();
    await expect(
      h.service.createGroup(TENANT, {
        name: 'Todo',
        kind: 'ALL_COURSES',
        courseIds: ['c1'],
      } as never),
    ).rejects.toThrow(/no admite lista/i);
  });

  it('deriva el slug del nombre y rechaza duplicados', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'VA360 Pro',
      kind: 'ALL_COURSES',
    } as never);
    expect(g.slug).toBe('va360-pro');
    await expect(
      h.service.createGroup(TENANT, { name: 'VA360 Pro', kind: 'ALL_COURSES' } as never),
    ).rejects.toThrow(/slug/i);
  });

  it('crea un grupo COURSE con sus cursos', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'Curso A',
      kind: 'MULTI_COURSE',
      courseIds: ['c1', 'c2', 'c2'],
    } as never);
    expect(g.courseIds.sort()).toEqual(['c1', 'c2']);
    expect(h.groupCourses).toHaveLength(2);
  });
});

describe('AccessGroupsService.assignMembers', () => {
  it('ALL_COURSES: matricula en todos los cursos publicados y es idempotente', async () => {
    const h = makeHarness({ publishedCourses: ['c1', 'c2'] });
    const g = await h.service.createGroup(TENANT, { name: 'Pro', kind: 'ALL_COURSES' } as never);

    const r1 = await h.service.assignMembers(TENANT, g.id, ['u1']);
    expect(r1.added).toBe(1);
    expect(h.enrollFromGroup).toHaveBeenCalledWith(TENANT, 'u1', 'c1');
    expect(h.enrollFromGroup).toHaveBeenCalledWith(TENANT, 'u1', 'c2');
    expect(h.grants.filter((x) => x.revokedAt === null)).toHaveLength(2);
    expect(h.groups[0].memberCount).toBe(1);

    // Re-asignar el mismo usuario no duplica membresía ni memberCount.
    const r2 = await h.service.assignMembers(TENANT, g.id, ['u1']);
    expect(r2.added).toBe(0);
    expect(h.members.filter((m) => m.userId === 'u1')).toHaveLength(1);
    expect(h.groups[0].memberCount).toBe(1);
  });

  it('AlreadyEnrolledError de un curso no rompe el fan-out (grant igualmente registrado)', async () => {
    const h = makeHarness({ publishedCourses: ['c1', 'c2'] });
    h.enrollFromGroup.mockImplementation(async (_t: string, _u: string, courseId: string) => {
      if (courseId === 'c1') throw new AlreadyEnrolledError();
      return { id: 'enr' };
    });
    const g = await h.service.createGroup(TENANT, { name: 'Pro', kind: 'ALL_COURSES' } as never);
    await h.service.assignMembers(TENANT, g.id, ['u1']);
    expect(h.grants.filter((x) => x.revokedAt === null)).toHaveLength(2);
  });

  it('COURSE: matricula solo en los cursos del grupo', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'Solo C1',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.assignMembers(TENANT, g.id, ['u1']);
    expect(h.enrollFromGroup).toHaveBeenCalledTimes(1);
    expect(h.enrollFromGroup).toHaveBeenCalledWith(TENANT, 'u1', 'c1');
  });
});

describe('AccessGroupsService.revokeMember (refcount)', () => {
  it('desmatricula cuando ningún otro grupo otorga el curso', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'Solo C1',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.assignMembers(TENANT, g.id, ['u1']);
    await h.service.revokeMember(TENANT, g.id, 'u1');
    expect(h.unenrollFromGroup).toHaveBeenCalledWith(TENANT, 'u1', 'c1');
    expect(h.groups[0].memberCount).toBe(0);
  });

  it('NO desmatricula si otro grupo vivo otorga el mismo curso (refcount > 0)', async () => {
    const h = makeHarness();
    const g1 = await h.service.createGroup(TENANT, {
      name: 'G1',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    const g2 = await h.service.createGroup(TENANT, {
      name: 'G2',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.assignMembers(TENANT, g1.id, ['u1']);
    await h.service.assignMembers(TENANT, g2.id, ['u1']);

    await h.service.revokeMember(TENANT, g1.id, 'u1');
    // c1 sigue otorgado por g2 → no se desmatricula.
    expect(h.unenrollFromGroup).not.toHaveBeenCalled();

    await h.service.revokeMember(TENANT, g2.id, 'u1');
    // Ya ningún grupo lo otorga → se desmatricula.
    expect(h.unenrollFromGroup).toHaveBeenCalledWith(TENANT, 'u1', 'c1');
  });
});

describe('AccessGroupsService.setGroupCourses (reconciliación)', () => {
  it('otorga cursos añadidos y revoca quitados para los miembros activos', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'G',
      kind: 'MULTI_COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.assignMembers(TENANT, g.id, ['u1']);
    h.enrollFromGroup.mockClear();

    await h.service.setGroupCourses(TENANT, g.id, { courseIds: ['c2'] });
    // c2 añadido → enroll; c1 quitado → unenroll (refcount 0).
    expect(h.enrollFromGroup).toHaveBeenCalledWith(TENANT, 'u1', 'c2');
    expect(h.unenrollFromGroup).toHaveBeenCalledWith(TENANT, 'u1', 'c1');
  });

  it('rechaza editar cursos de un grupo ALL_COURSES', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, { name: 'Pro', kind: 'ALL_COURSES' } as never);
    await expect(h.service.setGroupCourses(TENANT, g.id, { courseIds: ['c1'] })).rejects.toThrow(
      /ALL_COURSES/,
    );
  });
});

describe('AccessGroupsService.assignDefaultGroupOnApproval', () => {
  it('asigna el grupo por defecto si existe', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, { name: 'Pro', kind: 'ALL_COURSES' } as never);
    await h.service.updateGroup(TENANT, g.id, { isDefaultForApproval: true });

    await h.service.assignDefaultGroupOnApproval(TENANT, 'u1');
    expect(h.members.some((m) => m.userId === 'u1' && m.groupId === g.id)).toBe(true);
    expect(h.enrollFromGroup).toHaveBeenCalled();
  });

  it('fallback enroll-all-published si no hay grupo por defecto', async () => {
    const h = makeHarness({ publishedCourses: ['c1', 'c2'] });
    await h.service.assignDefaultGroupOnApproval(TENANT, 'u1');
    expect(h.enrollByAdmin).toHaveBeenCalledTimes(2);
    expect(h.enrollFromGroup).not.toHaveBeenCalled();
  });
});

describe('AccessGroupsService.onCoursePublished', () => {
  it('otorga el curso nuevo a miembros de grupos ALL_COURSES con autoGrant', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, { name: 'Pro', kind: 'ALL_COURSES' } as never);
    await h.service.assignMembers(TENANT, g.id, ['u1']);
    h.enrollFromGroup.mockClear();

    await h.service.onCoursePublished(TENANT, 'c-new');
    expect(h.enrollFromGroup).toHaveBeenCalledWith(TENANT, 'u1', 'c-new');
  });

  it('no hace nada si no hay grupos ALL_COURSES', async () => {
    const h = makeHarness();
    await h.service.onCoursePublished(TENANT, 'c-new');
    expect(h.enrollFromGroup).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
