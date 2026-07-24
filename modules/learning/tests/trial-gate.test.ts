/**
 * Gate de contenido del PERIODO DE PRUEBA de la membresía (trialLessonLimit):
 * durante TRIALING, solo las N primeras lecciones (orden global) de cada curso
 * cuyo acceso venga del grupo de la membresía están disponibles; el resto se
 * bloquea con reason 'TRIAL' (availableAt null: se desbloquea PAGANDO).
 *
 * Cubre getCourseAvailability (masking del player/controller) y
 * assertLessonAccessible (gate duro de progreso y SCORM). Mock Prisma mínimo
 * con los reads cross-module (ADR-016): mod_subscriptions_* y
 * mod_access_groups_grant.
 */

import { describe, it, expect } from 'vitest';
import { LearningService } from '../src/learning.service.js';
import { TrialContentLockedError } from '../src/errors.js';

const TENANT = 't1';
const USER = 'u1';
const COURSE = 'c1';
const MEMBERSHIP_GROUP = 'g_membresia';

interface BuildOpts {
  /** source del enrollment del curso (default GROUP = vino de la membresía). */
  enrollmentSource?: string;
  /** Estado de la sub de membresía del usuario; null = sin membresía. */
  membershipStatus?: 'TRIALING' | 'ACTIVE' | null;
  /** Límite configurado por el admin (default 2 para el curso de 3 lecciones). */
  trialLessonLimit?: number;
  /** accessGroupId de la config; null = membresía sin grupo. */
  accessGroupId?: string | null;
  /** Grants vivos del (user, curso): groupIds. */
  liveGrantGroupIds?: string[];
  /** Calendarios de drip activos (mismo shape que drip.service.test). */
  schedules?: Array<{
    audienceKind: 'TIER' | 'GROUP';
    audienceRef: string;
    unit: 'LESSON' | 'MODULE';
    intervalDays: number;
    startOffsetDays: number;
    isActive: boolean;
  }>;
  memberGroupIds?: string[];
}

/** Curso: módulo m0 → [L0, L1], módulo m1 → [L2]. Enrollment vivo anclado hoy. */
function build(opts: BuildOpts = {}) {
  const {
    enrollmentSource = 'GROUP',
    membershipStatus = 'TRIALING',
    trialLessonLimit = 2,
    accessGroupId = MEMBERSHIP_GROUP,
    liveGrantGroupIds = [MEMBERSHIP_GROUP],
    schedules = [],
    memberGroupIds = [],
  } = opts;

  const prisma = {
    modLearningEnrollment: {
      findUnique: async () => ({
        status: 'ACTIVE',
        enrolledAt: new Date(),
        source: enrollmentSource,
      }),
      findFirst: async () => ({
        id: 'e1',
        tenantId: TENANT,
        userId: USER,
        courseId: COURSE,
        status: 'ACTIVE',
        enrolledAt: new Date(),
        source: enrollmentSource,
      }),
    },
    modLearningDripSchedule: {
      findMany: async () => schedules.filter((s) => s.isActive),
    },
    modPaymentConnectionsUserTier: {
      findUnique: async () => null,
    },
    modAccessGroupMember: {
      findMany: async () => memberGroupIds.map((groupId) => ({ groupId })),
    },
    modCoursesModule: {
      findMany: async () => [{ id: 'm0' }, { id: 'm1' }],
      findFirst: async () => ({ courseId: COURSE }),
    },
    modCoursesLesson: {
      findMany: async ({ where }: { where: { moduleId?: string } }) =>
        where.moduleId === 'm0'
          ? [{ id: 'L0' }, { id: 'L1' }]
          : where.moduleId === 'm1'
            ? [{ id: 'L2' }]
            : [], // query de publishAt (sin moduleId): sin lecciones programadas
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id ? { id: where.id, moduleId: 'm0', publishAt: null } : null,
    },
    // ── Cross-module reads del gate de trial (ADR-016) ──
    modSubscriptionsMembershipConfig: {
      findUnique: async () => ({ accessGroupId, trialLessonLimit }),
    },
    modSubscriptionsSubscription: {
      findFirst: async ({ where }: { where: { status?: string } }) =>
        membershipStatus && where.status === membershipStatus ? { id: 'sub_mem' } : null,
    },
    modAccessGroupGrant: {
      // Dos queries del gate: (a) grant del grupo de la membresía
      // ({ groupId: <id> }) y (b) grant de cualquier OTRO grupo
      // ({ NOT: { groupId: <id> } }).
      findFirst: async ({ where }: { where: { groupId?: string; NOT?: { groupId: string } } }) => {
        if (where.groupId) {
          return liveGrantGroupIds.includes(where.groupId)
            ? { id: `grant_${where.groupId}` }
            : null;
        }
        const excluded = where.NOT?.groupId;
        const match = liveGrantGroupIds.find((g) => g !== excluded);
        return match ? { id: `grant_${match}` } : null;
      },
    },
  };

  const ctx = { eventBus: { publish: async () => {} }, auditLog: { record: async () => {} } };
  return new LearningService(prisma as never, ctx as never);
}

