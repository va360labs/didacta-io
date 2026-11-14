/**
 * Desbloqueo POR NIVEL de la gamificación («se desbloquea en el nivel N»).
 *
 * El gate lo resuelve la capa de composición (`levelGate`, inyectado); aquí se
 * prueba lo que decide mod.learning con él:
 *  - un curso cerrado entero → todas sus lecciones con reason LEVEL y el nivel;
 *  - una sección cerrada → solo sus lecciones;
 *  - lo que la persona tiene por su cuenta (compra, suscripción, código…) NO
 *    se cierra por nivel; lo que llega con la comunidad (grupo, automatrícula)
 *    sí;
 *  - el gate duro de progreso (assertLessonAccessible) lanza
 *    LevelContentLockedError con los mismos casos.
 */

import { describe, expect, it } from 'vitest';
import { LearningService, type CourseLevelGateChecker } from '../src/learning.service.js';
import { LevelContentLockedError } from '../src/errors.js';

const TENANT = 't1';
const USER = 'u1';
const COURSE = 'c1';
const LEVEL3 = { levelNumber: 3, levelName: 'Experto', minPoints: 300, pointsMissing: 120 };

/** Curso: sección m0 → [L0, L1], sección m1 → [L2]. */
const LESSONS: Record<string, string> = { L0: 'm0', L1: 'm0', L2: 'm1' };

function build(opts: { source?: string; gate?: CourseLevelGateChecker } = {}) {
  const source = opts.source ?? 'GROUP';
  const prisma = {
    modLearningEnrollment: {
      findUnique: async () => ({ status: 'ACTIVE', enrolledAt: new Date(), source }),
    },
    modLearningDripSchedule: { findMany: async () => [] },
    modSubscriptionsMembershipConfig: { findUnique: async () => null },
    modCoursesModule: {
      findMany: async () => [{ id: 'm0' }, { id: 'm1' }],
      findFirst: async () => ({ courseId: COURSE }),
    },
    modCoursesLesson: {
      findMany: async ({
        where,
      }: {
        where: { publishAt?: unknown; moduleId?: string; module?: { id?: { in: string[] } } };
      }) => {
        if (where.publishAt) return []; // sin lecciones programadas por fecha
        if (where.moduleId) {
          return Object.keys(LESSONS)
            .filter((id) => LESSONS[id] === where.moduleId)
            .map((id) => ({ id }));
        }
        const only = where.module?.id?.in;
        return Object.entries(LESSONS)
          .filter(([, m]) => !only || only.includes(m))
          .map(([id, moduleId]) => ({ id, moduleId }));
      },
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id && LESSONS[where.id]
          ? { id: where.id, moduleId: LESSONS[where.id], publishAt: null }
          : null,
    },
  };
  const ctx = { eventBus: { publish: async () => {} }, auditLog: { record: async () => {} } };
  return new LearningService(prisma as never, ctx as never, async () => false, opts.gate);
}

const courseLocked: CourseLevelGateChecker = async () => ({ course: LEVEL3, modules: {} });
const sectionLocked: CourseLevelGateChecker = async () => ({
  course: null,
  modules: { m1: LEVEL3 },
});

describe('Desbloqueo por nivel — getCourseAvailability', () => {
  it('sin gate cableado no cierra nada (el caso de un aula sin gamificación)', async () => {
    const res = await build().getCourseAvailability(TENANT, USER, COURSE);
    expect(res.drip).toBe(false);
    expect(res.level).toBeUndefined();
  });

  it('curso cerrado entero → todas las lecciones LEVEL, sin fecha, con el nivel', async () => {
    const res = await build({ gate: courseLocked }).getCourseAvailability(TENANT, USER, COURSE);
    expect(res.drip).toBe(true);
    expect(res.level).toEqual(LEVEL3);
    for (const id of ['L0', 'L1', 'L2']) {
      expect(res.lessons[id]).toEqual({
        availableAt: null,
        available: false,
        reason: 'LEVEL',
        level: LEVEL3,
      });
    }
  });

  it('sección cerrada → solo las lecciones de esa sección; el curso no lleva `level`', async () => {
    const res = await build({ gate: sectionLocked }).getCourseAvailability(TENANT, USER, COURSE);
    expect(res.level).toBeUndefined();
    expect(res.lessons['L0']).toBeUndefined();
    expect(res.lessons['L1']).toBeUndefined();
    expect(res.lessons['L2']).toMatchObject({ available: false, reason: 'LEVEL' });
  });

  it.each(['PURCHASE', 'SUBSCRIPTION', 'API', 'CODE', 'INVITATION_LINK', 'IMPORT', 'INSPECTION'])(
    'acceso propio (%s) → el nivel no cierra lo que la persona tiene por su cuenta',
    async (source) => {
      const res = await build({ source, gate: courseLocked }).getCourseAvailability(
        TENANT,
        USER,
        COURSE,
      );
      expect(res.drip).toBe(false);
      expect(res.level).toBeUndefined();
    },
  );

  it.each(['GROUP', 'ADMIN'])(
    'acceso por la comunidad (%s) → el nivel sí cierra',
    async (source) => {
      const res = await build({ source, gate: courseLocked }).getCourseAvailability(
        TENANT,
        USER,
        COURSE,
      );
      expect(res.level).toEqual(LEVEL3);
    },
  );

  it('control: un gate que responde null (ya tiene el nivel) deja el curso abierto', async () => {
    const res = await build({ gate: async () => null }).getCourseAvailability(TENANT, USER, COURSE);
    expect(res.drip).toBe(false);
  });
});

describe('Desbloqueo por nivel — assertLessonAccessible (gate duro)', () => {
  it('curso cerrado → cualquier lección lanza LevelContentLockedError', async () => {
    const svc = build({ gate: courseLocked });
    await expect(svc.assertLessonAccessible(TENANT, USER, 'L0')).rejects.toBeInstanceOf(
      LevelContentLockedError,
    );
  });

  it('sección cerrada → solo sus lecciones; las demás pasan', async () => {
    const svc = build({ gate: sectionLocked });
    await expect(svc.assertLessonAccessible(TENANT, USER, 'L0')).resolves.toBeUndefined();
    await expect(svc.assertLessonAccessible(TENANT, USER, 'L2')).rejects.toMatchObject({
      code: 'LEVEL_CONTENT_LOCKED',
      levelNumber: 3,
      pointsMissing: 120,
    });
  });

  it('compra directa → pasa aunque el curso se desbloquee en un nivel', async () => {
    const svc = build({ source: 'PURCHASE', gate: courseLocked });
    await expect(svc.assertLessonAccessible(TENANT, USER, 'L2')).resolves.toBeUndefined();
  });
});
