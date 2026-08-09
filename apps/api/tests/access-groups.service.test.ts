/**
 * Tests UNITARIOS de `AccessGroupsService` (mod.access-groups, Fase 2).
 *
 * Cubre la lógica de negocio central del vínculo tier→grupo y la
 * materialización de accesos como enrollments del core (refcount + provenance):
 *
 *  - createGroup: validación ALL_COURSES sin cursos explícitos, slug derivado y único.
 *  - assignMembers: fan-out a enrollments (ALL_COURSES → todos los publicados;
 *    COURSE → cursos del grupo), idempotencia (no duplica membresía/grant ni memberCount).
 *  - activateMembership (vía assignMembers/reconcileTierMembership): MANUAL sticky —
 *    reactivar una MANUAL revocada NO la degrada a TIER; un alta MANUAL sobre una
 *    TIER activa la promociona a MANUAL.
 *  - source=MEMBERSHIP (F6): el bridge de membresía asigna MEMBERSHIP y su
 *    revocación (onlySource) nunca toca membresías MANUAL ni TIER.
 *  - revokeMember / revokeCourseFromUser: refcount — desmatricula solo si ningún
 *    otro grupo vivo otorga el curso (incluye el advisory lock vía tx.$executeRaw).
 *  - setGroupCourses: reconciliación (otorga añadidos, revoca quitados por refcount).
 *  - updateGroup(linkedTierName): al cambiar el vínculo retira a los miembros TIER
 *    del vínculo anterior (revokeGroupTierMembers).
 *  - reconcileTierMembership: añade TIER + matrícula a los grupos del tier; retira
 *    (REVOKED) las membresías TIER "stale" de otros grupos y desmatricula; nunca
 *    toca MANUAL; tierName=null retira todas las TIER; idempotente.
 *  - assignDefaultGroupOnApproval: usa el grupo por defecto; fallback enroll-all-published.
 *  - onCoursePublished: otorga el curso nuevo a miembros de grupos ALL_COURSES autoGrant.
 *
 * Usa fake-prisma in-memory + mocks de ModuleRegistryService (courses/learning),
 * TenantContextService, PrismaAuditLogService y PinoLogger.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AlreadyEnrolledError, LearningError } from '@didacta/mod-learning';
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
  linkedTierName: string | null;
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
  source: 'MANUAL' | 'TIER' | 'MEMBERSHIP';
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

/** Evalúa un valor de `where` que puede ser escalar o un operador Prisma. */
function matchWhere(actual: unknown, condition: unknown): boolean {
  if (condition === undefined) return true;
  if (condition !== null && typeof condition === 'object') {
    const cond = condition as Record<string, unknown>;
    if ('in' in cond) return (cond.in as unknown[]).includes(actual);
    if ('notIn' in cond) return !(cond.notIn as unknown[]).includes(actual);
  }
  return actual === condition;
}

