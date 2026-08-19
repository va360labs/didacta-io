import { describe, expect, it } from 'vitest';
import { AssessmentsService } from '../src/assessments.service.js';
import {
  AttemptAlreadySubmittedError,
  AttemptExpiredError,
  AttemptNotFoundError,
  MaxAttemptsReachedError,
  QuizNotPublishedError,
} from '../src/errors.js';

interface QuizRow {
  id: string;
  tenantId: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  passThreshold: number;
  maxAttempts: number | null;
  timeLimitMinutes: number | null;
  publishedAt: Date | null;
  lessonId: string | null;
  deletedAt: Date | null;
}

interface QuestionRow {
  id: string;
  tenantId: string;
  quizId: string;
  type: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'TRUE_FALSE';
  prompt: string;
  position: number;
  points: number;
  feedback: string | null;
  deletedAt: Date | null;
  options: { id: string; isCorrect: boolean; label: string; position: number }[];
}

interface AttemptRow {
  id: string;
  tenantId: string;
  quizId: string;
  userId: string;
  enrollmentId: string | null;
  lessonId: string | null;
  // El enum real tambien tiene PENDING_REVIEW y GRADED (correccion manual).
  // Faltaban aqui, y por eso ningun test podia sembrarlos ni ver que no
  // contaban contra maxAttempts.
  status: 'IN_PROGRESS' | 'SUBMITTED' | 'PENDING_REVIEW' | 'GRADED' | 'EXPIRED' | 'ABANDONED';
  scoreEarned: number | null;
  scoreMax: number | null;
  scorePercent: number | null;
  passed: boolean | null;
  startedAt: Date;
  expiresAt: Date | null;
  submittedAt: Date | null;
}

interface AnswerRow {
  id: string;
  tenantId: string;
  attemptId: string;
  questionId: string;
  selectedOptionIds: string[];
  isCorrect: boolean;
  scoreEarned: number;
}

function makeFakePrisma(
  opts: {
    quizzes?: QuizRow[];
    questions?: QuestionRow[];
    attempts?: AttemptRow[];
    answers?: AnswerRow[];
  } = {},
) {
  const quizzes = opts.quizzes ?? [];
  const questions = opts.questions ?? [];
  const attempts = opts.attempts ?? [];
  const answers = opts.answers ?? [];
  let attemptIdCounter = attempts.length + 1;
  let answerIdCounter = answers.length + 1;

  const prisma = {
    modAssessmentsQuiz: {
      async findFirst(args: { where: { id: string; tenantId: string } }) {
        return (
          quizzes.find(
            (q) =>
              q.id === args.where.id && q.tenantId === args.where.tenantId && q.deletedAt === null,
          ) ?? null
        );
      },
    },
    modAssessmentsAttempt: {
      async count(args: {
        where: {
          tenantId: string;
          quizId: string;
          userId: string;
          status: { in?: string[]; notIn?: string[] };
        };
      }) {
        const { status } = args.where;
        return attempts.filter(
          (a) =>
            a.tenantId === args.where.tenantId &&
            a.quizId === args.where.quizId &&
            a.userId === args.where.userId &&
            (status.in ? status.in.includes(a.status) : true) &&
            (status.notIn ? !status.notIn.includes(a.status) : true),
        ).length;
      },
      async create(args: { data: Omit<AttemptRow, 'id'> }): Promise<AttemptRow> {
        const row: AttemptRow = { id: `attempt-${attemptIdCounter++}`, ...args.data };
        attempts.push(row);
        return row;
      },
      async findFirst(args: { where: { id: string; tenantId: string; userId: string } }) {
        return (
          attempts.find(
            (a) =>
              a.id === args.where.id &&
              a.tenantId === args.where.tenantId &&
              a.userId === args.where.userId,
          ) ?? null
        );
      },
      async update(args: { where: { id: string }; data: Partial<AttemptRow> }) {
        const existing = attempts.find((a) => a.id === args.where.id);
        if (!existing) throw new Error('not found');
        Object.assign(existing, args.data);
        return existing;
      },
    },
    modAssessmentsQuestion: {
      async findMany(args: { where: { tenantId: string; quizId: string } }) {
        return questions.filter(
          (q) =>
            q.tenantId === args.where.tenantId &&
            q.quizId === args.where.quizId &&
            q.deletedAt === null,
        );
      },
    },
    modAssessmentsAnswer: {
      async deleteMany(args: { where: { attemptId: string } }) {
        for (let i = answers.length - 1; i >= 0; i--) {
          if (answers[i]?.attemptId === args.where.attemptId) answers.splice(i, 1);
        }
        return { count: 0 };
      },
      async create(args: { data: Omit<AnswerRow, 'id'> }): Promise<AnswerRow> {
        const row: AnswerRow = { id: `ans-${answerIdCounter++}`, ...args.data };
        answers.push(row);
        return row;
      },
    },
    // `typeof prisma` aquí haría que `prisma` se refiriese a sí mismo en su
    // propio inicializador (TS7022) y todo el doble caería a `any` implícito.
    async $transaction<T>(cb: (tx: unknown) => Promise<T>): Promise<T> {
      return cb(prisma);
    },
    _attempts: attempts,
    _answers: answers,
  };
  return prisma;
}

