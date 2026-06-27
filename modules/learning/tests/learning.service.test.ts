import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModuleContext } from '@didacta/core-kernel';
import { LearningService } from '../src/learning.service';
import {
  AlreadyEnrolledError,
  CourseNotPublishedError,
  EnrollmentNotFoundError,
  InvitationInvalidError,
} from '../src/errors';

interface FakeCourse {
  id: string;
  tenantId: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  deletedAt: Date | null;
}
interface FakeEnrollment {
  id: string;
  tenantId: string;
  userId: string;
  courseId: string;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  source: string;
  completionThreshold: number;
  progressPercent: number;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  enrolledAt: Date;
}
interface FakeInvitation {
  id: string;
  tenantId: string;
  courseId: string;
  code: string;
  token: string;
  maxUses: number | null;
  usedCount: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
}
interface FakeProgress {
  id: string;
  tenantId: string;
  enrollmentId: string;
  lessonId: string;
  watchedSeconds: number;
  resumePositionSec: number;
  completed: boolean;
  completedAt: Date | null;
  lastAccessedAt: Date | null;
}
interface FakeLesson {
  id: string;
  tenantId: string;
  moduleId: string;
  courseId: string;
  deletedAt: Date | null;
  title?: string;
  type?: 'VIDEO' | 'HTML' | 'PDF' | 'TEXT' | 'QUIZ' | 'SCORM';
  position?: number;
  durationMinutes?: number | null;
}
interface FakeModule {
  id: string;
  tenantId: string;
  courseId: string;
  title: string;
  position: number;
  deletedAt: Date | null;
}
interface FakeUser {
  id: string;
  tenantId: string;
  email: string | null;
  name: string | null;
}

