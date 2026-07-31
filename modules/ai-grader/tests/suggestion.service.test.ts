import { describe, expect, it, vi } from 'vitest';
import { AiGraderSuggestionService, type ChatFn } from '../src/suggestion.service.js';
import {
  AttemptNotPendingReviewError,
  GraderProviderError,
  GraderResponseParseError,
  SuggestionNotFoundError,
} from '../src/errors.js';

function makeContext() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    eventBus: { publish: vi.fn() },
  } as never;
}

interface Scenario {
  attempt: { id: string; status: string } | null;
  answers: Array<{ id: string; questionId: string; textAnswer: string | null }>;
  questions: Array<{ id: string; type: string; prompt: string; points: number }>;
  rubrics?: Record<
    string,
    { id: string; instructions: string; criteria: unknown; enabled: boolean }
  >;
  existingSuggestions?: Record<string, unknown>;
}

function makePrisma(s: Scenario) {
  const upsertedSuggestions: unknown[] = [];
  const prisma = {
    modAssessmentsAttempt: {
      findFirst: vi.fn(async () => s.attempt),
    },
    modAssessmentsAnswer: {
      findMany: vi.fn(async () => s.answers),
    },
    modAssessmentsQuestion: {
      findMany: vi.fn(async () => s.questions),
    },
    modAiGraderRubric: {
      findFirst: vi.fn(
        async ({ where }: { where: { questionId: string } }) =>
          s.rubrics?.[where.questionId] ?? null,
      ),
    },
    modAiGraderSuggestion: {
      findFirst: vi.fn(
        async ({ where }: { where: { answerId: string } }) =>
          s.existingSuggestions?.[where.answerId] ?? null,
      ),
      findMany: vi.fn(async () => Object.values(s.existingSuggestions ?? {})),
      upsert: vi.fn(async (arg: { create: Record<string, unknown> }) => {
        const row = {
          id: `sugg-${arg.create.answerId as string}`,
          ...arg.create,
          applied: false,
          createdAt: new Date('2026-04-29T00:00:00Z'),
        };
        upsertedSuggestions.push(row);
        return row;
      }),
      update: vi.fn(async (arg: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: arg.where.id,
        tenantId: 'tenant-A',
        attemptId: 'att-1',
        answerId: 'a1',
        questionId: 'q1',
        proposedScore: 8,
        perCriterion: [],
        overallFeedback: 'fb',
        provider: 'openai',
        model: 'gpt-4o',
        applied: arg.data.applied as boolean,
        appliedById: arg.data.appliedById as string | null,
        appliedAt: arg.data.appliedAt as Date | null,
        createdAt: new Date('2026-04-29T00:00:00Z'),
      })),
    },
  } as never;
  return { prisma, upsertedSuggestions };
}

const validJsonResponse = JSON.stringify({
  perCriterion: [
    { name: 'Claridad', score: 4, justification: 'ok' },
    { name: 'Profundidad', score: 5, justification: 'ok' },
  ],
  overallFeedback: 'Buena respuesta.',
});

const validRubric = {
  id: 'r1',
  instructions: 'Esperamos definición + ejemplo.',
  criteria: [
    { name: 'Claridad', description: 'd1', weight: 4 },
    { name: 'Profundidad', description: 'd2', weight: 6 },
  ],
  enabled: true,
};

function makeChat(content = validJsonResponse): ChatFn {
  return vi.fn(async () => ({
    content,
    inputTokens: 100,
    outputTokens: 50,
    provider: 'openai',
    model: 'gpt-4o',
  }));
}