const trackingCtx = (events: { name: string; data: unknown }[]) =>
  ({
    eventBus: {
      publish: async (e: { name: string; data: unknown }) => {
        events.push(e);
      },
    },
  }) as never;

const publishedQuiz = (overrides: Partial<QuizRow> = {}): QuizRow => ({
  id: 'q1',
  tenantId: 't1',
  status: 'PUBLISHED',
  passThreshold: 60,
  maxAttempts: null,
  timeLimitMinutes: null,
  publishedAt: new Date(),
  lessonId: null,
  deletedAt: null,
  ...overrides,
});

const singleChoiceQ = (id: string, correctId: string): QuestionRow => ({
  id,
  tenantId: 't1',
  quizId: 'q1',
  type: 'SINGLE_CHOICE',
  prompt: '?',
  position: 1,
  points: 1,
  feedback: null,
  deletedAt: null,
  options: [
    { id: `${id}-a`, isCorrect: correctId === `${id}-a`, label: 'A', position: 1 },
    { id: `${id}-b`, isCorrect: correctId === `${id}-b`, label: 'B', position: 2 },
  ],
});

describe('AssessmentsService.startAttempt', () => {
  it('error si el quiz no está PUBLISHED', async () => {
    const prisma = makeFakePrisma({ quizzes: [publishedQuiz({ status: 'DRAFT' })] });
    const events: { name: string; data: unknown }[] = [];
    const svc = new AssessmentsService(prisma as never, trackingCtx(events));

    await expect(svc.startAttempt('t1', 'u1', { quizId: 'q1' })).rejects.toBeInstanceOf(
      QuizNotPublishedError,
    );
  });

  it('crea el intento y emite assessments.attempt.started', async () => {
    const prisma = makeFakePrisma({ quizzes: [publishedQuiz({ lessonId: 'l1' })] });
    const events: { name: string; data: unknown }[] = [];
    const svc = new AssessmentsService(prisma as never, trackingCtx(events));

    const attempt = await svc.startAttempt('t1', 'u1', { quizId: 'q1' });
    expect(attempt.status).toBe('IN_PROGRESS');
    expect(attempt.userId).toBe('u1');
    expect(attempt.lessonId).toBe('l1');
    expect(events[0]?.name).toBe('assessments.attempt.started');
  });

  it('la leccion del intento la manda el quiz, no el cliente (H2)', async () => {
    // El quiz cuelga de la leccion facil; el cliente apunta al examen final.
    const prisma = makeFakePrisma({ quizzes: [publishedQuiz({ lessonId: 'leccion-facil' })] });
    const svc = new AssessmentsService(prisma as never, trackingCtx([]));

    const attempt = await svc.startAttempt('t1', 'u1', {
      quizId: 'q1',
      lessonId: 'examen-final',
    });

    // Aprobar este quiz solo puede cerrar SU leccion.
    expect(attempt.lessonId).toBe('leccion-facil');
  });

  it('un quiz sin leccion deja el intento sin leccion (el puente no hace nada)', async () => {
    const prisma = makeFakePrisma({ quizzes: [publishedQuiz({ lessonId: null })] });
    const svc = new AssessmentsService(prisma as never, trackingCtx([]));

    const attempt = await svc.startAttempt('t1', 'u1', {
      quizId: 'q1',
      lessonId: 'examen-final',
    });

    expect(attempt.lessonId).toBeNull();
  });

  it('rellena expiresAt cuando el quiz tiene timeLimitMinutes', async () => {
    const prisma = makeFakePrisma({ quizzes: [publishedQuiz({ timeLimitMinutes: 30 })] });
    const svc = new AssessmentsService(prisma as never, trackingCtx([]));

    const before = Date.now();
    const attempt = await svc.startAttempt('t1', 'u1', { quizId: 'q1' });
    expect(attempt.expiresAt).not.toBeNull();
    const expectedMs = before + 30 * 60_000;
    expect(attempt.expiresAt!.getTime()).toBeGreaterThanOrEqual(expectedMs - 1000);
    expect(attempt.expiresAt!.getTime()).toBeLessThanOrEqual(expectedMs + 1000);
  });

  it('rechaza cuando ya se alcanzó maxAttempts', async () => {
    const previous: AttemptRow[] = [
      {
        id: 'old-1',
        tenantId: 't1',
        quizId: 'q1',
        userId: 'u1',
        enrollmentId: null,
        lessonId: null,
        status: 'SUBMITTED',
        scoreEarned: 1,
        scoreMax: 1,
        scorePercent: 100,
        passed: true,
        startedAt: new Date(),
        expiresAt: null,
        submittedAt: new Date(),
      },
    ];
    const prisma = makeFakePrisma({
      quizzes: [publishedQuiz({ maxAttempts: 1 })],
      attempts: previous,
    });
    const svc = new AssessmentsService(prisma as never, trackingCtx([]));

    await expect(svc.startAttempt('t1', 'u1', { quizId: 'q1' })).rejects.toBeInstanceOf(
      MaxAttemptsReachedError,
    );
  });

  it.each(['PENDING_REVIEW', 'GRADED'] as const)(
    'un intento %s tambien gasta intento (H7: examen con correccion manual)',
    async (status) => {
      // Cualquier quiz con una pregunta abierta acaba en PENDING_REVIEW y luego
      // en GRADED. Ninguno de los dos se contaba: con maxAttempts 1, suspender
      // un examen corregido a mano se podia repetir sin limite.
      const previous: AttemptRow[] = [
        {
          id: 'old-1',
          tenantId: 't1',
          quizId: 'q1',
          userId: 'u1',
          enrollmentId: null,
          lessonId: null,
          status,
          scoreEarned: 0,
          scoreMax: 1,
          scorePercent: 0,
          passed: false,
          startedAt: new Date(),
          expiresAt: null,
          submittedAt: new Date(),
        },
      ];
      const prisma = makeFakePrisma({
        quizzes: [publishedQuiz({ maxAttempts: 1 })],
        attempts: previous,
      });
      const svc = new AssessmentsService(prisma as never, trackingCtx([]));

      await expect(svc.startAttempt('t1', 'u1', { quizId: 'q1' })).rejects.toBeInstanceOf(
        MaxAttemptsReachedError,
      );
    },
  );

  it('un intento IN_PROGRESS no gasta intento', async () => {
    const previous: AttemptRow[] = [
      {
        id: 'old-1',
        tenantId: 't1',
        quizId: 'q1',
        userId: 'u1',
        enrollmentId: null,
        lessonId: null,
        status: 'IN_PROGRESS',
        scoreEarned: 0,
        scoreMax: 1,
        scorePercent: 0,
        passed: false,
        startedAt: new Date(),
        expiresAt: null,
        submittedAt: null,
      },
    ];
    const prisma = makeFakePrisma({
      quizzes: [publishedQuiz({ maxAttempts: 1 })],
      attempts: previous,
    });
    const svc = new AssessmentsService(prisma as never, trackingCtx([]));

    await expect(svc.startAttempt('t1', 'u1', { quizId: 'q1' })).resolves.toBeTruthy();
  });
});

