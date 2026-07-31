/**
 * Tests unit del AiContentService — sin red, sin DB real.
 *
 * Cobertura priorizada:
 *  1. generate(SUMMARY): el chatFn devuelve JSON válido, se guarda draft DRAFT.
 *  2. generate(FLASHCARDS): valida shape (>=1 card, front/back strings).
 *  3. generate(QUIZ): valida shape (>=1 question con prompt+answer).
 *  4. Lección con texto vacío → LessonTextEmptyError.
 *  5. JSON inválido del modelo → InvalidContentJsonError.
 *  6. Provider lanza → AiContentProviderError envuelto.
 *  7. publish + reject solo desde estado DRAFT (idempotencia de transición).
 *  8. updateContent revalida shape antes de persistir.
 *  9. parseModelJson con code fences ```json...```.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AiContentService,
  type ChatFn,
  type DraftEventPublisher,
  type LessonTextResolver,
} from '../src/ai-content.service.js';
import {
  AiContentProviderError,
  DraftNotInDraftStateError,
  InvalidContentJsonError,
  LessonTextEmptyError,
} from '../src/errors.js';
import { parseModelJson } from '../src/json-parser.js';

interface DraftRow {
  id: string;
  tenantId: string;
  lessonId: string;
  courseId: string;
  requestedBy: string;
  type: 'SUMMARY' | 'FLASHCARDS' | 'QUIZ';
  status: 'DRAFT' | 'PUBLISHED' | 'REJECTED';
  content: unknown;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  rejectReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

class MockPrisma {
  drafts = new Map<string, DraftRow>();
  modAiContentDraft = {
    findFirst: async (args: { where: { id: string; tenantId: string } }) => {
      const row = this.drafts.get(args.where.id);
      if (!row || row.tenantId !== args.where.tenantId) return null;
      return row;
    },
    findMany: async (args: {
      where: { tenantId: string; lessonId?: string; courseId?: string; status?: string };
    }) => {
      return [...this.drafts.values()].filter((d) => {
        if (d.tenantId !== args.where.tenantId) return false;
        if (args.where.lessonId && d.lessonId !== args.where.lessonId) return false;
        if (args.where.courseId && d.courseId !== args.where.courseId) return false;
        if (args.where.status && d.status !== args.where.status) return false;
        return true;
      });
    },
    create: async (args: { data: Omit<DraftRow, 'id' | 'createdAt' | 'updatedAt'> }) => {
      const id = `draft-${this.drafts.size + 1}`;
      const row: DraftRow = {
        id,
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as DraftRow;
      this.drafts.set(id, row);
      return row;
    },
    update: async (args: { where: { id: string }; data: Partial<DraftRow> }) => {
      const row = this.drafts.get(args.where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, args.data, { updatedAt: new Date() });
      return row;
    },
  };
}

class MockResolver implements LessonTextResolver {
  texts = new Map<string, { text: string; title?: string }>();
  async resolve(args: { tenantId: string; lessonId: string }) {
    return this.texts.get(args.lessonId) ?? null;
  }
}

class MockPublisher implements DraftEventPublisher {
  events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  async publish(_t: string, _a: string | null, name: string, payload: Record<string, unknown>) {
    this.events.push({ name, payload });
  }
}

function makeChat(content: string): ChatFn {
  return async () => ({
    content,
    inputTokens: 100,
    outputTokens: 50,
    provider: 'mock',
    model: 'mock-1',
  });
}

const SAMPLE_LESSON_TEXT =
  'Esta lección explica los conceptos básicos de la programación funcional: funciones puras, inmutabilidad y composición. ' +
  'Una función pura no tiene side effects y siempre devuelve el mismo output para el mismo input. La inmutabilidad evita ' +
  'mutar datos compartidos. La composición permite construir programas combinando funciones pequeñas.';

// ---------- Tests ----------

describe('parseModelJson', () => {
  it('extrae JSON puro', () => {
    expect(parseModelJson('{"text":"hola"}', 'SUMMARY')).toEqual({ text: 'hola' });
  });
  it('extrae JSON dentro de ```json fence', () => {
    const raw = 'Aquí tienes:\n```json\n{"text":"hola"}\n```\nFin';
    expect(parseModelJson(raw, 'SUMMARY')).toEqual({ text: 'hola' });
  });
  it('extrae JSON dentro de fence sin language tag', () => {
    const raw = '```\n{"text":"hola"}\n```';
    expect(parseModelJson(raw, 'SUMMARY')).toEqual({ text: 'hola' });
  });
  it('extrae primer objeto si la respuesta tiene texto suelto', () => {
    const raw = 'Resultado: {"text":"hola"} listo.';
    expect(parseModelJson(raw, 'SUMMARY')).toEqual({ text: 'hola' });
  });
  it('lanza si no hay JSON', () => {
    expect(() => parseModelJson('sin nada útil', 'SUMMARY')).toThrow(InvalidContentJsonError);
  });
});

describe('AiContentService — generate', () => {
  let prisma: MockPrisma;
  let resolver: MockResolver;
  let publisher: MockPublisher;

  beforeEach(() => {
    prisma = new MockPrisma();
    resolver = new MockResolver();
    publisher = new MockPublisher();
    resolver.texts.set('lesson-1', { text: SAMPLE_LESSON_TEXT, title: 'Programación funcional' });
  });

  it('SUMMARY: persiste draft DRAFT, emite generated', async () => {
    const chat = makeChat(
      JSON.stringify({ text: 'Resumen ejemplo de unas 30 palabras suficiente.' }),
    );
    const svc = new AiContentService(prisma as unknown as never, chat, resolver, publisher);

    const draft = await svc.generate({
      tenantId: 't1',
      requestedBy: 'u1',
      lessonId: 'lesson-1',
      courseId: 'course-1',
      type: 'SUMMARY',
    });

    expect(draft.status).toBe('DRAFT');
    expect(draft.type).toBe('SUMMARY');
    expect((draft.content as { text: string }).text).toContain('Resumen');
    expect(draft.inputTokens).toBe(100);
    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0].name).toBe('ai-content.draft.generated');
  });

  it('FLASHCARDS: valida shape (cards array no vacío, front/back strings)', async () => {
    const chat = makeChat(
      JSON.stringify({
        cards: [
          { front: '¿Qué es función pura?', back: 'Sin side effects, mismo input = mismo output.' },
          { front: 'Inmutabilidad', back: 'No mutar datos compartidos.' },
        ],
      }),
    );
    const svc = new AiContentService(prisma as unknown as never, chat, resolver, publisher);

    const draft = await svc.generate({
      tenantId: 't1',
      requestedBy: 'u1',
      lessonId: 'lesson-1',
      courseId: 'course-1',
      type: 'FLASHCARDS',
    });

    expect((draft.content as { cards: unknown[] }).cards).toHaveLength(2);
  });

  it('QUIZ: valida shape (questions con prompt+answer)', async () => {
    const chat = makeChat(
      JSON.stringify({
        questions: [
          {
            prompt: '¿Qué caracteriza a una función pura?',
            options: ['Side effects', 'Output determinista', 'Mutación', 'Async'],
            answer: 'Output determinista',
            explanation: 'Mismo input → mismo output, sin side effects.',
          },
        ],
      }),
    );
    const svc = new AiContentService(prisma as unknown as never, chat, resolver, publisher);

    const draft = await svc.generate({
      tenantId: 't1',
      requestedBy: 'u1',
      lessonId: 'lesson-1',
      courseId: 'course-1',
      type: 'QUIZ',
    });

    expect((draft.content as { questions: unknown[] }).questions).toHaveLength(1);
  });

  it('lanza si la lección no tiene texto', async () => {
    resolver.texts.set('lesson-empty', { text: '   ', title: 'Vacía' });
    const chat = makeChat('{"text":"x"}');
    const svc = new AiContentService(prisma as unknown as never, chat, resolver, publisher);

    await expect(
      svc.generate({
        tenantId: 't1',
        requestedBy: 'u1',
        lessonId: 'lesson-empty',
        courseId: 'course-1',
        type: 'SUMMARY',
      }),
    ).rejects.toBeInstanceOf(LessonTextEmptyError);
  });

  it('lanza AiContentProviderError si el chat falla', async () => {
    const chat: ChatFn = async () => {
      throw new Error('rate limited');
    };
    const svc = new AiContentService(prisma as unknown as never, chat, resolver, publisher);

    await expect(
      svc.generate({
        tenantId: 't1',
        requestedBy: 'u1',
        lessonId: 'lesson-1',
        courseId: 'course-1',
        type: 'SUMMARY',
      }),
    ).rejects.toBeInstanceOf(AiContentProviderError);
  });

  it('lanza InvalidContentJsonError si el modelo devuelve shape mal', async () => {
    const chat = makeChat(JSON.stringify({ wrong: 'shape' }));
    const svc = new AiContentService(prisma as unknown as never, chat, resolver, publisher);

    await expect(
      svc.generate({
        tenantId: 't1',
        requestedBy: 'u1',
        lessonId: 'lesson-1',
        courseId: 'course-1',
        type: 'SUMMARY',
      }),
    ).rejects.toBeInstanceOf(InvalidContentJsonError);
  });
});

describe('AiContentService — transiciones', () => {
  let prisma: MockPrisma;
  let resolver: MockResolver;
  let publisher: MockPublisher;
  let svc: AiContentService;

  beforeEach(async () => {
    prisma = new MockPrisma();
    resolver = new MockResolver();
    publisher = new MockPublisher();
    resolver.texts.set('lesson-1', { text: SAMPLE_LESSON_TEXT });
    const chat = makeChat(JSON.stringify({ text: 'Resumen suficientemente largo para test.' }));
    svc = new AiContentService(prisma as unknown as never, chat, resolver, publisher);
  });

  async function makeDraft() {
    return svc.generate({
      tenantId: 't1',
      requestedBy: 'u1',
      lessonId: 'lesson-1',
      courseId: 'course-1',
      type: 'SUMMARY',
    });
  }

  it('publish desde DRAFT marca PUBLISHED y emite evento', async () => {
    const draft = await makeDraft();
    publisher.events = [];
    const updated = await svc.publish('t1', 'reviewer', draft.id);
    expect(updated.status).toBe('PUBLISHED');
    expect(updated.reviewedBy).toBe('reviewer');
    expect(publisher.events).toHaveLength(1);
    expect(publisher.events[0].name).toBe('ai-content.draft.published');
  });

  it('publish desde PUBLISHED lanza DraftNotInDraftStateError', async () => {
    const draft = await makeDraft();
    await svc.publish('t1', 'reviewer', draft.id);
    await expect(svc.publish('t1', 'reviewer', draft.id)).rejects.toBeInstanceOf(
      DraftNotInDraftStateError,
    );
  });

  it('reject con razón guarda rejectReason y emite evento', async () => {
    const draft = await makeDraft();
    publisher.events = [];
    const updated = await svc.reject('t1', 'reviewer', draft.id, 'No es preciso');
    expect(updated.status).toBe('REJECTED');
    expect(updated.rejectReason).toBe('No es preciso');
    expect(publisher.events[0].name).toBe('ai-content.draft.rejected');
  });

  it('updateContent en DRAFT: revalida shape', async () => {
    const draft = await makeDraft();
    const updated = await svc.updateContent({
      tenantId: 't1',
      draftId: draft.id,
      type: 'SUMMARY',
      content: { text: 'Versión editada del resumen para que cumpla longitud mínima.' },
    });
    expect((updated.content as { text: string }).text).toContain('editada');
  });

  it('updateContent con shape mal lanza InvalidContentJsonError', async () => {
    const draft = await makeDraft();
    await expect(
      svc.updateContent({
        tenantId: 't1',
        draftId: draft.id,
        type: 'SUMMARY',
        content: { text: 'corto' },
      }),
    ).rejects.toBeInstanceOf(InvalidContentJsonError);
  });

  it('updateContent en PUBLISHED lanza DraftNotInDraftStateError', async () => {
    const draft = await makeDraft();
    await svc.publish('t1', 'reviewer', draft.id);
    await expect(
      svc.updateContent({
        tenantId: 't1',
        draftId: draft.id,
        type: 'SUMMARY',
        content: { text: 'Texto suficientemente largo para superar validación de longitud.' },
      }),
    ).rejects.toBeInstanceOf(DraftNotInDraftStateError);
  });
});