describe('AiGraderSuggestionService.suggestForAttempt', () => {
  it('lanza si el attempt no existe', async () => {
    const { prisma } = makePrisma({ attempt: null, answers: [], questions: [] });
    const svc = new AiGraderSuggestionService(prisma, makeContext(), makeChat());
    await expect(svc.suggestForAttempt('tenant-A', 'att-missing', {})).rejects.toBeInstanceOf(
      AttemptNotPendingReviewError,
    );
  });

  it('lanza si el attempt no está PENDING_REVIEW', async () => {
    const { prisma } = makePrisma({
      attempt: { id: 'att-1', status: 'IN_PROGRESS' },
      answers: [],
      questions: [],
    });
    const svc = new AiGraderSuggestionService(prisma, makeContext(), makeChat());
    await expect(svc.suggestForAttempt('tenant-A', 'att-1', {})).rejects.toBeInstanceOf(
      AttemptNotPendingReviewError,
    );
  });

  it('omite preguntas auto-corregibles sin invocar el modelo', async () => {
    const chat = makeChat();
    const { prisma } = makePrisma({
      attempt: { id: 'att-1', status: 'PENDING_REVIEW' },
      answers: [{ id: 'a1', questionId: 'q1', textAnswer: 'A' }],
      questions: [{ id: 'q1', type: 'SINGLE_CHOICE', prompt: '?', points: 1 }],
    });
    const svc = new AiGraderSuggestionService(prisma, makeContext(), chat);
    const r = await svc.suggestForAttempt('tenant-A', 'att-1', {});
    expect(r.generated).toHaveLength(0);
    expect(r.skipped).toHaveLength(0); // auto-corregible: ni siquiera se reporta
    expect(chat).not.toHaveBeenCalled();
  });

  it('skip con motivo si la pregunta no tiene rúbrica', async () => {
    const chat = makeChat();
    const { prisma } = makePrisma({
      attempt: { id: 'att-1', status: 'PENDING_REVIEW' },
      answers: [{ id: 'a1', questionId: 'q1', textAnswer: 'r' }],
      questions: [{ id: 'q1', type: 'SHORT_ANSWER', prompt: 'p', points: 10 }],
      // sin rubrics
    });
    const svc = new AiGraderSuggestionService(prisma, makeContext(), chat);
    const r = await svc.suggestForAttempt('tenant-A', 'att-1', {});
    expect(r.skipped).toEqual([{ questionId: 'q1', reason: 'sin rúbrica configurada' }]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('skip si la rúbrica está deshabilitada', async () => {
    const chat = makeChat();
    const { prisma } = makePrisma({
      attempt: { id: 'att-1', status: 'PENDING_REVIEW' },
      answers: [{ id: 'a1', questionId: 'q1', textAnswer: 'r' }],
      questions: [{ id: 'q1', type: 'SHORT_ANSWER', prompt: 'p', points: 10 }],
      rubrics: { q1: { ...validRubric, enabled: false } },
    });
    const svc = new AiGraderSuggestionService(prisma, makeContext(), chat);
    const r = await svc.suggestForAttempt('tenant-A', 'att-1', {});
    expect(r.skipped).toEqual([{ questionId: 'q1', reason: 'rúbrica deshabilitada' }]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('genera sugerencia válida y persiste vía upsert', async () => {
    const chat = makeChat();
    const { prisma, upsertedSuggestions } = makePrisma({
      attempt: { id: 'att-1', status: 'PENDING_REVIEW' },
      answers: [{ id: 'a1', questionId: 'q1', textAnswer: 'mi respuesta' }],
      questions: [{ id: 'q1', type: 'SHORT_ANSWER', prompt: '?', points: 10 }],
      rubrics: { q1: validRubric },
    });
    const svc = new AiGraderSuggestionService(prisma, makeContext(), chat);
    const r = await svc.suggestForAttempt('tenant-A', 'att-1', {});
    expect(r.generated).toHaveLength(1);
    expect(r.generated[0]?.proposedScore).toBe(9);
    expect(r.tokensUsed).toEqual({ input: 100, output: 50 });
    expect(upsertedSuggestions).toHaveLength(1);
  });

  it('reusa sugerencia persistida si force=false', async () => {
    const chat = makeChat();
    const { prisma } = makePrisma({
      attempt: { id: 'att-1', status: 'PENDING_REVIEW' },
      answers: [{ id: 'a1', questionId: 'q1', textAnswer: 'r' }],
      questions: [{ id: 'q1', type: 'SHORT_ANSWER', prompt: 'p', points: 10 }],
      rubrics: { q1: validRubric },
      existingSuggestions: {
        a1: {
          id: 'sugg-cached',
          attemptId: 'att-1',
          answerId: 'a1',
          questionId: 'q1',
          proposedScore: 7,
          perCriterion: [],
          overallFeedback: 'cached',
          provider: 'openai',
          model: 'gpt-4o',
          applied: false,
          createdAt: new Date('2026-04-29T00:00:00Z'),
        },
      },
    });
    const svc = new AiGraderSuggestionService(prisma, makeContext(), chat);
    const r = await svc.suggestForAttempt('tenant-A', 'att-1', {});
    expect(chat).not.toHaveBeenCalled();
    expect(r.generated[0]?.id).toBe('sugg-cached');
  });

  it('regenera si force=true (ignora suggestion previa)', async () => {
    const chat = makeChat();
    const { prisma } = makePrisma({
      attempt: { id: 'att-1', status: 'PENDING_REVIEW' },
      answers: [{ id: 'a1', questionId: 'q1', textAnswer: 'r' }],
      questions: [{ id: 'q1', type: 'SHORT_ANSWER', prompt: 'p', points: 10 }],
      rubrics: { q1: validRubric },
      existingSuggestions: {
        a1: { id: 'cached', proposedScore: 1 },
      },
    });
    const svc = new AiGraderSuggestionService(prisma, makeContext(), chat);
    const r = await svc.suggestForAttempt('tenant-A', 'att-1', { force: true });
    expect(chat).toHaveBeenCalled();
    expect(r.generated[0]?.proposedScore).toBe(9); // del nuevo, no del cache
  });

  it('envuelve fallos del chatFn en GraderProviderError', async () => {
    const chat = vi.fn(async () => {
      throw new Error('upstream 500');
    }) as unknown as ChatFn;
    const { prisma } = makePrisma({
      attempt: { id: 'att-1', status: 'PENDING_REVIEW' },
      answers: [{ id: 'a1', questionId: 'q1', textAnswer: 'r' }],
      questions: [{ id: 'q1', type: 'SHORT_ANSWER', prompt: 'p', points: 10 }],
      rubrics: { q1: validRubric },
    });
    const svc = new AiGraderSuggestionService(prisma, makeContext(), chat);
    await expect(svc.suggestForAttempt('tenant-A', 'att-1', {})).rejects.toBeInstanceOf(
      GraderProviderError,
    );
  });

  it('lanza GraderResponseParseError si la respuesta no parsea', async () => {
    const chat = makeChat('Lo siento, no puedo ayudar.');
    const { prisma } = makePrisma({
      attempt: { id: 'att-1', status: 'PENDING_REVIEW' },
      answers: [{ id: 'a1', questionId: 'q1', textAnswer: 'r' }],
      questions: [{ id: 'q1', type: 'SHORT_ANSWER', prompt: 'p', points: 10 }],
      rubrics: { q1: validRubric },
    });
    const svc = new AiGraderSuggestionService(prisma, makeContext(), chat);
    await expect(svc.suggestForAttempt('tenant-A', 'att-1', {})).rejects.toBeInstanceOf(
      GraderResponseParseError,
    );
  });

  it('cuenta tokens acumulados para múltiples answers', async () => {
    const chat = makeChat();
    const { prisma } = makePrisma({
      attempt: { id: 'att-1', status: 'PENDING_REVIEW' },
      answers: [
        { id: 'a1', questionId: 'q1', textAnswer: 'r1' },
        { id: 'a2', questionId: 'q2', textAnswer: 'r2' },
      ],
      questions: [
        { id: 'q1', type: 'SHORT_ANSWER', prompt: 'p1', points: 10 },
        { id: 'q2', type: 'LONG_ANSWER', prompt: 'p2', points: 10 },
      ],
      rubrics: { q1: validRubric, q2: validRubric },
    });
    const svc = new AiGraderSuggestionService(prisma, makeContext(), chat);
    const r = await svc.suggestForAttempt('tenant-A', 'att-1', {});
    expect(r.generated).toHaveLength(2);
    expect(r.tokensUsed).toEqual({ input: 200, output: 100 });
    expect(chat).toHaveBeenCalledTimes(2);
  });
});

describe('AiGraderSuggestionService.markApplied', () => {
  it('rechaza si la sugerencia no pertenece al tenant', async () => {
    const prisma = {
      modAiGraderSuggestion: { findFirst: vi.fn(async () => null) },
    } as never;
    const svc = new AiGraderSuggestionService(prisma, makeContext(), makeChat());
    await expect(svc.markApplied('tenant-A', 'sugg-leak', 'user-1')).rejects.toBeInstanceOf(
      SuggestionNotFoundError,
    );
  });

  it('marca como aplicada con auditoría de userId + timestamp', async () => {
    const update = vi.fn(async () => ({
      id: 'sugg-1',
      tenantId: 'tenant-A',
      attemptId: 'att-1',
      answerId: 'a1',
      questionId: 'q1',
      proposedScore: 8,
      perCriterion: [],
      overallFeedback: 'fb',
      provider: 'openai',
      model: 'gpt-4o',
      applied: true,
      appliedById: 'user-1',
      appliedAt: new Date('2026-04-29T00:00:00Z'),
      createdAt: new Date('2026-04-29T00:00:00Z'),
    }));
    const prisma = {
      modAiGraderSuggestion: {
        findFirst: vi.fn(async () => ({ id: 'sugg-1' })),
        update,
      },
    } as never;
    const svc = new AiGraderSuggestionService(prisma, makeContext(), makeChat());
    const r = await svc.markApplied('tenant-A', 'sugg-1', 'user-1');
    expect(r.applied).toBe(true);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ applied: true, appliedById: 'user-1' }),
      }),
    );
  });
});
