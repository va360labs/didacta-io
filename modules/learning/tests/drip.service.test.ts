/**
 * Tests a nivel de service del DRIP: resolución de reglas aplicables (por tier
 * efectivo y por grupo), ordenación real de lecciones desde módulos/lecciones, y
 * cómputo de disponibilidad. Mock Prisma mínimo en memoria (solo los modelos que
 * tocan los métodos de drip).
 */

import { describe, it, expect } from 'vitest';
import { LearningService } from '../src/learning.service.js';

interface DripRow {
  id: string;
  tenantId: string;
  courseId: string;
  audienceKind: 'TIER' | 'GROUP';
  audienceRef: string;
  unit: 'LESSON' | 'MODULE';
  intervalDays: number;
  startOffsetDays: number;
  isActive: boolean;
}

const TENANT = 't1';
const COURSE = 'c1';

/** Construye un service con un mock Prisma sembrado para los reads de drip. */
function build(opts: {
  schedules: DripRow[];
  userTier?: { manualName?: string | null; derivedLabel?: string | null } | null;
  memberGroupIds?: string[];
  enrollment?: { startedAt: Date | null; enrolledAt: Date } | null;
}) {
  // El service calcula disponibilidad contra el `new Date()` real, así que
  // anclamos la matrícula en "ahora": la unidad 0 queda libre y las siguientes
  // (a +N días) bloqueadas, sea cual sea la fecha real de ejecución del test.
  const enrollment =
    opts.enrollment === undefined
      ? { startedAt: null as Date | null, enrolledAt: new Date() }
      : opts.enrollment;

  const prisma = {
    modLearningEnrollment: {
      findUnique: async () => enrollment,
    },
    modLearningDripSchedule: {
      findMany: async ({ where }: { where: { isActive?: boolean } }) =>
        opts.schedules.filter((s) => (where.isActive ? s.isActive : true)),
    },
    modPaymentConnectionsUserTier: {
      findUnique: async () =>
        opts.userTier
          ? {
              manualTier: opts.userTier.manualName ? { name: opts.userTier.manualName } : null,
              derivedLabel: opts.userTier.derivedLabel ?? null,
            }
          : null,
    },
    modAccessGroupMember: {
      findMany: async () => (opts.memberGroupIds ?? []).map((groupId) => ({ groupId })),
    },
    // Curso: módulo 0 → [L0, L1], módulo 1 → [L2].
    modCoursesModule: {
      findMany: async () => [{ id: 'm0' }, { id: 'm1' }],
    },
    modCoursesLesson: {
      findMany: async ({ where }: { where: { moduleId: string } }) =>
        where.moduleId === 'm0' ? [{ id: 'L0' }, { id: 'L1' }] : [{ id: 'L2' }],
    },
  };

  const ctx = { eventBus: { publish: async () => {} }, auditLog: { record: async () => {} } };
  return new LearningService(prisma as never, ctx as never);
}

function tierSchedule(over: Partial<DripRow> = {}): DripRow {
  return {
    id: 'd1',
    tenantId: TENANT,
    courseId: COURSE,
    audienceKind: 'TIER',
    audienceRef: 'Pro',
    unit: 'LESSON',
    intervalDays: 7,
    startOffsetDays: 0,
    isActive: true,
    ...over,
  };
}

describe('LearningService.getCourseAvailability (drip)', () => {
  it('sin matrícula → drip:false', async () => {
    const svc = build({ schedules: [tierSchedule()], enrollment: null });
    const res = await svc.getCourseAvailability(TENANT, 'u1', COURSE);
    expect(res.drip).toBe(false);
  });

  it('tier efectivo coincide → aplica la regla (L0 libre, L1 no)', async () => {
    const svc = build({ schedules: [tierSchedule()], userTier: { manualName: 'Pro' } });
    const res = await svc.getCourseAvailability(TENANT, 'u1', COURSE);
    expect(res.drip).toBe(true);
    expect(res.lessons['L0'].available).toBe(true);
    expect(res.lessons['L1'].available).toBe(false);
    expect(res.lessons['L2'].available).toBe(false);
  });

  it('tier del usuario NO coincide con el del schedule → sin drip', async () => {
    const svc = build({ schedules: [tierSchedule()], userTier: { derivedLabel: 'Free' } });
    const res = await svc.getCourseAvailability(TENANT, 'u1', COURSE);
    expect(res.drip).toBe(false);
  });

  it('por GRUPO: aplica si el usuario es miembro del grupo del schedule', async () => {
    const svc = build({
      schedules: [tierSchedule({ audienceKind: 'GROUP', audienceRef: 'g1' })],
      memberGroupIds: ['g1'],
    });
    const res = await svc.getCourseAvailability(TENANT, 'u1', COURSE);
    expect(res.drip).toBe(true);
    expect(res.lessons['L1'].available).toBe(false);
  });

  it('schedule inactivo → no aplica', async () => {
    const svc = build({
      schedules: [tierSchedule({ isActive: false })],
      userTier: { manualName: 'Pro' },
    });
    const res = await svc.getCourseAvailability(TENANT, 'u1', COURSE);
    expect(res.drip).toBe(false);
  });

  it('unit MÓDULO: L0 y L1 (módulo 0) libres, L2 (módulo 1) bloqueada', async () => {
    const svc = build({
      schedules: [tierSchedule({ unit: 'MODULE' })],
      userTier: { manualName: 'Pro' },
    });
    const res = await svc.getCourseAvailability(TENANT, 'u1', COURSE);
    expect(res.lessons['L0'].available).toBe(true);
    expect(res.lessons['L1'].available).toBe(true);
    expect(res.lessons['L2'].available).toBe(false);
  });
});
