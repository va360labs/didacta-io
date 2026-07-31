import { describe, expect, it, vi } from 'vitest';
import { ScormService } from '../src/scorm.service';

interface AttemptRow {
  id: string;
  tenantId: string;
  userId: string;
  lessonId: string;
  packageId: string;
  cmiData: Record<string, string>;
  completionStatus: string | null;
  scoreScaled: number | null;
  startedAt: Date;
  lastAccessedAt: Date;
  completedAt: Date | null;
}

interface PackageRow {
  id: string;
  tenantId: string;
  lessonId: string;
}

function setup(opts: { existingAttempt?: Partial<AttemptRow> } = {}) {
  const packages: PackageRow[] = [{ id: 'pkg-1', tenantId: 't1', lessonId: 'lesson-1' }];
  const attempts: AttemptRow[] = opts.existingAttempt
    ? [
        {
          id: 'att-1',
          tenantId: 't1',
          userId: 'user-1',
          lessonId: 'lesson-1',
          packageId: 'pkg-1',
          cmiData: {},
          completionStatus: null,
          scoreScaled: null,
          startedAt: new Date(),
          lastAccessedAt: new Date(),
          completedAt: null,
          ...opts.existingAttempt,
        },
      ]
    : [];

  const prisma = {
    modLearningScormPackage: {
      findUnique: vi.fn(
        async ({ where }: any) => packages.find((p) => p.lessonId === where.lessonId) ?? null,
      ),
    },
    modLearningScormAttempt: {
      findUnique: vi.fn(async ({ where }: any) => {
        const { userId, lessonId } = where.userId_lessonId;
        return attempts.find((a) => a.userId === userId && a.lessonId === lessonId) ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row: AttemptRow = {
          ...data,
          id: 'att-new',
          completionStatus: null,
          scoreScaled: null,
          startedAt: new Date(),
          lastAccessedAt: new Date(),
          completedAt: null,
        };
        attempts.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = attempts.find((a) => a.id === where.id);
        if (!row) throw new Error('attempt not found');
        Object.assign(row, data);
        return row;
      }),
    },
  } as never;

  const eventBus = { publish: vi.fn(async () => {}), subscribe: vi.fn() };
  const ctx = {
    eventBus,
    auditLog: { record: vi.fn() },
    storage: { upload: vi.fn(), download: vi.fn(), delete: vi.fn(), getSignedUrl: vi.fn() },
    evidenceVault: {},
    notificationHub: {},
    i18n: { t: (k: string) => k },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({}) },
    config: {},
    hookRegistry: { register: vi.fn(), run: vi.fn() },
  } as never;

  const service = new ScormService(prisma, ctx);
  return { service, prisma, eventBus, attempts };
}

describe('ScormService.getOrCreateAttempt', () => {
  it('crea un attempt nuevo si no existe', async () => {
    const ctx = setup();
    const result = await ctx.service.getOrCreateAttempt('t1', 'user-1', 'lesson-1');
    expect(result.lessonId).toBe('lesson-1');
    expect(result.cmiData).toEqual({});
    expect(ctx.attempts).toHaveLength(1);
  });

  it('reanuda el attempt existente con cmi previo', async () => {
    const ctx = setup({
      existingAttempt: { cmiData: { 'cmi.core.lesson_status': 'incomplete' } },
    });
    const result = await ctx.service.getOrCreateAttempt('t1', 'user-1', 'lesson-1');
    expect(result.cmiData['cmi.core.lesson_status']).toBe('incomplete');
    expect(ctx.attempts).toHaveLength(1);
  });
});

describe('ScormService.commitAttempt', () => {
  it('persiste cmi state y NO emite evento si no completó', async () => {
    const ctx = setup({ existingAttempt: {} });
    await ctx.service.commitAttempt('t1', 'user-1', 'lesson-1', {
      'cmi.core.lesson_status': 'incomplete',
      'cmi.core.lesson_location': 'page-3',
    });
    expect(ctx.attempts[0]?.cmiData['cmi.core.lesson_location']).toBe('page-3');
    expect(ctx.eventBus.publish).not.toHaveBeenCalled();
  });

  it('extrae completion_status SCORM 1.2 (cmi.core.lesson_status=passed)', async () => {
    const ctx = setup({ existingAttempt: {} });
    await ctx.service.commitAttempt('t1', 'user-1', 'lesson-1', {
      'cmi.core.lesson_status': 'passed',
    });
    expect(ctx.attempts[0]?.completionStatus).toBe('passed');
    expect(ctx.attempts[0]?.completedAt).not.toBeNull();
    expect(ctx.eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'scorm.attempt.completed' }),
    );
  });

  it('extrae completion_status SCORM 2004 (cmi.completion_status=completed)', async () => {
    const ctx = setup({ existingAttempt: {} });
    await ctx.service.commitAttempt('t1', 'user-1', 'lesson-1', {
      'cmi.completion_status': 'completed',
    });
    expect(ctx.attempts[0]?.completionStatus).toBe('completed');
    expect(ctx.eventBus.publish).toHaveBeenCalled();
  });

  it('extrae score scaled SCORM 1.2 (raw/max)', async () => {
    const ctx = setup({ existingAttempt: {} });
    await ctx.service.commitAttempt('t1', 'user-1', 'lesson-1', {
      'cmi.core.score.raw': '80',
      'cmi.core.score.max': '100',
    });
    expect(ctx.attempts[0]?.scoreScaled).toBe(0.8);
  });

  it('extrae score scaled SCORM 2004 (cmi.score.scaled)', async () => {
    const ctx = setup({ existingAttempt: {} });
    await ctx.service.commitAttempt('t1', 'user-1', 'lesson-1', {
      'cmi.score.scaled': '0.92',
    });
    expect(ctx.attempts[0]?.scoreScaled).toBe(0.92);
  });

  it('idempotente: second commit con mismo completion no emite evento de nuevo', async () => {
    const ctx = setup({
      existingAttempt: {
        completedAt: new Date(),
        completionStatus: 'passed',
      },
    });
    await ctx.service.commitAttempt('t1', 'user-1', 'lesson-1', {
      'cmi.core.lesson_status': 'passed',
    });
    expect(ctx.eventBus.publish).not.toHaveBeenCalled();
  });

  it('rechaza con SCORM_PACKAGE_NOT_FOUND si no hay attempt', async () => {
    const ctx = setup();
    await expect(
      ctx.service.commitAttempt('t1', 'user-1', 'lesson-1', { 'cmi.core.lesson_status': 'passed' }),
    ).rejects.toMatchObject({ code: 'SCORM_PACKAGE_NOT_FOUND' });
  });
});
