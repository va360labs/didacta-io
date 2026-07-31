import { describe, expect, it, vi } from 'vitest';
import { FundaeGroupService } from '../src/group.service.js';

/**
 * Tests del cálculo de finalización Fundae (LMS-84).
 * Validan la lógica APTO/NO_APTO/EN_CURSO según umbral, status del
 * participante y status del grupo.
 */

interface ParticipantFixture {
  id: string;
  userId: string;
  status: 'ENROLLED' | 'REMOVED';
  nifAlumno: string | null;
  enrolledAt: Date;
}

interface EnrollmentFixture {
  userId: string;
  progressPercent: number;
  status: string;
  completedAt: Date | null;
}

function makeContext() {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
    eventBus: { publish: vi.fn(async () => {}) },
  } as never;
}

function makePrisma(opts: {
  group: {
    id: string;
    actionId: string;
    status: 'DRAFT' | 'ACTIVE' | 'CLOSED' | 'CANCELLED';
    umbralFinalizacionPct: number;
  };
  action: { courseId: string | null; horasFormacion: number };
  participants: ParticipantFixture[];
  enrollments?: EnrollmentFixture[];
}) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  return {
    updates,
    modFundaeGroup: {
      findFirst: vi.fn(async () => opts.group),
    },
    modFundaeAction: {
      findFirst: vi.fn(async () => opts.action),
    },
    modFundaeGroupParticipant: {
      findMany: vi.fn(async () => opts.participants),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          updates.push({ id: where.id, data });
          return { id: where.id };
        },
      ),
    },
    modLearningEnrollment: {
      findMany: vi.fn(async () => opts.enrollments ?? []),
    },
    user: {
      findMany: vi.fn(async () =>
        opts.participants.map((p) => ({
          id: p.userId,
          name: `User ${p.userId}`,
          email: `${p.userId}@x.com`,
        })),
      ),
    },
    $transaction: vi.fn(async (queries: Promise<unknown>[]) => Promise.all(queries)),
  } as never;
}