describe('AssessmentsService.submitAttempt', () => {
  function setupActiveAttempt(
    opts: {
      passThreshold?: number;
      questions?: QuestionRow[];
      expiresAt?: Date | null;
    } = {},
  ) {
    const quiz = publishedQuiz({ passThreshold: opts.passThreshold ?? 60 });
    const questions = opts.questions ?? [singleChoiceQ('q-1', 'q-1-a')];
    const attempt: AttemptRow = {
      id: 'attempt-1',
      tenantId: 't1',
      quizId: 'q1',
      userId: 'u1',
      enrollmentId: 'enr-1',
      lessonId: 'l-1',
      status: 'IN_PROGRESS',
      scoreEarned: null,
      scoreMax: null,
      scorePercent: null,
      passed: null,
      startedAt: new Date(),
      expiresAt: opts.expiresAt === undefined ? null : opts.expiresAt,
      submittedAt: null,
    };
    const events: { name: string; data: unknown }[] = [];
    const prisma = makeFakePrisma({ quizzes: [quiz], questions, attempts: [attempt] });
    const svc = new AssessmentsService(prisma as never, trackingCtx(events));
    return { svc, prisma, events, attempt };
  }

  it('respuesta correcta → SUBMITTED, passed=true y emite passed', async () => {
    const { svc, events, prisma } = setupActiveAttempt();
    const result = await svc.submitAttempt('t1', 'u1', {
      attemptId: 'attempt-1',
      answers: [{ questionId: 'q-1', selectedOptionIds: ['q-1-a'] }],
    });

    expect(result.status).toBe('SUBMITTED');
    expect(result.scorePercent).toBe(100);
    expect(result.passed).toBe(true);
    const eventNames = events.map((e) => e.name);
    expect(eventNames).toContain('assessments.attempt.submitted');
    expect(eventNames).toContain('assessments.attempt.passed');
    expect(eventNames).not.toContain('assessments.attempt.failed');
    expect(prisma._answers).toHaveLength(1);
    expect(prisma._answers[0]?.isCorrect).toBe(true);
  });

  it('respuesta incorrecta → passed=false y emite failed', async () => {
    const { svc, events } = setupActiveAttempt();
    const result = await svc.submitAttempt('t1', 'u1', {
      attemptId: 'attempt-1',
      answers: [{ questionId: 'q-1', selectedOptionIds: ['q-1-b'] }],
    });

    expect(result.passed).toBe(false);
    expect(result.scorePercent).toBe(0);
    const eventNames = events.map((e) => e.name);
    expect(eventNames).toContain('assessments.attempt.failed');
    expect(eventNames).not.toContain('assessments.attempt.passed');
  });

  it('intento ya enviado → AttemptAlreadySubmittedError', async () => {
    const { svc, prisma } = setupActiveAttempt();
    prisma._attempts[0]!.status = 'SUBMITTED';

    await expect(
      svc.submitAttempt('t1', 'u1', {
        attemptId: 'attempt-1',
        answers: [{ questionId: 'q-1', selectedOptionIds: ['q-1-a'] }],
      }),
    ).rejects.toBeInstanceOf(AttemptAlreadySubmittedError);
  });

  it('intento expirado → marca como EXPIRED y lanza AttemptExpiredError', async () => {
    const past = new Date(Date.now() - 10_000);
    const { svc, prisma } = setupActiveAttempt({ expiresAt: past });

    await expect(
      svc.submitAttempt('t1', 'u1', {
        attemptId: 'attempt-1',
        answers: [{ questionId: 'q-1', selectedOptionIds: ['q-1-a'] }],
      }),
    ).rejects.toBeInstanceOf(AttemptExpiredError);
    expect(prisma._attempts[0]?.status).toBe('EXPIRED');
  });

  it('intento de otro usuario → AttemptNotFoundError', async () => {
    const { svc } = setupActiveAttempt();

    await expect(
      svc.submitAttempt('t1', 'usuario-otro', {
        attemptId: 'attempt-1',
        answers: [{ questionId: 'q-1', selectedOptionIds: ['q-1-a'] }],
      }),
    ).rejects.toBeInstanceOf(AttemptNotFoundError);
  });

  it('payload de evento incluye scoreEarned/scoreMax/passed/enrollmentId/lessonId', async () => {
    const { svc, events } = setupActiveAttempt();
    await svc.submitAttempt('t1', 'u1', {
      attemptId: 'attempt-1',
      answers: [{ questionId: 'q-1', selectedOptionIds: ['q-1-a'] }],
    });

    const passed = events.find((e) => e.name === 'assessments.attempt.passed');
    expect(passed?.data).toMatchObject({
      attemptId: 'attempt-1',
      quizId: 'q1',
      userId: 'u1',
      enrollmentId: 'enr-1',
      lessonId: 'l-1',
      scoreEarned: 1,
      scoreMax: 1,
      scorePercent: 100,
      passed: true,
    });
  });
});
