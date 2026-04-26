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
}
interface FakeLesson {
  id: string;
  tenantId: string;
  moduleId: string;
  courseId: string;
  deletedAt: Date | null;
}

function makeFakePrisma() {
  const courses = new Map<string, FakeCourse>();
  const enrollments = new Map<string, FakeEnrollment>();
  const invitations = new Map<string, FakeInvitation>();
  const progress = new Map<string, FakeProgress>();
  const lessons = new Map<string, FakeLesson>();
  let counter = 0;
  const id = (p = 'id') => `${p}-${++counter}`;

  return {
    courses,
    enrollments,
    invitations,
    progress,
    lessons,
    prisma: {
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
});