describe('FundaeGroupService.computeCompletion (LMS-84)', () => {
  it('marca APTO si progress >= umbral', async () => {
    const prisma = makePrisma({
      group: { id: 'g1', actionId: 'a1', status: 'ACTIVE', umbralFinalizacionPct: 75 },
      action: { courseId: 'c1', horasFormacion: 20 },
      participants: [
        {
          id: 'p1',
          userId: 'u1',
          status: 'ENROLLED',
          nifAlumno: '12345678Z',
          enrolledAt: new Date(),
        },
      ],
      enrollments: [
        { userId: 'u1', progressPercent: 80, status: 'IN_PROGRESS', completedAt: null },
      ],
    });
    const svc = new FundaeGroupService(prisma, makeContext(), {} as never);
    const res = await svc.computeCompletion('t1', null, 'g1', { preview: true });
    expect(res.aptos).toBe(1);
    expect(res.participants[0]!.resultado).toBe('APTO');
    expect(res.participants[0]!.horasAsistidas).toBe(16);
    expect(res.participants[0]!.progressPercent).toBe(80);
  });

  it('marca NO_APTO si progress < umbral y enrollment completado', async () => {
    const prisma = makePrisma({
      group: { id: 'g1', actionId: 'a1', status: 'ACTIVE', umbralFinalizacionPct: 75 },
      action: { courseId: 'c1', horasFormacion: 20 },
      participants: [
        { id: 'p1', userId: 'u1', status: 'ENROLLED', nifAlumno: null, enrolledAt: new Date() },
      ],
      enrollments: [
        { userId: 'u1', progressPercent: 50, status: 'COMPLETED', completedAt: new Date() },
      ],
    });
    const svc = new FundaeGroupService(prisma, makeContext(), {} as never);
    const res = await svc.computeCompletion('t1', null, 'g1', { preview: true });
    expect(res.noAptos).toBe(1);
    expect(res.participants[0]!.resultado).toBe('NO_APTO');
  });

  it('marca EN_CURSO si progress < umbral y grupo aún ACTIVE sin completedAt', async () => {
    const prisma = makePrisma({
      group: { id: 'g1', actionId: 'a1', status: 'ACTIVE', umbralFinalizacionPct: 75 },
      action: { courseId: 'c1', horasFormacion: 20 },
      participants: [
        { id: 'p1', userId: 'u1', status: 'ENROLLED', nifAlumno: null, enrolledAt: new Date() },
      ],
      enrollments: [
        { userId: 'u1', progressPercent: 30, status: 'IN_PROGRESS', completedAt: null },
      ],
    });
    const svc = new FundaeGroupService(prisma, makeContext(), {} as never);
    const res = await svc.computeCompletion('t1', null, 'g1', { preview: true });
    expect(res.enCurso).toBe(1);
    expect(res.participants[0]!.resultado).toBe('EN_CURSO');
  });

  it('marca NO_APTO si participant.status=REMOVED aunque tenga progreso', async () => {
    const prisma = makePrisma({
      group: { id: 'g1', actionId: 'a1', status: 'ACTIVE', umbralFinalizacionPct: 75 },
      action: { courseId: 'c1', horasFormacion: 20 },
      participants: [
        { id: 'p1', userId: 'u1', status: 'REMOVED', nifAlumno: null, enrolledAt: new Date() },
      ],
      enrollments: [
        { userId: 'u1', progressPercent: 90, status: 'COMPLETED', completedAt: new Date() },
      ],
    });
    const svc = new FundaeGroupService(prisma, makeContext(), {} as never);
    const res = await svc.computeCompletion('t1', null, 'g1', { preview: true });
    expect(res.noAptos).toBe(1);
    expect(res.participants[0]!.resultado).toBe('NO_APTO');
  });

  it('grupo CLOSED fuerza NO_APTO si no llega al umbral', async () => {
    const prisma = makePrisma({
      group: { id: 'g1', actionId: 'a1', status: 'CLOSED', umbralFinalizacionPct: 75 },
      action: { courseId: 'c1', horasFormacion: 10 },
      participants: [
        { id: 'p1', userId: 'u1', status: 'ENROLLED', nifAlumno: null, enrolledAt: new Date() },
      ],
      enrollments: [
        { userId: 'u1', progressPercent: 20, status: 'IN_PROGRESS', completedAt: null },
      ],
    });
    const svc = new FundaeGroupService(prisma, makeContext(), {} as never);
    const res = await svc.computeCompletion('t1', null, 'g1', { preview: true });
    expect(res.participants[0]!.resultado).toBe('NO_APTO');
  });

  it('umbralOverride pisa el del grupo', async () => {
    const prisma = makePrisma({
      group: { id: 'g1', actionId: 'a1', status: 'ACTIVE', umbralFinalizacionPct: 75 },
      action: { courseId: 'c1', horasFormacion: 20 },
      participants: [
        { id: 'p1', userId: 'u1', status: 'ENROLLED', nifAlumno: null, enrolledAt: new Date() },
      ],
      enrollments: [
        { userId: 'u1', progressPercent: 60, status: 'IN_PROGRESS', completedAt: null },
      ],
    });
    const svc = new FundaeGroupService(prisma, makeContext(), {} as never);
    const res = await svc.computeCompletion('t1', null, 'g1', {
      preview: true,
      umbralOverride: 50,
    });
    expect(res.umbralAplicadoPct).toBe(50);
    expect(res.participants[0]!.resultado).toBe('APTO');
  });

  it('preview=true NO persiste; preview=false SÍ persiste vía $transaction', async () => {
    const prismaPrev = makePrisma({
      group: { id: 'g1', actionId: 'a1', status: 'ACTIVE', umbralFinalizacionPct: 75 },
      action: { courseId: 'c1', horasFormacion: 20 },
      participants: [
        { id: 'p1', userId: 'u1', status: 'ENROLLED', nifAlumno: null, enrolledAt: new Date() },
      ],
      enrollments: [
        { userId: 'u1', progressPercent: 80, status: 'IN_PROGRESS', completedAt: null },
      ],
    });
    const svcPrev = new FundaeGroupService(prismaPrev, makeContext(), {} as never);
    await svcPrev.computeCompletion('t1', null, 'g1', { preview: true });
    expect((prismaPrev as never as { updates: unknown[] }).updates.length).toBe(0);

    const prismaPersist = makePrisma({
      group: { id: 'g1', actionId: 'a1', status: 'ACTIVE', umbralFinalizacionPct: 75 },
      action: { courseId: 'c1', horasFormacion: 20 },
      participants: [
        { id: 'p1', userId: 'u1', status: 'ENROLLED', nifAlumno: null, enrolledAt: new Date() },
      ],
      enrollments: [
        { userId: 'u1', progressPercent: 80, status: 'IN_PROGRESS', completedAt: null },
      ],
    });
    const svcPersist = new FundaeGroupService(prismaPersist, makeContext(), {} as never);
    await svcPersist.computeCompletion('t1', null, 'g1', { preview: false });
    const updates = (
      prismaPersist as never as { updates: Array<{ id: string; data: Record<string, unknown> }> }
    ).updates;
    expect(updates.length).toBe(1);
    expect(updates[0]!.data.resultado).toBe('APTO');
    expect(updates[0]!.data.progressPercent).toBe(80);
    expect(updates[0]!.data.horasAsistidas).toBe(16);
  });

  it('acción sin courseId → todos quedan EN_CURSO con 0 horas', async () => {
    const prisma = makePrisma({
      group: { id: 'g1', actionId: 'a1', status: 'ACTIVE', umbralFinalizacionPct: 75 },
      action: { courseId: null, horasFormacion: 20 },
      participants: [
        { id: 'p1', userId: 'u1', status: 'ENROLLED', nifAlumno: null, enrolledAt: new Date() },
      ],
    });
    const svc = new FundaeGroupService(prisma, makeContext(), {} as never);
    const res = await svc.computeCompletion('t1', null, 'g1', { preview: true });
    expect(res.enCurso).toBe(1);
    expect(res.participants[0]!.horasAsistidas).toBe(0);
    expect(res.participants[0]!.progressPercent).toBe(0);
  });

  it('grupo sin participantes → totales en cero', async () => {
    const prisma = makePrisma({
      group: { id: 'g1', actionId: 'a1', status: 'ACTIVE', umbralFinalizacionPct: 75 },
      action: { courseId: 'c1', horasFormacion: 20 },
      participants: [],
    });
    const svc = new FundaeGroupService(prisma, makeContext(), {} as never);
    const res = await svc.computeCompletion('t1', null, 'g1', { preview: true });
    expect(res.totalParticipantes).toBe(0);
    expect(res.aptos).toBe(0);
    expect(res.noAptos).toBe(0);
    expect(res.enCurso).toBe(0);
    expect(res.participants).toEqual([]);
  });
});