function makeFakePrisma() {
  const courses = new Map<string, FakeCourse>();
  const enrollments = new Map<string, FakeEnrollment>();
  const invitations = new Map<string, FakeInvitation>();
  const progress = new Map<string, FakeProgress>();
  const lessons = new Map<string, FakeLesson>();
  const modules = new Map<string, FakeModule>();
  const users = new Map<string, FakeUser>();
  const lessonComments = new Map<string, Record<string, unknown>>();
  let counter = 0;
  const id = (p = 'id') => `${p}-${++counter}`;

  return {
    courses,
    enrollments,
    invitations,
    progress,
    lessons,
    modules,
    users,
    lessonComments,
    prisma: {
      user: {
        findFirst: vi.fn(
          async ({ where }: { where: { tenantId: string; id: string } }) =>
            [...users.values()].find((u) => u.tenantId === where.tenantId && u.id === where.id) ??
            null,
        ),
      },
      modCoursesModule: {
        findMany: vi.fn(async ({ where }: { where: { tenantId: string; courseId: string } }) =>
          [...modules.values()]
            .filter(
              (m) =>
                m.tenantId === where.tenantId &&
                m.courseId === where.courseId &&
                m.deletedAt === null,
            )
            .sort((a, b) => a.position - b.position),
        ),
      },
      modCoursesCourse: {
        findFirst: vi.fn(
          async ({ where }: { where: { tenantId: string; id: string } }) =>
            [...courses.values()].find(
              (c) => c.tenantId === where.tenantId && c.id === where.id && c.deletedAt === null,
            ) ?? null,
        ),
      },
      modCoursesLesson: {
        count: vi.fn(async ({ where }: { where: { module: { courseId: string } } }) => {
          return [...lessons.values()].filter(
            (l) => l.courseId === where.module.courseId && l.deletedAt === null,
          ).length;
        }),
        findMany: vi.fn(
          async ({ where }: { where: { tenantId: string; moduleId: { in: string[] } } }) =>
            [...lessons.values()]
              .filter(
                (l) =>
                  l.tenantId === where.tenantId &&
                  where.moduleId.in.includes(l.moduleId) &&
                  l.deletedAt === null,
              )
              .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
        ),
      },
      modLearningEnrollment: {
        findFirst: vi.fn(async ({ where }: { where: Partial<FakeEnrollment> }) => {
          return (
            [...enrollments.values()].find((e) =>
              Object.entries(where).every(([k, v]) => (e as Record<string, unknown>)[k] === v),
            ) ?? null
          );
        }),
        findMany: vi.fn(async ({ where }: { where: { tenantId: string; userId: string } }) =>
          [...enrollments.values()].filter(
            (e) => e.tenantId === where.tenantId && e.userId === where.userId,
          ),
        ),
        findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
          const e = enrollments.get(where.id);
          if (!e) throw new Error('not found');
          return e;
        }),
        create: vi.fn(
          async ({
            data,
          }: {
            data: Partial<FakeEnrollment> & {
              tenantId: string;
              userId: string;
              courseId: string;
              source: FakeEnrollment['source'];
            };
          }) => {
            const e: FakeEnrollment = {
              id: id('en'),
              tenantId: data.tenantId,
              userId: data.userId,
              courseId: data.courseId,
              status: 'ACTIVE',
              source: data.source,
              completionThreshold: 75,
              progressPercent: 0,
              enrolledAt: new Date(),
              startedAt: null,
              completedAt: null,
              cancelledAt: null,
            };
            enrollments.set(e.id, e);
            return e;
          },
        ),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: Partial<FakeEnrollment> }) => {
            const e = enrollments.get(where.id);
            if (!e) throw new Error('not found');
            const merged = { ...e, ...data };
            enrollments.set(where.id, merged);
            return merged;
          },
        ),
      },
      modLearningLessonComment: {
        findFirst: vi.fn(
          async ({
            where,
          }: {
            where: { id: string; tenantId?: string; deletedAt?: Date | null };
          }) => {
            const c = lessonComments.get(where.id);
            if (!c) return null;
            // Filtra por tenant (y deletedAt si se pide) igual que Prisma.
            if (where.tenantId !== undefined && c['tenantId'] !== where.tenantId) return null;
            if (where.deletedAt === null && c['deletedAt'] != null) return null;
            return c;
          },
        ),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const c = lessonComments.get(where.id);
            if (!c) throw new Error('not found');
            const merged = { ...c, ...data };
            lessonComments.set(where.id, merged);
            return merged;
          },
        ),
      },
      modLearningInvitation: {
        findUnique: vi.fn(
          async ({
            where,
          }: {
            where: { token?: string; tenantId_code?: { tenantId: string; code: string } };
          }) => {
            if (where.token) {
              return [...invitations.values()].find((i) => i.token === where.token) ?? null;
            }
            if (where.tenantId_code) {
              return (
                [...invitations.values()].find(
                  (i) =>
                    i.tenantId === where.tenantId_code?.tenantId &&
                    i.code === where.tenantId_code.code,
                ) ?? null
              );
            }
            return null;
          },
        ),
        create: vi.fn(
          async ({
            data,
          }: {
            data: Partial<FakeInvitation> & {
              tenantId: string;
              courseId: string;
              code: string;
              token: string;
            };
          }) => {
            const inv: FakeInvitation = {
              id: id('inv'),
              tenantId: data.tenantId,
              courseId: data.courseId,
              code: data.code,
              token: data.token,
              maxUses: data.maxUses ?? null,
              usedCount: 0,
              expiresAt: data.expiresAt ?? null,
              revokedAt: null,
            };
            invitations.set(inv.id, inv);
            return inv;
          },
        ),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: Partial<FakeInvitation> }) => {
            const i = invitations.get(where.id);
            if (!i) throw new Error('not found');
            const merged = { ...i, ...data };
            invitations.set(where.id, merged);
            return merged;
          },
        ),
      },
      modLearningProgress: {
        count: vi.fn(async ({ where }: { where: { enrollmentId: string; completed: boolean } }) => {
          return [...progress.values()].filter(
            (p) => p.enrollmentId === where.enrollmentId && p.completed === where.completed,
          ).length;
        }),
        findMany: vi.fn(async ({ where }: { where: { tenantId: string; enrollmentId: string } }) =>
          [...progress.values()].filter(
            (p) => p.tenantId === where.tenantId && p.enrollmentId === where.enrollmentId,
          ),
        ),
        upsert: vi.fn(
          async ({
            where,
            create,
            update,
          }: {
            where: { enrollmentId_lessonId: { enrollmentId: string; lessonId: string } };
            create: Partial<FakeProgress> & {
              tenantId: string;
              enrollmentId: string;
              lessonId: string;
            };
            update: Partial<FakeProgress> & { watchedSeconds?: { increment: number } };
          }) => {
            const key = `${where.enrollmentId_lessonId.enrollmentId}::${where.enrollmentId_lessonId.lessonId}`;
            const existing = progress.get(key);
            if (existing) {
              const watched =
                typeof update.watchedSeconds === 'object'
                  ? existing.watchedSeconds + update.watchedSeconds.increment
                  : existing.watchedSeconds;
              const merged: FakeProgress = {
                ...existing,
                watchedSeconds: watched,
                resumePositionSec: update.resumePositionSec ?? existing.resumePositionSec,
                completed: update.completed ?? existing.completed,
                completedAt: update.completedAt ?? existing.completedAt,
              };
              progress.set(key, merged);
              return merged;
            }
            const created: FakeProgress = {
              id: id('p'),
              tenantId: create.tenantId,
              enrollmentId: create.enrollmentId,
              lessonId: create.lessonId,
              watchedSeconds: create.watchedSeconds ?? 0,
              resumePositionSec: create.resumePositionSec ?? 0,
              completed: create.completed ?? false,
              completedAt: create.completedAt ?? null,
              lastAccessedAt: new Date(),
            };
            progress.set(key, created);
            return created;
          },
        ),
      },
    },
  };
}