function makeHarness(opts: { publishedCourses?: string[] } = {}) {
  const groups: GroupRow[] = [];
  const groupCourses: CourseRow[] = [];
  const members: MemberRow[] = [];
  const grants: GrantRow[] = [];
  let seq = 1;
  const id = (p: string) => `${p}-${seq++}`;

  const prisma = {
    // No-op del advisory lock dentro de la tx (revokeCourseFromUser).
    async $executeRaw() {
      return 0;
    },
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
          linkedTierName: data.linkedTierName ?? null,
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
              matchWhere(x.id, where.id) &&
              matchWhere(x.tenantId, where.tenantId) &&
              matchWhere(x.slug, where.slug) &&
              matchWhere(x.deletedAt, where.deletedAt) &&
              matchWhere(x.isDefaultForApproval, where.isDefaultForApproval) &&
              matchWhere(x.linkedTierName, where.linkedTierName),
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
                  .map((m) => ({ userId: m.userId, grantedAt: new Date(), source: m.source }))
              : undefined,
          };
        }
        // Devolvemos una COPIA: Prisma materializa un objeto nuevo por query, así
        // `before` (snapshot pre-update en updateGroup) no muta cuando un
        // `update` posterior toca la fila viva del array in-memory.
        return { ...g };
      },
      async findMany({ where, include }: { where: Record<string, unknown>; include?: unknown }) {
        const rows = groups.filter(
          (g) =>
            matchWhere(g.tenantId, where.tenantId) &&
            matchWhere(g.deletedAt, where.deletedAt) &&
            matchWhere(g.kind, where.kind) &&
            matchWhere(g.autoGrantNewCourses, where.autoGrantNewCourses) &&
            matchWhere(g.linkedTierName, where.linkedTierName) &&
            matchWhere(g.isDefaultForApproval, where.isDefaultForApproval),
        );
        if (include) {
          return rows.map((g) => ({
            ...g,
            _count: { courses: groupCourses.filter((c) => c.groupId === g.id).length },
          }));
        }
        // Copias (semántica Prisma): el caller no debe ver mutaciones in-place.
        return rows.map((g) => ({ ...g }));
      },
      async count({ where }: { where: Record<string, unknown> }) {
        return groups.filter(
          (g) => matchWhere(g.tenantId, where.tenantId) && matchWhere(g.deletedAt, where.deletedAt),
        ).length;
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        const g = groups.find((x) => x.id === where.id)!;
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in v) {
            (g as never as Record<string, number>)[k] =
              (g as never as Record<string, number>)[k]! + (v as { increment: number }).increment;
          } else if (v && typeof v === 'object' && 'decrement' in v) {
            (g as never as Record<string, number>)[k] =
              (g as never as Record<string, number>)[k]! - (v as { decrement: number }).decrement;
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
            matchWhere(g.tenantId, where.tenantId) &&
            matchWhere(g.isDefaultForApproval, where.isDefaultForApproval) &&
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
          (c) => matchWhere(c.tenantId, where.tenantId) && matchWhere(c.groupId, where.groupId),
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
            c!.tenantId === where.tenantId &&
            c!.groupId === where.groupId &&
            (inList === null || inList.includes(c!.courseId))
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
            matchWhere(m.tenantId, where.tenantId) &&
            matchWhere(m.groupId, where.groupId) &&
            matchWhere(m.userId, where.userId) &&
            matchWhere(m.status, where.status) &&
            matchWhere(m.source, where.source),
        );
      },
      async create({ data }: { data: Partial<MemberRow> }) {
        const row: MemberRow = {
          id: id('mem'),
          groupId: data.groupId!,
          tenantId: data.tenantId!,
          userId: data.userId!,
          status: data.status ?? 'ACTIVE',
          source: (data.source as MemberRow['source']) ?? 'MANUAL',
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
            matchWhere(m.tenantId, where.tenantId) &&
            matchWhere(m.groupId, where.groupId) &&
            matchWhere(m.status, where.status) &&
            matchWhere(m.source, where.source)
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

/** Helper: localiza la membresía (group,user) en el array in-memory. */
function member(h: ReturnType<typeof makeHarness>, groupId: string, userId: string) {
  return h.members.find((m) => m.groupId === groupId && m.userId === userId);
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
      name: 'Demo Pro',
      kind: 'ALL_COURSES',
    } as never);
    expect(g.slug).toBe('demo-pro');
    await expect(
      h.service.createGroup(TENANT, { name: 'Demo Pro', kind: 'ALL_COURSES' } as never),
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
    expect(h.groups[0]!.memberCount).toBe(1);

    // Re-asignar el mismo usuario no duplica membresía ni memberCount.
    const r2 = await h.service.assignMembers(TENANT, g.id, ['u1']);
    expect(r2.added).toBe(0);
    expect(h.members.filter((m) => m.userId === 'u1')).toHaveLength(1);
    expect(h.groups[0]!.memberCount).toBe(1);
  });

  it('alta MANUAL marca la membresía con source=MANUAL', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'Solo C1',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.assignMembers(TENANT, g.id, ['u1']);
    expect(member(h, g.id, 'u1')?.source).toBe('MANUAL');
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

  it('LearningError no-AlreadyEnrolled no rompe el fan-out (grant registrado, se omite)', async () => {
    const h = makeHarness({ publishedCourses: ['c1', 'c2'] });
    h.enrollFromGroup.mockImplementation(async (_t: string, _u: string, courseId: string) => {
      if (courseId === 'c1') throw new LearningError('COURSE_NOT_PUBLISHED', 'no publicado');
      return { id: 'enr' };
    });
    const g = await h.service.createGroup(TENANT, { name: 'Pro', kind: 'ALL_COURSES' } as never);
    await h.service.assignMembers(TENANT, g.id, ['u1']);
    // Ambos grants quedan registrados aunque c1 no haya podido matricular.
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
    expect(h.groups[0]!.memberCount).toBe(0);
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

  it('revocar a un usuario no-miembro es no-op', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'G',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    const res = await h.service.revokeMember(TENANT, g.id, 'fantasma');
    expect(res).toEqual({ revoked: false });
    expect(h.unenrollFromGroup).not.toHaveBeenCalled();
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

describe('AccessGroupsService.updateGroup (vínculo de tier)', () => {
  it('al cambiar linkedTierName retira a los miembros TIER del vínculo anterior', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'Pro',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    // Vinculamos al tier "gold" y reconciliamos a un usuario por tier.
    await h.service.updateGroup(TENANT, g.id, { linkedTierName: 'gold' });
    await h.service.reconcileTierMembership(TENANT, 'u1', 'gold');
    expect(member(h, g.id, 'u1')?.status).toBe('ACTIVE');
    expect(member(h, g.id, 'u1')?.source).toBe('TIER');
    expect(h.groups[0]!.memberCount).toBe(1);
    h.unenrollFromGroup.mockClear();

    // Cambiamos el vínculo a otro tier → los TIER del vínculo anterior se retiran.
    await h.service.updateGroup(TENANT, g.id, { linkedTierName: 'silver' });
    expect(member(h, g.id, 'u1')?.status).toBe('REVOKED');
    expect(h.unenrollFromGroup).toHaveBeenCalledWith(TENANT, 'u1', 'c1');
    expect(h.groups[0]!.memberCount).toBe(0);
  });

  it('cadena vacía en linkedTierName se normaliza a null (desvincula)', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, { name: 'Pro', kind: 'ALL_COURSES' } as never);
    await h.service.updateGroup(TENANT, g.id, { linkedTierName: 'gold' });
    expect(h.groups[0]!.linkedTierName).toBe('gold');
    await h.service.updateGroup(TENANT, g.id, { linkedTierName: '   ' });
    expect(h.groups[0]!.linkedTierName).toBeNull();
  });

  it('no toca a los miembros MANUAL al cambiar el vínculo de tier', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'Pro',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.updateGroup(TENANT, g.id, { linkedTierName: 'gold' });
    await h.service.assignMembers(TENANT, g.id, ['manual1']); // MANUAL
    h.unenrollFromGroup.mockClear();

    await h.service.updateGroup(TENANT, g.id, { linkedTierName: 'silver' });
    expect(member(h, g.id, 'manual1')?.status).toBe('ACTIVE');
    expect(h.unenrollFromGroup).not.toHaveBeenCalled();
  });
});