describe('Gate de trial — getCourseAvailability', () => {
  it('membresía TRIALING + acceso por su grupo → solo las 2 primeras lecciones libres; la 3ª reason TRIAL sin fecha', async () => {
    const svc = build();
    const res = await svc.getCourseAvailability(TENANT, USER, COURSE);
    expect(res.drip).toBe(true);
    expect(res.trial).toEqual({ lessonLimit: 2 });
    expect(res.lessons['L0']).toBeUndefined(); // libre (no listada)
    expect(res.lessons['L1']).toBeUndefined(); // libre
    expect(res.lessons['L2']).toEqual({ availableAt: null, available: false, reason: 'TRIAL' });
  });

  it('compra directa (source PURCHASE) → el trial NO limita ese curso', async () => {
    const svc = build({ enrollmentSource: 'PURCHASE' });
    const res = await svc.getCourseAvailability(TENANT, USER, COURSE);
    expect(res.drip).toBe(false);
    expect(res.trial).toBeUndefined();
  });

  it('membresía ya ACTIVE (pagó) → sin límite', async () => {
    const svc = build({ membershipStatus: 'ACTIVE' });
    const res = await svc.getCourseAvailability(TENANT, USER, COURSE);
    expect(res.drip).toBe(false);
    expect(res.trial).toBeUndefined();
  });

  it('sin membresía → sin límite (grupo asignado a mano por el admin)', async () => {
    const svc = build({ membershipStatus: null });
    const res = await svc.getCourseAvailability(TENANT, USER, COURSE);
    expect(res.drip).toBe(false);
  });

  it('otro grupo también concede el curso → acceso completo (no se limita)', async () => {
    const svc = build({ liveGrantGroupIds: [MEMBERSHIP_GROUP, 'g_otro'] });
    const res = await svc.getCourseAvailability(TENANT, USER, COURSE);
    expect(res.drip).toBe(false);
    expect(res.trial).toBeUndefined();
  });

  it('límite 0 = sin límite (el admin da acceso completo en la prueba)', async () => {
    const svc = build({ trialLessonLimit: 0 });
    const res = await svc.getCourseAvailability(TENANT, USER, COURSE);
    expect(res.drip).toBe(false);
  });

  it('membresía sin accessGroupId configurado → sin gate (config incompleta no rompe)', async () => {
    const svc = build({ accessGroupId: null });
    const res = await svc.getCourseAvailability(TENANT, USER, COURSE);
    expect(res.drip).toBe(false);
  });

  it('ANTI-BYPASS: cancelar y re-automatricularse (source ADMIN) NO apaga el gate — decide el GRANT vivo', async () => {
    // enrollSelf pone source 'ADMIN'; el grant del grupo de la membresía sigue
    // vivo, así que el límite del trial se mantiene.
    const svc = build({ enrollmentSource: 'ADMIN' });
    const res = await svc.getCourseAvailability(TENANT, USER, COURSE);
    expect(res.trial).toEqual({ lessonLimit: 2 });
    expect(res.lessons['L2']).toMatchObject({ available: false, reason: 'TRIAL' });
  });

  it('curso SIN grant del grupo de la membresía → sin gate (no viene de la membresía)', async () => {
    const svc = build({ enrollmentSource: 'ADMIN', liveGrantGroupIds: [] });
    const res = await svc.getCourseAvailability(TENANT, USER, COURSE);
    expect(res.drip).toBe(false);
    expect(res.trial).toBeUndefined();
  });

  it('venta externa (source API) exime aunque exista el grant de la membresía', async () => {
    const svc = build({ enrollmentSource: 'API' });
    const res = await svc.getCourseAvailability(TENANT, USER, COURSE);
    expect(res.drip).toBe(false);
    expect(res.trial).toBeUndefined();
  });

  it('trial + drip conviven: el drip fecha lo suyo y el TRIAL prevalece del límite en adelante', async () => {
    // Drip por grupo libera solo L0 hoy (7 días por lección); límite trial = 2.
    const svc = build({
      schedules: [
        {
          audienceKind: 'GROUP',
          audienceRef: MEMBERSHIP_GROUP,
          unit: 'LESSON',
          intervalDays: 7,
          startOffsetDays: 0,
          isActive: true,
        },
      ],
      memberGroupIds: [MEMBERSHIP_GROUP],
    });
    const res = await svc.getCourseAvailability(TENANT, USER, COURSE);
    // L0: liberada por drip y dentro del límite → disponible.
    expect(res.lessons['L0']!.available).toBe(true);
    // L1: dentro del límite del trial pero bloqueada por drip (con fecha).
    expect(res.lessons['L1']!.available).toBe(false);
    expect(res.lessons['L1']!.reason).toBeUndefined();
    expect(res.lessons['L1']!.availableAt).not.toBeNull();
    // L2: fuera del límite → TRIAL (prevalece sobre el drip; conserva la fecha
    // del drip como referencia pero el motivo es el trial).
    expect(res.lessons['L2']!.available).toBe(false);
    expect(res.lessons['L2']!.reason).toBe('TRIAL');
  });
});

describe('Gate de trial — assertLessonAccessible (progreso + SCORM)', () => {
  it('lección fuera del límite → TrialContentLockedError', async () => {
    const svc = build();
    await expect(svc.assertLessonAccessible(TENANT, USER, 'L2')).rejects.toBeInstanceOf(
      TrialContentLockedError,
    );
  });

  it('lección dentro del límite → pasa', async () => {
    const svc = build();
    await expect(svc.assertLessonAccessible(TENANT, USER, 'L0')).resolves.toBeUndefined();
  });

  it('compra directa → nunca lanza por trial', async () => {
    const svc = build({ enrollmentSource: 'PURCHASE' });
    await expect(svc.assertLessonAccessible(TENANT, USER, 'L2')).resolves.toBeUndefined();
  });
});