function makeContext(): ModuleContext {
  return {
    eventBus: { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() } as never,
    hookRegistry: { register: vi.fn(), run: vi.fn() } as never,
    storage: {} as never,
    auditLog: { record: vi.fn() } as never,
    evidenceVault: { store: vi.fn() } as never,
    notificationHub: { send: vi.fn() } as never,
    i18n: { t: (k: string) => k } as never,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    } as never,
    config: { get: vi.fn(), set: vi.fn() } as never,
  };
}

describe('LearningService', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('rechaza enrollar en curso no publicado', async () => {
    const fake = makeFakePrisma();
    fake.courses.set('c-1', { id: 'c-1', tenantId: 't-1', status: 'DRAFT', deletedAt: null });
    const service = new LearningService(fake.prisma as never, makeContext());
    await expect(
      service.enrollByAdmin('t-1', 'admin', { userId: 'u-1', courseId: 'c-1' }),
    ).rejects.toBeInstanceOf(CourseNotPublishedError);
  });

  it('crea enrollment ACTIVE y emite learning.enrollment.created', async () => {
    const fake = makeFakePrisma();
    fake.courses.set('c-1', { id: 'c-1', tenantId: 't-1', status: 'PUBLISHED', deletedAt: null });
    const ctx = makeContext();
    const service = new LearningService(fake.prisma as never, ctx);
    const e = await service.enrollByAdmin('t-1', 'admin', { userId: 'u-1', courseId: 'c-1' });
    expect(e.status).toBe('ACTIVE');
    expect(ctx.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'learning.enrollment.created' }),
    );
  });

  it('rechaza doble enrollment activo en mismo (user, course)', async () => {
    const fake = makeFakePrisma();
    fake.courses.set('c-1', { id: 'c-1', tenantId: 't-1', status: 'PUBLISHED', deletedAt: null });
    const service = new LearningService(fake.prisma as never, makeContext());
    await service.enrollByAdmin('t-1', 'admin', { userId: 'u-1', courseId: 'c-1' });
    await expect(
      service.enrollByAdmin('t-1', 'admin', { userId: 'u-1', courseId: 'c-1' }),
    ).rejects.toBeInstanceOf(AlreadyEnrolledError);
  });

  it('reactiva un enrollment CANCELLED al re-otorgar por grupo (no P2002, no duplica fila)', async () => {
    // Regresión del ciclo quitar→re-añadir de grupos de acceso: unenrollFromGroup
    // deja la fila en CANCELLED; re-otorgar NO debe crear una segunda fila
    // (chocaría con @@unique([tenantId,userId,courseId]) → P2002) sino reactivar
    // la existente. Sembramos el estado post-unenroll directamente.
    const fake = makeFakePrisma();
    fake.courses.set('c-1', { id: 'c-1', tenantId: 't-1', status: 'PUBLISHED', deletedAt: null });
    fake.enrollments.set('en-old', {
      id: 'en-old',
      tenantId: 't-1',
      userId: 'u-1',
      courseId: 'c-1',
      status: 'CANCELLED',
      source: 'GROUP',
      completionThreshold: 75,
      progressPercent: 0,
      enrolledAt: new Date(),
      startedAt: null,
      completedAt: null,
      cancelledAt: new Date(),
    });
    const service = new LearningService(fake.prisma as never, makeContext());

    const reactivated = await service.enrollFromGroup('t-1', 'u-1', 'c-1');

    expect(reactivated.id).toBe('en-old'); // reusa la MISMA fila
    expect(reactivated.status).toBe('ACTIVE');
    expect(reactivated.cancelledAt).toBeNull();
    expect(fake.enrollments.size).toBe(1); // no duplicó → no habría P2002
  });

  it('re-otorgar por grupo un curso COMPLETED es no-op (no degrada la finalización)', async () => {
    const fake = makeFakePrisma();
    fake.courses.set('c-1', { id: 'c-1', tenantId: 't-1', status: 'PUBLISHED', deletedAt: null });
    fake.enrollments.set('en-done', {
      id: 'en-done',
      tenantId: 't-1',
      userId: 'u-1',
      courseId: 'c-1',
      status: 'COMPLETED',
      source: 'GROUP',
      completionThreshold: 75,
      progressPercent: 100,
      enrolledAt: new Date(),
      startedAt: new Date(),
      completedAt: new Date(),
      cancelledAt: null,
    });
    const service = new LearningService(fake.prisma as never, makeContext());

    const result = await service.enrollFromGroup('t-1', 'u-1', 'c-1');

    expect(result.id).toBe('en-done');
    expect(result.status).toBe('COMPLETED'); // intacto, no se degrada a ACTIVE
    expect(fake.enrollments.size).toBe(1);
  });

  it('enrollByCode usa invitación válida y la incrementa', async () => {
    const fake = makeFakePrisma();
    fake.courses.set('c-1', { id: 'c-1', tenantId: 't-1', status: 'PUBLISHED', deletedAt: null });
    fake.invitations.set('inv-1', {
      id: 'inv-1',
      tenantId: 't-1',
      courseId: 'c-1',
      code: 'AAAA-BBBB',
      token: 'abc',
      maxUses: 3,
      usedCount: 0,
      expiresAt: null,
      revokedAt: null,
    });
    const service = new LearningService(fake.prisma as never, makeContext());
    const e = await service.enrollByCode('t-1', 'u-1', { code: 'AAAA-BBBB' });
    expect(e.source).toBe('CODE');
    const inv = [...fake.invitations.values()][0];
    expect(inv?.usedCount).toBe(1);
  });

  it('rechaza invitación expirada', async () => {
    const fake = makeFakePrisma();
    fake.courses.set('c-1', { id: 'c-1', tenantId: 't-1', status: 'PUBLISHED', deletedAt: null });
    fake.invitations.set('inv-1', {
      id: 'inv-1',
      tenantId: 't-1',
      courseId: 'c-1',
      code: 'X',
      token: 'tok',
      maxUses: null,
      usedCount: 0,
      expiresAt: new Date(Date.now() - 10_000),
      revokedAt: null,
    });
    const service = new LearningService(fake.prisma as never, makeContext());
    await expect(service.enrollByLink('t-1', 'u-1', { token: 'tok' })).rejects.toBeInstanceOf(
      InvitationInvalidError,
    );
  });

  it('trackProgress emite learning.course.completed al cruzar el umbral 75%', async () => {
    const fake = makeFakePrisma();
    fake.courses.set('c-1', { id: 'c-1', tenantId: 't-1', status: 'PUBLISHED', deletedAt: null });
    fake.lessons.set('l-1', {
      id: 'l-1',
      tenantId: 't-1',
      moduleId: 'm-1',
      courseId: 'c-1',
      deletedAt: null,
    });
    fake.lessons.set('l-2', {
      id: 'l-2',
      tenantId: 't-1',
      moduleId: 'm-1',
      courseId: 'c-1',
      deletedAt: null,
    });
    fake.lessons.set('l-3', {
      id: 'l-3',
      tenantId: 't-1',
      moduleId: 'm-1',
      courseId: 'c-1',
      deletedAt: null,
    });
    fake.lessons.set('l-4', {
      id: 'l-4',
      tenantId: 't-1',
      moduleId: 'm-1',
      courseId: 'c-1',
      deletedAt: null,
    });
    const ctx = makeContext();
    const service = new LearningService(fake.prisma as never, ctx);
    const enroll = await service.enrollByAdmin('t-1', 'admin', { userId: 'u-1', courseId: 'c-1' });

    await service.trackProgress('t-1', 'u-1', {
      enrollmentId: enroll.id,
      lessonId: 'l-1',
      watchedSeconds: 30,
      completed: true,
    });
    await service.trackProgress('t-1', 'u-1', {
      enrollmentId: enroll.id,
      lessonId: 'l-2',
      watchedSeconds: 30,
      completed: true,
    });
    // 50% — todavía no completa
    expect(ctx.eventBus.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'learning.course.completed' }),
    );

    await service.trackProgress('t-1', 'u-1', {
      enrollmentId: enroll.id,
      lessonId: 'l-3',
      watchedSeconds: 30,
      completed: true,
    });
    // 75% exacto, dispara
    expect(ctx.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'learning.course.completed' }),
    );
  });

  it('cancelEnrollment marca CANCELLED y emite evento', async () => {
    const fake = makeFakePrisma();
    fake.courses.set('c-1', { id: 'c-1', tenantId: 't-1', status: 'PUBLISHED', deletedAt: null });
    const ctx = makeContext();
    const service = new LearningService(fake.prisma as never, ctx);
    const e = await service.enrollByAdmin('t-1', 'admin', { userId: 'u-1', courseId: 'c-1' });
    const cancelled = await service.cancelEnrollment('t-1', 'u-1', e.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(ctx.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'learning.enrollment.cancelled' }),
    );
  });

  it('cancelEnrollment falla si no existe para el user', async () => {
    const fake = makeFakePrisma();
    const service = new LearningService(fake.prisma as never, makeContext());
    await expect(service.cancelEnrollment('t-1', 'u-1', 'no-existe')).rejects.toBeInstanceOf(
      EnrollmentNotFoundError,
    );
  });

  describe('getEnrollmentProgressDetail (vista del formador)', () => {
    it('lanza EnrollmentNotFoundError si la matrícula no existe', async () => {
      const fake = makeFakePrisma();
      const service = new LearningService(fake.prisma as never, makeContext());
      await expect(
        service.getEnrollmentProgressDetail('t-1', 'c-1', 'no-existe'),
      ).rejects.toBeInstanceOf(EnrollmentNotFoundError);
    });

    it('hace left-join: la lección sin progreso aparece en 0 y respeta el orden', async () => {
      const fake = makeFakePrisma();
      fake.users.set('u-1', { id: 'u-1', tenantId: 't-1', email: 'a@b.com', name: 'Alumno' });
      fake.enrollments.set('en-1', {
        id: 'en-1',
        tenantId: 't-1',
        userId: 'u-1',
        courseId: 'c-1',
        status: 'ACTIVE',
        source: 'ADMIN',
        completionThreshold: 75,
        progressPercent: 50,
        startedAt: new Date(),
        completedAt: null,
        cancelledAt: null,
        enrolledAt: new Date(),
      });
      fake.modules.set('m-1', {
        id: 'm-1',
        tenantId: 't-1',
        courseId: 'c-1',
        title: 'Módulo 1',
        position: 0,
        deletedAt: null,
      });
      // l-1 (position 0) con progreso completado; l-2 (position 1) SIN fila de progreso.
      fake.lessons.set('l-1', {
        id: 'l-1',
        tenantId: 't-1',
        moduleId: 'm-1',
        courseId: 'c-1',
        deletedAt: null,
        title: 'Lección 1',
        type: 'VIDEO',
        position: 0,
        durationMinutes: 10,
      });
      fake.lessons.set('l-2', {
        id: 'l-2',
        tenantId: 't-1',
        moduleId: 'm-1',
        courseId: 'c-1',
        deletedAt: null,
        title: 'Lección 2',
        type: 'HTML',
        position: 1,
        durationMinutes: null,
      });
      const completedAt = new Date('2026-06-26T10:00:00.000Z');
      const lastAccessedAt = new Date('2026-06-26T11:00:00.000Z');
      fake.progress.set('en-1::l-1', {
        id: 'p-1',
        tenantId: 't-1',
        enrollmentId: 'en-1',
        lessonId: 'l-1',
        watchedSeconds: 120,
        resumePositionSec: 90,
        completed: true,
        completedAt,
        lastAccessedAt,
      });

      const service = new LearningService(fake.prisma as never, makeContext());
      const detail = await service.getEnrollmentProgressDetail('t-1', 'c-1', 'en-1');

      expect(detail.enrollmentId).toBe('en-1');
      expect(detail.userId).toBe('u-1');
      expect(detail.userEmail).toBe('a@b.com');
      expect(detail.userName).toBe('Alumno');
      expect(detail.status).toBe('ACTIVE');
      expect(detail.progressPercent).toBe(50);
      expect(detail.totalWatchedSeconds).toBe(120);
      expect(detail.lessonsCompleted).toBe(1);
      expect(detail.lessonsTotal).toBe(2);

      expect(detail.modules).toHaveLength(1);
      const mod = detail.modules[0]!;
      expect(mod.moduleId).toBe('m-1');
      expect(mod.lessons.map((l) => l.lessonId)).toEqual(['l-1', 'l-2']); // orden por position

      const lesson1 = mod.lessons[0]!;
      expect(lesson1.type).toBe('VIDEO');
      expect(lesson1.watchedSeconds).toBe(120);
      expect(lesson1.resumePositionSec).toBe(90);
      expect(lesson1.completed).toBe(true);
      expect(lesson1.durationMinutes).toBe(10);
      expect(lesson1.completedAt).toBe(completedAt.toISOString());
      expect(lesson1.lastAccessedAt).toBe(lastAccessedAt.toISOString());

      // Lección nunca empezada → todo en 0 / null, pero presente.
      const lesson2 = mod.lessons[1]!;
      expect(lesson2.type).toBe('HTML');
      expect(lesson2.watchedSeconds).toBe(0);
      expect(lesson2.resumePositionSec).toBe(0);
      expect(lesson2.completed).toBe(false);
      expect(lesson2.completedAt).toBeNull();
      expect(lesson2.lastAccessedAt).toBeNull();
      expect(lesson2.durationMinutes).toBeNull();
    });
  });

  describe('moderación de comentarios de lección (aislamiento por tenant)', () => {
    function seedComment(fake: ReturnType<typeof makeFakePrisma>, tenantId: string) {
      fake.lessonComments.set('cm-1', {
        id: 'cm-1',
        tenantId,
        status: 'PENDING',
        deletedAt: null,
        authorId: 'u-1',
      });
    }

    it('approveLessonComment aprueba un comentario del propio tenant', async () => {
      const fake = makeFakePrisma();
      seedComment(fake, 't-1');
      const service = new LearningService(fake.prisma as never, makeContext());
      const res = await service.approveLessonComment('t-1', 'rev-1', 'cm-1');
      expect((res as { status: string }).status).toBe('APPROVED');
    });

    it('approveLessonComment NO aprueba un comentario de OTRO tenant (write cross-tenant bloqueado)', async () => {
      const fake = makeFakePrisma();
      seedComment(fake, 't-2'); // comentario del tenant B
      const service = new LearningService(fake.prisma as never, makeContext());
      await expect(service.approveLessonComment('t-1', 'rev-1', 'cm-1')).rejects.toBeInstanceOf(
        EnrollmentNotFoundError,
      );
      // La fila del otro tenant NO se mutó.
      expect(fake.lessonComments.get('cm-1')!['status']).toBe('PENDING');
    });

    it('rejectLessonComment NO rechaza un comentario de OTRO tenant', async () => {
      const fake = makeFakePrisma();
      seedComment(fake, 't-2');
      const service = new LearningService(fake.prisma as never, makeContext());
      await expect(
        service.rejectLessonComment('t-1', 'rev-1', 'cm-1', 'spam'),
      ).rejects.toBeInstanceOf(EnrollmentNotFoundError);
      expect(fake.lessonComments.get('cm-1')!['status']).toBe('PENDING');
    });
  });
});
