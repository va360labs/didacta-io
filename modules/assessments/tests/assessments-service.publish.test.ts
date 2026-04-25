import { describe, expect, it } from 'vitest';
import { AssessmentsService } from '../src/assessments.service.js';
import { QuizHasNoQuestionsError, QuizNotFoundError } from '../src/errors.js';

interface QuizRow {
  id: string;
  tenantId: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  publishedAt: Date | null;
  lessonId: string | null;
  deletedAt: Date | null;
}

function makeFakePrisma(
  opts: {
    quizzes?: QuizRow[];
    questionCount?: number;
  } = {},
) {
  const quizzes = opts.quizzes ?? [];
  const questionCount = opts.questionCount ?? 0;
  return {
    modAssessmentsQuiz: {
      async findFirst(args: { where: { id: string; tenantId: string; deletedAt: null } }) {
        return (
          quizzes.find(
            (q) =>
              q.id === args.where.id && q.tenantId === args.where.tenantId && q.deletedAt === null,
          ) ?? null
        );
      },
      async update(args: { where: { id: string }; data: Partial<QuizRow> }) {
        const existing = quizzes.find((q) => q.id === args.where.id);
        if (!existing) throw new Error('not found');
        Object.assign(existing, args.data);
        return existing;
      },
    },
    modAssessmentsQuestion: {
      async count() {
        return questionCount;
      },
    },
  };
}

const ctx = {
  eventBus: {
    publish: async () => {},
  },
} as never;

describe('AssessmentsService.publishQuiz', () => {
  it('error si el quiz no existe (o pertenece a otro tenant)', async () => {
    const prisma = makeFakePrisma({ quizzes: [] });
    const svc = new AssessmentsService(prisma as never, ctx);

    await expect(svc.publishQuiz('t1', 'u1', 'no-existe')).rejects.toBeInstanceOf(
      QuizNotFoundError,
    );
  });

  it('error si el quiz no tiene preguntas', async () => {
    const quiz: QuizRow = {
      id: 'q1',
      tenantId: 't1',
      status: 'DRAFT',
      publishedAt: null,
      lessonId: null,
      deletedAt: null,
    };
    const prisma = makeFakePrisma({ quizzes: [quiz], questionCount: 0 });
    const svc = new AssessmentsService(prisma as never, ctx);

    await expect(svc.publishQuiz('t1', 'u1', 'q1')).rejects.toBeInstanceOf(QuizHasNoQuestionsError);
    expect(quiz.status).toBe('DRAFT');
  });

  it('publica si tiene al menos 1 pregunta y rellena publishedAt', async () => {
    const quiz: QuizRow = {
      id: 'q1',
      tenantId: 't1',
      status: 'DRAFT',
      publishedAt: null,
      lessonId: 'lesson-1',
      deletedAt: null,
    };
    const prisma = makeFakePrisma({ quizzes: [quiz], questionCount: 3 });
    const svc = new AssessmentsService(prisma as never, ctx);

    const result = await svc.publishQuiz('t1', 'u1', 'q1');
    expect(result.status).toBe('PUBLISHED');
    expect(result.publishedAt).toBeInstanceOf(Date);
  });

  it('al republicar, conserva el publishedAt original', async () => {
    const original = new Date('2026-01-01T00:00:00Z');
    const quiz: QuizRow = {
      id: 'q1',
      tenantId: 't1',
      status: 'PUBLISHED',
      publishedAt: original,
      lessonId: null,
      deletedAt: null,
    };
    const prisma = makeFakePrisma({ quizzes: [quiz], questionCount: 1 });
    const svc = new AssessmentsService(prisma as never, ctx);

    const result = await svc.publishQuiz('t1', 'u1', 'q1');
    expect(result.publishedAt).toEqual(original);
  });

  it('emite evento assessments.quiz.published', async () => {
    const quiz: QuizRow = {
      id: 'q1',
      tenantId: 't1',
      status: 'DRAFT',
      publishedAt: null,
      lessonId: 'lesson-1',
      deletedAt: null,
    };
    const prisma = makeFakePrisma({ quizzes: [quiz], questionCount: 1 });
    const events: { name: string; data: unknown }[] = [];
    const trackingCtx = {
      eventBus: {
        publish: async (e: { name: string; data: unknown }) => {
          events.push(e);
        },
      },
    } as never;
    const svc = new AssessmentsService(prisma as never, trackingCtx);

    await svc.publishQuiz('t1', 'u1', 'q1');
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('assessments.quiz.published');
    expect(events[0]?.data).toMatchObject({ quizId: 'q1', lessonId: 'lesson-1' });
  });
});