describe('AccessGroupsService.reconcileTierMembership', () => {
  it('añade al usuario como TIER y lo matricula en los cursos del grupo del tier', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'Gold',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.updateGroup(TENANT, g.id, { linkedTierName: 'gold' });

    const res = await h.service.reconcileTierMembership(TENANT, 'u1', 'gold');
    expect(res).toEqual({ addedToGroups: 1, removedFromGroups: 0 });
    expect(member(h, g.id, 'u1')?.source).toBe('TIER');
    expect(member(h, g.id, 'u1')?.status).toBe('ACTIVE');
    expect(h.enrollFromGroup).toHaveBeenCalledWith(TENANT, 'u1', 'c1');
    expect(h.groups[0]!.memberCount).toBe(1);
  });

  it('cambio de tier: retira la membresía TIER stale de otro grupo y desmatricula', async () => {
    const h = makeHarness();
    const gold = await h.service.createGroup(TENANT, {
      name: 'Gold',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    const silver = await h.service.createGroup(TENANT, {
      name: 'Silver',
      kind: 'COURSE',
      courseIds: ['c2'],
    } as never);
    await h.service.updateGroup(TENANT, gold.id, { linkedTierName: 'gold' });
    await h.service.updateGroup(TENANT, silver.id, { linkedTierName: 'silver' });

    // Entra por gold.
    await h.service.reconcileTierMembership(TENANT, 'u1', 'gold');
    expect(member(h, gold.id, 'u1')?.status).toBe('ACTIVE');
    h.enrollFromGroup.mockClear();
    h.unenrollFromGroup.mockClear();

    // Sube a silver → sale de gold (stale TIER) y entra en silver.
    const res = await h.service.reconcileTierMembership(TENANT, 'u1', 'silver');
    expect(res).toEqual({ addedToGroups: 1, removedFromGroups: 1 });
    expect(member(h, gold.id, 'u1')?.status).toBe('REVOKED');
    expect(member(h, silver.id, 'u1')?.status).toBe('ACTIVE');
    expect(h.unenrollFromGroup).toHaveBeenCalledWith(TENANT, 'u1', 'c1'); // curso de gold
    expect(h.enrollFromGroup).toHaveBeenCalledWith(TENANT, 'u1', 'c2'); // curso de silver
    expect(h.groups.find((g) => g.id === gold.id)?.memberCount).toBe(0);
    expect(h.groups.find((g) => g.id === silver.id)?.memberCount).toBe(1);
  });

  it('NUNCA retira membresías source=MANUAL aunque el tier cambie', async () => {
    const h = makeHarness();
    const gold = await h.service.createGroup(TENANT, {
      name: 'Gold',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.updateGroup(TENANT, gold.id, { linkedTierName: 'gold' });
    // Alta MANUAL (no por tier).
    await h.service.assignMembers(TENANT, gold.id, ['u1']);
    expect(member(h, gold.id, 'u1')?.source).toBe('MANUAL');
    h.unenrollFromGroup.mockClear();

    // El usuario pasa a un tier que NO incluye gold → la MANUAL no se toca.
    const res = await h.service.reconcileTierMembership(TENANT, 'u1', 'platinum');
    expect(res.removedFromGroups).toBe(0);
    expect(member(h, gold.id, 'u1')?.status).toBe('ACTIVE');
    expect(member(h, gold.id, 'u1')?.source).toBe('MANUAL');
    expect(h.unenrollFromGroup).not.toHaveBeenCalled();
  });

  it('tierName=null retira TODAS las membresías TIER del usuario', async () => {
    const h = makeHarness();
    const gold = await h.service.createGroup(TENANT, {
      name: 'Gold',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.updateGroup(TENANT, gold.id, { linkedTierName: 'gold' });
    await h.service.reconcileTierMembership(TENANT, 'u1', 'gold');
    expect(member(h, gold.id, 'u1')?.status).toBe('ACTIVE');
    h.unenrollFromGroup.mockClear();

    const res = await h.service.reconcileTierMembership(TENANT, 'u1', null);
    expect(res).toEqual({ addedToGroups: 0, removedFromGroups: 1 });
    expect(member(h, gold.id, 'u1')?.status).toBe('REVOKED');
    expect(h.unenrollFromGroup).toHaveBeenCalledWith(TENANT, 'u1', 'c1');
    expect(h.groups[0]!.memberCount).toBe(0);
  });

  it('es idempotente: re-reconciliar el mismo tier no descuadra memberCount ni duplica', async () => {
    const h = makeHarness();
    const gold = await h.service.createGroup(TENANT, {
      name: 'Gold',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.updateGroup(TENANT, gold.id, { linkedTierName: 'gold' });

    await h.service.reconcileTierMembership(TENANT, 'u1', 'gold');
    await h.service.reconcileTierMembership(TENANT, 'u1', 'gold');
    await h.service.reconcileTierMembership(TENANT, 'u1', 'gold');

    expect(h.members.filter((m) => m.userId === 'u1' && m.groupId === gold.id)).toHaveLength(1);
    expect(h.grants.filter((g) => g.userId === 'u1' && g.revokedAt === null)).toHaveLength(1);
    expect(h.groups[0]!.memberCount).toBe(1);
  });

  it('sin grupos del tier ni membresías TIER stale → no-op', async () => {
    const h = makeHarness();
    const res = await h.service.reconcileTierMembership(TENANT, 'u1', 'inexistente');
    expect(res).toEqual({ addedToGroups: 0, removedFromGroups: 0 });
    expect(h.enrollFromGroup).not.toHaveBeenCalled();
    expect(h.unenrollFromGroup).not.toHaveBeenCalled();
  });
});

describe('AccessGroupsService.activateMembership (MANUAL sticky)', () => {
  it('un alta MANUAL sobre una membresía TIER activa la promociona a MANUAL', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'Gold',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.updateGroup(TENANT, g.id, { linkedTierName: 'gold' });
    // Entra por tier (TIER).
    await h.service.reconcileTierMembership(TENANT, 'u1', 'gold');
    expect(member(h, g.id, 'u1')?.source).toBe('TIER');

    // El admin lo añade a mano → se promociona a MANUAL.
    await h.service.assignMembers(TENANT, g.id, ['u1']);
    expect(member(h, g.id, 'u1')?.source).toBe('MANUAL');

    // Y ahora un tier-down ya NO lo retira (MANUAL sticky).
    h.unenrollFromGroup.mockClear();
    const res = await h.service.reconcileTierMembership(TENANT, 'u1', null);
    expect(res.removedFromGroups).toBe(0);
    expect(member(h, g.id, 'u1')?.status).toBe('ACTIVE');
    expect(h.unenrollFromGroup).not.toHaveBeenCalled();
  });

  it('reactivar una MANUAL revocada NO la degrada a TIER aunque la reactive el bridge', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'Gold',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.updateGroup(TENANT, g.id, { linkedTierName: 'gold' });
    // Alta MANUAL y luego revocación manual.
    await h.service.assignMembers(TENANT, g.id, ['u1']);
    await h.service.revokeMember(TENANT, g.id, 'u1');
    expect(member(h, g.id, 'u1')?.status).toBe('REVOKED');
    expect(member(h, g.id, 'u1')?.source).toBe('MANUAL');

    // El bridge de tier reactiva (source=TIER) → debe conservar MANUAL (sticky).
    await h.service.reconcileTierMembership(TENANT, 'u1', 'gold');
    expect(member(h, g.id, 'u1')?.status).toBe('ACTIVE');
    expect(member(h, g.id, 'u1')?.source).toBe('MANUAL');
  });
});

describe('AccessGroupsService source=MEMBERSHIP (bridge de membresía, F6)', () => {
  it('assignMembers con source MEMBERSHIP marca la membresía y matricula', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, { name: 'Pro', kind: 'ALL_COURSES' } as never);

    const r = await h.service.assignMembers(TENANT, g.id, ['u1'], 'MEMBERSHIP');
    expect(r.added).toBe(1);
    expect(member(h, g.id, 'u1')?.source).toBe('MEMBERSHIP');
    expect(h.enrollFromGroup).toHaveBeenCalledWith(TENANT, 'u1', 'c1');
    expect(h.groups[0]!.memberCount).toBe(1);
  });

  it('revokeMember con onlySource MEMBERSHIP revoca la MEMBERSHIP y desmatricula', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'Pro',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.assignMembers(TENANT, g.id, ['u1'], 'MEMBERSHIP');

    const res = await h.service.revokeMember(TENANT, g.id, 'u1', { onlySource: 'MEMBERSHIP' });
    expect(res).toEqual({ revoked: true });
    expect(member(h, g.id, 'u1')?.status).toBe('REVOKED');
    expect(h.unenrollFromGroup).toHaveBeenCalledWith(TENANT, 'u1', 'c1');
    expect(h.groups[0]!.memberCount).toBe(0);
  });

  it('revokeMember con onlySource MEMBERSHIP NUNCA toca una membresía MANUAL (sticky)', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'Pro',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.assignMembers(TENANT, g.id, ['u1']); // MANUAL

    const res = await h.service.revokeMember(TENANT, g.id, 'u1', { onlySource: 'MEMBERSHIP' });
    expect(res).toEqual({ revoked: false });
    expect(member(h, g.id, 'u1')?.status).toBe('ACTIVE');
    expect(h.unenrollFromGroup).not.toHaveBeenCalled();
    expect(h.groups[0]!.memberCount).toBe(1);
  });

  it('tampoco toca una membresía TIER (cada bridge revoca solo lo suyo)', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'Gold',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.updateGroup(TENANT, g.id, { linkedTierName: 'gold' });
    await h.service.reconcileTierMembership(TENANT, 'u1', 'gold');
    expect(member(h, g.id, 'u1')?.source).toBe('TIER');

    const res = await h.service.revokeMember(TENANT, g.id, 'u1', { onlySource: 'MEMBERSHIP' });
    expect(res).toEqual({ revoked: false });
    expect(member(h, g.id, 'u1')?.status).toBe('ACTIVE');
  });

  it('un alta MANUAL sobre una MEMBERSHIP activa la promociona y el bridge deja de poder revocarla', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'Pro',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.assignMembers(TENANT, g.id, ['u1'], 'MEMBERSHIP');
    await h.service.assignMembers(TENANT, g.id, ['u1']); // admin, MANUAL
    expect(member(h, g.id, 'u1')?.source).toBe('MANUAL');

    // El fin de la membresía de pago ya no retira el acceso (MANUAL sticky).
    const res = await h.service.revokeMember(TENANT, g.id, 'u1', { onlySource: 'MEMBERSHIP' });
    expect(res).toEqual({ revoked: false });
    expect(member(h, g.id, 'u1')?.status).toBe('ACTIVE');
  });

  it('reactivar una MANUAL revocada vía bridge de membresía conserva MANUAL', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'Pro',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.assignMembers(TENANT, g.id, ['u1']); // MANUAL
    await h.service.revokeMember(TENANT, g.id, 'u1');
    expect(member(h, g.id, 'u1')?.status).toBe('REVOKED');

    // Recovery de la membresía: reactiva, pero sigue siendo del admin.
    await h.service.assignMembers(TENANT, g.id, ['u1'], 'MEMBERSHIP');
    expect(member(h, g.id, 'u1')?.status).toBe('ACTIVE');
    expect(member(h, g.id, 'u1')?.source).toBe('MANUAL');
  });

  it('una MEMBERSHIP revocada que vuelve por membresía se reactiva como MEMBERSHIP', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'Pro',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.assignMembers(TENANT, g.id, ['u1'], 'MEMBERSHIP');
    await h.service.revokeMember(TENANT, g.id, 'u1', { onlySource: 'MEMBERSHIP' });

    await h.service.assignMembers(TENANT, g.id, ['u1'], 'MEMBERSHIP');
    expect(member(h, g.id, 'u1')?.status).toBe('ACTIVE');
    expect(member(h, g.id, 'u1')?.source).toBe('MEMBERSHIP');
    expect(h.groups[0]!.memberCount).toBe(1);
  });

  it('reconcileTierMembership no retira membresías MEMBERSHIP (solo TIER stale)', async () => {
    const h = makeHarness();
    const g = await h.service.createGroup(TENANT, {
      name: 'Pro',
      kind: 'COURSE',
      courseIds: ['c1'],
    } as never);
    await h.service.assignMembers(TENANT, g.id, ['u1'], 'MEMBERSHIP');
    h.unenrollFromGroup.mockClear();

    // El usuario queda sin tier → solo se retirarían TIER; la MEMBERSHIP sigue.
    const res = await h.service.reconcileTierMembership(TENANT, 'u1', null);
    expect(res.removedFromGroups).toBe(0);
    expect(member(h, g.id, 'u1')?.status).toBe('ACTIVE');
    expect(member(h, g.id, 'u1')?.source).toBe('MEMBERSHIP');
    expect(h.unenrollFromGroup).not.toHaveBeenCalled();
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
