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

/**
 * Una lección del itinerario con el progreso de UN alumno pegado. Desde LMS-121
 * las horas salen de aquí y no de `progressPercent`, así que los fixtures que
 * solo declaran porcentaje describen un curso SIN lecciones: ese es justamente
 * el caso en que el cálculo conserva la estimación antigua (ver
 * `tracking-evidence.ts`), y por eso los tests de umbral de abajo siguen valiendo.
 */
interface LessonProgressFixture {
  lessonId: string;
  userId: string;
  watchedSeconds?: number;
  completed?: boolean;
  completionSource?: 'SELF' | 'TIME' | 'ASSESSMENT' | 'SCORM' | 'INSTRUCTOR' | null;
}

interface LessonFixture {
  id: string;
  type?: string;
  durationMinutes?: number | null;
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
  action: { courseId: string | null; horasFormacion: number; criterioFinalizacion?: string };
  participants: ParticipantFixture[];
  enrollments?: EnrollmentFixture[];
  lessons?: LessonFixture[];
  lessonProgress?: LessonProgressFixture[];
}) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const lessons = opts.lessons ?? [];
  const enrollmentIdByUser = new Map(
    (opts.enrollments ?? []).map((e, i) => [e.userId, `enr-${i}`] as const),
  );
  return {
    updates,
    modFundaeGroup: {
      findFirst: vi.fn(async () => opts.group),
    },
    modFundaeAction: {
      findFirst: vi.fn(async () => ({
        criterioFinalizacion: 'UMBRAL_PROGRESO',
        ...opts.action,
      })),
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
      findMany: vi.fn(async () =>
        (opts.enrollments ?? []).map((e) => ({
          ...e,
          id: enrollmentIdByUser.get(e.userId) ?? `enr-${e.userId}`,
        })),
      ),
    },
    modCoursesLesson: {
      findMany: vi.fn(async () =>
        lessons.map((l, i) => ({
          id: l.id,
          title: `Lección ${i + 1}`,
          type: l.type ?? 'VIDEO',
          durationMinutes: l.durationMinutes ?? null,
          position: i + 1,
          module: { title: 'Módulo 1', position: 1 },
        })),
      ),
    },
    modLearningProgress: {
      findMany: vi.fn(async () =>
        (opts.lessonProgress ?? []).map((row) => ({
          enrollmentId: enrollmentIdByUser.get(row.userId) ?? `enr-${row.userId}`,
          lessonId: row.lessonId,
          watchedSeconds: row.watchedSeconds ?? 0,
          completed: row.completed ?? false,
          completionSource: row.completionSource ?? null,
          firstAccessedAt: new Date('2026-03-01T09:00:00Z'),
          lastAccessedAt: new Date('2026-03-02T09:00:00Z'),
          completedAt: row.completed ? new Date('2026-03-02T09:00:00Z') : null,
        })),
      ),
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

describe('computeCompletion — criterio de la instrucción (LMS-124)', () => {
  /**
   * Un itinerario de 4 h: dos vídeos de 1 h y dos cuestionarios de 1 h.
   * `hechas` dice cuáles cerró el alumno y con qué respaldo.
   */
  function itinerario(
    hechas: Array<{ id: string; tipo: 'VIDEO' | 'QUIZ'; origen: string | null }>,
  ) {
    return {
      lessons: [
        { id: 'v1', type: 'VIDEO', durationMinutes: 60 },
        { id: 'v2', type: 'VIDEO', durationMinutes: 60 },
        { id: 'q1', type: 'QUIZ', durationMinutes: 60 },
        { id: 'q2', type: 'QUIZ', durationMinutes: 60 },
      ],
      lessonProgress: hechas.map((h) => ({
        lessonId: h.id,
        userId: 'u1',
        watchedSeconds: h.tipo === 'VIDEO' ? 3600 : 0,
        completed: true,
        completionSource: h.origen as never,
      })),
    };
  }

  const participante = [
    {
      id: 'p1',
      userId: 'u1',
      status: 'ENROLLED' as const,
      nifAlumno: '12345678Z',
      enrolledAt: new Date('2026-03-01'),
    },
  ];

  it('el que marcó todas las casillas sin abrir nada NO es APTO', async () => {
    // 100 % de progreso declarado, pero ni una finalización verificada: 0 % de
    // horas defendibles y 0 % de controles. Es el caso que motivó todo esto.
    const prisma = makePrisma({
      group: { id: 'g1', actionId: 'a1', status: 'ACTIVE', umbralFinalizacionPct: 75 },
      action: { courseId: 'c1', horasFormacion: 4, criterioFinalizacion: 'INSTRUCCION_75' },
      participants: participante,
      enrollments: [{ userId: 'u1', progressPercent: 100, status: 'ACTIVE', completedAt: null }],
      ...itinerario([
        { id: 'v1', tipo: 'VIDEO', origen: 'SELF' },
        { id: 'v2', tipo: 'VIDEO', origen: 'SELF' },
        { id: 'q1', tipo: 'QUIZ', origen: 'SELF' },
        { id: 'q2', tipo: 'QUIZ', origen: 'SELF' },
      ]),
    });
    const service = new FundaeGroupService(prisma, makeContext(), {} as never);

    const res = await service.computeCompletion('t-1', null, 'g1', { preview: true });

    expect(res.participants[0]?.resultado).toBe('EN_CURSO');
    expect(res.participants[0]?.evidencia?.pctControles).toBe(0);
  });

  it('con el criterio de siempre, ese MISMO alumno sí sale APTO', async () => {
    // La prueba de que el cambio de veredicto lo trae el criterio y no otra
    // cosa: mismos datos, solo cambia la marca de la acción.
    const prisma = makePrisma({
      group: { id: 'g1', actionId: 'a1', status: 'ACTIVE', umbralFinalizacionPct: 75 },
      action: { courseId: 'c1', horasFormacion: 4, criterioFinalizacion: 'UMBRAL_PROGRESO' },
      participants: participante,
      enrollments: [{ userId: 'u1', progressPercent: 100, status: 'ACTIVE', completedAt: null }],
      ...itinerario([
        { id: 'v1', tipo: 'VIDEO', origen: 'SELF' },
        { id: 'v2', tipo: 'VIDEO', origen: 'SELF' },
        { id: 'q1', tipo: 'QUIZ', origen: 'SELF' },
        { id: 'q2', tipo: 'QUIZ', origen: 'SELF' },
      ]),
    });
    const service = new FundaeGroupService(prisma, makeContext(), {} as never);

    const res = await service.computeCompletion('t-1', null, 'g1', { preview: true });
    expect(res.participants[0]?.resultado).toBe('APTO');
  });

  it('todo hecho y verificado: APTO por los tres numeradores', async () => {
    const prisma = makePrisma({
      group: { id: 'g1', actionId: 'a1', status: 'ACTIVE', umbralFinalizacionPct: 75 },
      action: { courseId: 'c1', horasFormacion: 4, criterioFinalizacion: 'INSTRUCCION_75' },
      participants: participante,
      enrollments: [{ userId: 'u1', progressPercent: 100, status: 'ACTIVE', completedAt: null }],
      ...itinerario([
        { id: 'v1', tipo: 'VIDEO', origen: 'TIME' },
        { id: 'v2', tipo: 'VIDEO', origen: 'TIME' },
        { id: 'q1', tipo: 'QUIZ', origen: 'ASSESSMENT' },
        { id: 'q2', tipo: 'QUIZ', origen: 'ASSESSMENT' },
      ]),
    });
    const service = new FundaeGroupService(prisma, makeContext(), {} as never);

    const res = await service.computeCompletion('t-1', null, 'g1', { preview: true });
    const p = res.participants[0];
    expect(p?.resultado).toBe('APTO');
    expect(p?.evidencia?.pctHoras).toBe(100);
    expect(p?.evidencia?.pctActividades).toBe(100);
    expect(p?.evidencia?.pctControles).toBe(100);
  });

  it('horas de sobra pero la mitad de los controles: NO llega', async () => {
    // 3 de 4 h (75 %) y 1 de 2 controles (50 %). Las horas cumplen y los
    // controles no: el criterio exige los TRES, no el mejor de ellos.
    const prisma = makePrisma({
      group: { id: 'g1', actionId: 'a1', status: 'ACTIVE', umbralFinalizacionPct: 75 },
      action: { courseId: 'c1', horasFormacion: 4, criterioFinalizacion: 'INSTRUCCION_75' },
      participants: participante,
      enrollments: [{ userId: 'u1', progressPercent: 75, status: 'ACTIVE', completedAt: null }],
      ...itinerario([
        { id: 'v1', tipo: 'VIDEO', origen: 'TIME' },
        { id: 'v2', tipo: 'VIDEO', origen: 'TIME' },
        { id: 'q1', tipo: 'QUIZ', origen: 'ASSESSMENT' },
      ]),
    });
    const service = new FundaeGroupService(prisma, makeContext(), {} as never);

    const res = await service.computeCompletion('t-1', null, 'g1', { preview: true });
    const p = res.participants[0];
    expect(p?.evidencia?.pctHoras).toBe(75);
    expect(p?.evidencia?.pctControles).toBe(50);
    expect(p?.resultado).toBe('EN_CURSO');
  });

  it('un grupo CERRADO convierte el «aún no llega» en NO_APTO', async () => {
    const prisma = makePrisma({
      group: { id: 'g1', actionId: 'a1', status: 'CLOSED', umbralFinalizacionPct: 75 },
      action: { courseId: 'c1', horasFormacion: 4, criterioFinalizacion: 'INSTRUCCION_75' },
      participants: participante,
      enrollments: [{ userId: 'u1', progressPercent: 100, status: 'ACTIVE', completedAt: null }],
      ...itinerario([{ id: 'v1', tipo: 'VIDEO', origen: 'TIME' }]),
    });
    const service = new FundaeGroupService(prisma, makeContext(), {} as never);

    const res = await service.computeCompletion('t-1', null, 'g1', { preview: true });
    expect(res.participants[0]?.resultado).toBe('NO_APTO');
  });

  it('sin curso asociado el criterio nuevo no cambia nada respecto al de siempre', async () => {
    // No hay itinerario que medir — pero es que tampoco hay progreso: cuando la
    // acción no tiene curso, `computeCompletion` ni siquiera consulta las
    // matrículas. Así que el resultado es EN_CURSO con los dos criterios, y lo
    // que este test fija es justo eso: activar INSTRUCCION_75 en una acción sin
    // curso NO empeora el veredicto de nadie ni revienta por falta de datos.
    const prisma = makePrisma({
      group: { id: 'g1', actionId: 'a1', status: 'ACTIVE', umbralFinalizacionPct: 75 },
      action: { courseId: null, horasFormacion: 4, criterioFinalizacion: 'INSTRUCCION_75' },
      participants: participante,
      enrollments: [{ userId: 'u1', progressPercent: 90, status: 'ACTIVE', completedAt: null }],
    });
    const service = new FundaeGroupService(prisma, makeContext(), {} as never);

    const res = await service.computeCompletion('t-1', null, 'g1', { preview: true });
    expect(res.participants[0]?.resultado).toBe('EN_CURSO');
    expect(res.participants[0]?.evidencia).toBeUndefined();
  });
});
