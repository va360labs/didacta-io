import { describe, expect, it, vi } from 'vitest';
import { AiGraderRubricService } from '../src/rubric.service.js';
import {
  QuestionNotGradableError,
  RubricInvalidError,
  RubricNotFoundError,
} from '../src/errors.js';

function makeContext() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    eventBus: { publish: vi.fn() },
  } as never;
}

function makePrisma(opts: {
  question?: { id: string; type: string; points: number } | null;
  existingRubric?: { id: string } | null;
}) {
  const findQuestion = vi.fn(async () => opts.question ?? null);
  const findRubric = vi.fn(async (_q: { where: Record<string, unknown> }) => null as unknown);
  const findRubricFirst = vi.fn(
    async (_q: { where: Record<string, unknown> }) => opts.existingRubric ?? null,
  );
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'new-rubric-id',
    questionId: data.questionId,
    instructions: data.instructions,
    criteria: data.criteria,
    enabled: data.enabled,
    createdAt: new Date('2026-04-29T00:00:00Z'),
    updatedAt: new Date('2026-04-29T00:00:00Z'),
  }));
  const update = vi.fn(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      questionId: 'q1',
      instructions: data.instructions,
      criteria: data.criteria,
      enabled: data.enabled,
      createdAt: new Date('2026-04-29T00:00:00Z'),
      updatedAt: new Date('2026-04-29T00:00:00Z'),
    }),
  );
  const deleteMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    modAssessmentsQuestion: { findFirst: findQuestion },
    modAiGraderRubric: {
      findFirst: vi.fn(async (q: { where: Record<string, unknown> }) => {
        // Compatibilidad: get usa findFirst con tenant+question; upsert usa
        // findFirst con select.id. Distinguimos por presencia de `select`.
        if ('select' in q) return findRubricFirst(q);
        return findRubric(q);
      }),
      create,
      update,
      deleteMany,
    },
  } as never;
  return {
    prisma,
    spies: { findQuestion, findRubric, findRubricFirst, create, update, deleteMany },
  };
}

const validDto = {
  instructions: 'Esperamos definición + ejemplo concreto.',
  criteria: [
    { name: 'Definición', description: 'Define el concepto', weight: 6 },
    { name: 'Ejemplo', description: 'Da un ejemplo', weight: 4 },
  ],
};

describe('AiGraderRubricService.upsert', () => {
  it('crea rúbrica nueva si no existe (Σweights = points)', async () => {
    const { prisma, spies } = makePrisma({
      question: { id: 'q1', type: 'SHORT_ANSWER', points: 10 },
    });
    const svc = new AiGraderRubricService(prisma, makeContext());
    const r = await svc.upsert('tenant-A', 'q1', validDto);
    expect(spies.create).toHaveBeenCalled();
    expect(r.questionId).toBe('q1');
    expect(r.criteria).toHaveLength(2);
  });

  it('actualiza si ya existe', async () => {
    const { prisma, spies } = makePrisma({
      question: { id: 'q1', type: 'LONG_ANSWER', points: 10 },
      existingRubric: { id: 'existing-id' },
    });
    const svc = new AiGraderRubricService(prisma, makeContext());
    await svc.upsert('tenant-A', 'q1', validDto);
    expect(spies.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'existing-id' } }),
    );
    expect(spies.create).not.toHaveBeenCalled();
  });

  it('lanza si la pregunta no existe en el tenant', async () => {
    const { prisma } = makePrisma({ question: null });
    const svc = new AiGraderRubricService(prisma, makeContext());
    await expect(svc.upsert('tenant-A', 'q-missing', validDto)).rejects.toBeInstanceOf(
      RubricInvalidError,
    );
  });

  it('lanza si la pregunta no es SHORT/LONG_ANSWER', async () => {
    const { prisma } = makePrisma({
      question: { id: 'q1', type: 'SINGLE_CHOICE', points: 10 },
    });
    const svc = new AiGraderRubricService(prisma, makeContext());
    await expect(svc.upsert('tenant-A', 'q1', validDto)).rejects.toBeInstanceOf(
      QuestionNotGradableError,
    );
  });

  it('lanza si Σweights ≠ question.points', async () => {
    const { prisma } = makePrisma({
      question: { id: 'q1', type: 'SHORT_ANSWER', points: 8 }, // Σ válido = 10
    });
    const svc = new AiGraderRubricService(prisma, makeContext());
    await expect(svc.upsert('tenant-A', 'q1', validDto)).rejects.toBeInstanceOf(RubricInvalidError);
  });

  it('rechaza Zod si los criterios duplican nombre', async () => {
    const { prisma } = makePrisma({
      question: { id: 'q1', type: 'SHORT_ANSWER', points: 10 },
    });
    const svc = new AiGraderRubricService(prisma, makeContext());
    const dup = {
      instructions: 'x'.repeat(20),
      criteria: [
        { name: 'Claridad', description: 'desc1', weight: 5 },
        { name: 'CLARIDAD', description: 'desc2', weight: 5 },
      ],
    };
    await expect(svc.upsert('tenant-A', 'q1', dup)).rejects.toThrow();
  });
});

describe('AiGraderRubricService.require', () => {
  it('lanza RubricNotFoundError si no hay rúbrica', async () => {
    const { prisma } = makePrisma({});
    const svc = new AiGraderRubricService(prisma, makeContext());
    await expect(svc.require('tenant-A', 'q1')).rejects.toBeInstanceOf(RubricNotFoundError);
  });
});

describe('AiGraderRubricService.remove', () => {
  it('borra solo del tenant del caller', async () => {
    const { prisma, spies } = makePrisma({});
    const svc = new AiGraderRubricService(prisma, makeContext());
    await svc.remove('tenant-Z', 'q1');
    expect(spies.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-Z', questionId: 'q1' },
    });
  });
});
