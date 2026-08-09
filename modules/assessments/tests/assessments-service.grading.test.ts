import { describe, expect, it } from 'vitest';
import { AssessmentsService } from '../src/assessments.service.js';
import {
  AttemptNotFoundError,
  AttemptNotPendingReviewError,
  GradeExceedsQuestionPointsError,
} from '../src/errors.js';

interface QuizRow {
  id: string;
  tenantId: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  passThreshold: number;
  publishedAt: Date | null;
  lessonId: string | null;
  deletedAt: Date | null;
}

interface QuestionRow {
  id: string;
  tenantId: string;
  quizId: string;
  points: number;
  deletedAt: Date | null;
}

interface AttemptRow {
  id: string;
  tenantId: string;
  quizId: string;
  userId: string;
  enrollmentId: string | null;
  lessonId: string | null;
  status: 'IN_PROGRESS' | 'SUBMITTED' | 'PENDING_REVIEW' | 'GRADED' | 'EXPIRED' | 'ABANDONED';
  scoreEarned: number | null;
  scoreMax: number | null;
  scorePercent: number | null;
  passed: boolean | null;
  startedAt: Date;
  submittedAt: Date | null;
  gradedAt: Date | null;
  gradedById: string | null;
}

interface AnswerRow {
  id: string;
  tenantId: string;
  attemptId: string;
  questionId: string;
  scoreEarned: number;
  isCorrect: boolean;
  gradedFeedback: string | null;
}

function makeFakePrisma(opts: {
  quiz: QuizRow;
  questions: QuestionRow[];
  attempt: AttemptRow;
  answers: AnswerRow[];
}) {
  const { quiz, questions, attempt, answers } = opts;
  const prisma = {
    modAssessmentsQuiz: {
      async findFirst(args: { where: { id: string; tenantId: string } }) {
        if (
          quiz.id === args.where.id &&
          quiz.tenantId === args.where.tenantId &&
          quiz.deletedAt === null
        )
          return quiz;
        return null;
      },
    },
    modAssessmentsAttempt: {
      async findFirst(args: { where: { id: string; tenantId: string } }) {
        if (attempt.id === args.where.id && attempt.tenantId === args.where.tenantId) {
          return { ...attempt, answers };
        }
        return null;
      },
      async update(args: { where: { id: string }; data: Partial<AttemptRow> }) {
        if (attempt.id !== args.where.id) throw new Error('not found');
        Object.assign(attempt, args.data);
        return attempt;
      },
    },
    modAssessmentsQuestion: {
      async findMany() {
        return questions;
      },
    },
    modAssessmentsAnswer: {
      async update(args: { where: { id: string }; data: Partial<AnswerRow> }) {
        const found = answers.find((a) => a.id === args.where.id);
        if (!found) throw new Error('not found');
        Object.assign(found, args.data);
        return found;
      },
      async findMany(args: { where: { attemptId: string } }) {
        return answers.filter((a) => a.attemptId === args.where.attemptId);
      },
    },
    // Idem attempts: `typeof prisma` sería circular (TS7022).
    async $transaction<T>(cb: (tx: unknown) => Promise<T>): Promise<T> {
      return cb(prisma);
    },
    _attempt: attempt,
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

const baseQuiz = (overrides: Partial<QuizRow> = {}): QuizRow => ({
  id: 'q1',
  tenantId: 't1',
  status: 'PUBLISHED',
  passThreshold: 60,
  publishedAt: new Date(),
  lessonId: null,
  deletedAt: null,
  ...overrides,
});

const baseAttempt = (overrides: Partial<AttemptRow> = {}): AttemptRow => ({
  id: 'attempt-1',
  tenantId: 't1',
  quizId: 'q1',
  userId: 'u1',
  enrollmentId: 'enr-1',
  lessonId: 'l-1',
  status: 'PENDING_REVIEW',
  scoreEarned: 1, // 1 punto del SC objetivo
  scoreMax: 11, // 1 + 10 (open)
  scorePercent: null,
  passed: null,
  startedAt: new Date(),
  submittedAt: new Date(),
  gradedAt: null,
  gradedById: null,
  ...overrides,
});

describe('AssessmentsService.gradeAttempt', () => {
  it('error si el attempt no existe', async () => {
    const prisma = makeFakePrisma({
      quiz: baseQuiz(),
      questions: [],
      attempt: { ...baseAttempt(), id: 'otro' },
      answers: [],
    });
    const svc = new AssessmentsService(prisma as never, trackingCtx([]));
    await expect(
      svc.gradeAttempt('t1', 'admin', 'attempt-1', {
        grades: [{ questionId: 'q', scoreEarned: 0 }],
      }),
    ).rejects.toBeInstanceOf(AttemptNotFoundError);
  });

  it('error si el attempt no está PENDING_REVIEW', async () => {
    const prisma = makeFakePrisma({
      quiz: baseQuiz(),
      questions: [],
      attempt: baseAttempt({ status: 'SUBMITTED' }),
      answers: [],
    });
    const svc = new AssessmentsService(prisma as never, trackingCtx([]));
    await expect(
      svc.gradeAttempt('t1', 'admin', 'attempt-1', {
        grades: [{ questionId: 'q-open', scoreEarned: 5 }],
      }),
    ).rejects.toBeInstanceOf(AttemptNotPendingReviewError);
  });

  it('error si scoreEarned excede los puntos máximos de la pregunta', async () => {
    const prisma = makeFakePrisma({
      quiz: baseQuiz(),
      questions: [{ id: 'q-open', tenantId: 't1', quizId: 'q1', points: 5, deletedAt: null }],
      attempt: baseAttempt(),
      answers: [
        {
          id: 'a-open',
          tenantId: 't1',
          attemptId: 'attempt-1',
          questionId: 'q-open',
          scoreEarned: 0,
          isCorrect: false,
          gradedFeedback: null,
        },
      ],
    });
    const svc = new AssessmentsService(prisma as never, trackingCtx([]));
    await expect(
      svc.gradeAttempt('t1', 'admin', 'attempt-1', {
        grades: [{ questionId: 'q-open', scoreEarned: 99 }],
      }),
    ).rejects.toBeInstanceOf(GradeExceedsQuestionPointsError);
  });

  it('grade pasa: status GRADED + recomputo del total + emite passed', async () => {
    const events: { name: string; data: unknown }[] = [];
    const prisma = makeFakePrisma({
      quiz: baseQuiz({ passThreshold: 60 }),
      questions: [
        { id: 'q-sc', tenantId: 't1', quizId: 'q1', points: 1, deletedAt: null },
        { id: 'q-open', tenantId: 't1', quizId: 'q1', points: 10, deletedAt: null },
      ],
      attempt: baseAttempt({ scoreEarned: 1, scoreMax: 11 }),
      answers: [
        {
          id: 'a-sc',
          tenantId: 't1',
          attemptId: 'attempt-1',
          questionId: 'q-sc',
          scoreEarned: 1,
          isCorrect: true,
          gradedFeedback: null,
        },
        {
          id: 'a-open',
          tenantId: 't1',
          attemptId: 'attempt-1',
          questionId: 'q-open',
          scoreEarned: 0,
          isCorrect: false,
          gradedFeedback: null,
        },
      ],
    });
    const svc = new AssessmentsService(prisma as never, trackingCtx(events));

    const result = await svc.gradeAttempt('t1', 'admin', 'attempt-1', {
      grades: [{ questionId: 'q-open', scoreEarned: 8, feedback: 'Buen trabajo' }],
    });

    expect(result.status).toBe('GRADED');
    expect(result.scoreEarned).toBe(9); // 1 + 8
    expect(result.scorePercent).toBe(82); // 9/11 = 81.8 → 82
    expect(result.passed).toBe(true);
    expect(result.gradedAt).toBeInstanceOf(Date);
    expect(result.gradedById).toBe('admin');

    expect(prisma._answers.find((a) => a.id === 'a-open')?.scoreEarned).toBe(8);
    expect(prisma._answers.find((a) => a.id === 'a-open')?.gradedFeedback).toBe('Buen trabajo');

    const eventNames = events.map((e) => e.name);
    expect(eventNames).toContain('assessments.attempt.graded');
    expect(eventNames).toContain('assessments.attempt.passed');
    expect(eventNames).not.toContain('assessments.attempt.failed');
  });

  it('grade fail: total queda por debajo del threshold → emite failed', async () => {
    const events: { name: string; data: unknown }[] = [];
    const prisma = makeFakePrisma({
      quiz: baseQuiz({ passThreshold: 80 }),
      questions: [{ id: 'q-open', tenantId: 't1', quizId: 'q1', points: 10, deletedAt: null }],
      attempt: baseAttempt({ scoreEarned: 0, scoreMax: 10 }),
      answers: [
        {
          id: 'a-open',
          tenantId: 't1',
          attemptId: 'attempt-1',
          questionId: 'q-open',
          scoreEarned: 0,
          isCorrect: false,
          gradedFeedback: null,
        },
      ],
    });
    const svc = new AssessmentsService(prisma as never, trackingCtx(events));

    const result = await svc.gradeAttempt('t1', 'admin', 'attempt-1', {
      grades: [{ questionId: 'q-open', scoreEarned: 5 }],
    });

    expect(result.passed).toBe(false);
    expect(result.scorePercent).toBe(50);
    const eventNames = events.map((e) => e.name);
    expect(eventNames).toContain('assessments.attempt.failed');
    expect(eventNames).not.toContain('assessments.attempt.passed');
  });

  it('payload del evento graded incluye actor (formadorId), evento passed/failed lo emite a userId del alumno', async () => {
    const events: { name: string; data: unknown; metadata: { userId?: string } }[] = [];
    const prisma = makeFakePrisma({
      quiz: baseQuiz({ passThreshold: 60 }),
      questions: [{ id: 'q-open', tenantId: 't1', quizId: 'q1', points: 10, deletedAt: null }],
      attempt: baseAttempt({ userId: 'alumno-1', scoreEarned: 0, scoreMax: 10 }),
      answers: [
        {
          id: 'a-open',
          tenantId: 't1',
          attemptId: 'attempt-1',
          questionId: 'q-open',
          scoreEarned: 0,
          isCorrect: false,
          gradedFeedback: null,
        },
      ],
    });
    const ctx = {
      eventBus: {
        publish: async (e: { name: string; data: unknown; metadata: { userId?: string } }) => {
          events.push(e);
        },
      },
    } as never;
    const svc = new AssessmentsService(prisma as never, ctx);

    await svc.gradeAttempt('t1', 'formador-1', 'attempt-1', {
      grades: [{ questionId: 'q-open', scoreEarned: 8 }],
    });

    const graded = events.find((e) => e.name === 'assessments.attempt.graded');
    expect(graded?.metadata.userId).toBe('formador-1');

    const passed = events.find((e) => e.name === 'assessments.attempt.passed');
    expect(passed?.metadata.userId).toBe('alumno-1');
  });

  it('grades para preguntas auto-corregidas se ignoran silenciosamente (no rompen)', async () => {
    const prisma = makeFakePrisma({
      quiz: baseQuiz({ passThreshold: 50 }),
      questions: [
        { id: 'q-sc', tenantId: 't1', quizId: 'q1', points: 1, deletedAt: null },
        { id: 'q-open', tenantId: 't1', quizId: 'q1', points: 10, deletedAt: null },
      ],
      attempt: baseAttempt({ scoreEarned: 1, scoreMax: 11 }),
      answers: [
        {
          id: 'a-sc',
          tenantId: 't1',
          attemptId: 'attempt-1',
          questionId: 'q-sc',
          scoreEarned: 1,
          isCorrect: true,
          gradedFeedback: null,
        },
        {
          id: 'a-open',
          tenantId: 't1',
          attemptId: 'attempt-1',
          questionId: 'q-open',
          scoreEarned: 0,
          isCorrect: false,
          gradedFeedback: null,
        },
      ],
    });
    const svc = new AssessmentsService(prisma as never, trackingCtx([]));

    // Mandamos grade para la SC también (no debería romper, pero validamos
    // que se respeta el max de la pregunta)
    const result = await svc.gradeAttempt('t1', 'admin', 'attempt-1', {
      grades: [
        { questionId: 'q-sc', scoreEarned: 1 },
        { questionId: 'q-open', scoreEarned: 5 },
      ],
    });

    expect(result.status).toBe('GRADED');
    expect(result.scoreEarned).toBe(6); // 1 (sc, sin cambio) + 5 (open)
  });
});
