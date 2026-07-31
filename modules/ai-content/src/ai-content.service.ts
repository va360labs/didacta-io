/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * AiContentService — genera borradores y los gestiona por su ciclo de vida.
 *
 * Diseño:
 *  - Sin red propia: la integración con LLM se hace via `chatFn` inyectado
 *    (mismo patrón que `mod.ai-tutor` y `mod.ai-grader`). El AI Gateway del
 *    CORE resuelve el provider per-tenant y este service solo recibe el
 *    contrato `ChatFn`.
 *  - Idempotencia: la generación NO es idempotente (genera nuevo output cada
 *    vez). Lo idempotente es la transición de estado del draft (un draft solo
 *    se publica/rechaza una vez).
 *  - Tipos de draft: SUMMARY, FLASHCARDS, QUIZ. Cada uno tiene un prompt
 *    específico (`prompts.ts`) y un shape de JSON propio que validamos antes
 *    de persistir.
 */

import type { PrismaClient } from '@didacta/database';
import {
  AiContentProviderError,
  DraftNotFoundError,
  DraftNotInDraftStateError,
  InvalidContentJsonError,
  LessonTextEmptyError,
} from './errors.js';
import { parseModelJson } from './json-parser.js';
import { buildUserPrompt, SYSTEM_FLASHCARDS, SYSTEM_QUIZ, SYSTEM_SUMMARY } from './prompts.js';

export type DraftType = 'SUMMARY' | 'FLASHCARDS' | 'QUIZ';
export type DraftStatus = 'DRAFT' | 'PUBLISHED' | 'REJECTED';

export interface SummaryContent {
  text: string;
}
export interface FlashcardsContent {
  cards: Array<{ front: string; back: string }>;
}
export interface QuizContent {
  questions: Array<{
    prompt: string;
    options?: string[];
    answer: string;
    explanation?: string;
  }>;
}
export type DraftContent = SummaryContent | FlashcardsContent | QuizContent;

/**
 * Función inyectada que delega en el AI Gateway. Mismo shape que en mod.ai-tutor
 * para reutilizar el cableado del registry sin cambios.
 */
export interface ChatFn {
  (args: {
    tenantId: string;
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    maxTokens?: number;
  }): Promise<{
    content: string;
    inputTokens: number;
    outputTokens: number;
    provider?: string;
    model?: string;
  }>;
}

/**
 * Resolver del texto de la lección. Lo inyecta apps/api a partir de
 * mod.courses + mod.learning, evitando que mod.ai-content acople la DB
 * directamente a tablas de otros módulos (regla del contrato modular).
 */
export interface LessonTextResolver {
  resolve(args: {
    tenantId: string;
    lessonId: string;
  }): Promise<{ text: string; title?: string } | null>;
}

export interface DraftEventPublisher {
  publish(
    tenantId: string,
    actorId: string | null,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

export interface GenerateDraftInput {
  tenantId: string;
  requestedBy: string;
  lessonId: string;
  courseId: string;
  type: DraftType;
}

export interface UpdateDraftContentInput {
  tenantId: string;
  draftId: string;
  content: DraftContent;
  type: DraftType;
}

export interface ListDraftsFilter {
  tenantId: string;
  lessonId?: string;
  courseId?: string;
  status?: DraftStatus;
}

const EVENT = {
  GENERATED: 'ai-content.draft.generated',
  PUBLISHED: 'ai-content.draft.published',
  REJECTED: 'ai-content.draft.rejected',
} as const;

const MAX_TOKENS_BY_TYPE: Record<DraftType, number> = {
  SUMMARY: 600,
  FLASHCARDS: 1200,
  QUIZ: 1500,
};

export class AiContentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly chatFn: ChatFn,
    private readonly resolver: LessonTextResolver,
    private readonly publisher: DraftEventPublisher,
  ) {}

  // ---------------- generación ----------------

  async generate(input: GenerateDraftInput) {
    const lesson = await this.resolver.resolve({
      tenantId: input.tenantId,
      lessonId: input.lessonId,
    });
    if (!lesson || !lesson.text || lesson.text.trim().length < 40) {
      throw new LessonTextEmptyError(input.lessonId);
    }

    const system = pickSystemPrompt(input.type);
    const userMessage = buildUserPrompt(lesson.text, lesson.title);

    let chatResult;
    try {
      chatResult = await this.chatFn({
        tenantId: input.tenantId,
        system,
        messages: [{ role: 'user', content: userMessage }],
        maxTokens: MAX_TOKENS_BY_TYPE[input.type],
      });
    } catch (err) {
      throw new AiContentProviderError((err as Error).message);
    }

    const parsed = parseModelJson<DraftContent>(chatResult.content, input.type);
    validateContentShape(input.type, parsed);

    const draft = await this.prisma.modAiContentDraft.create({
      data: {
        tenantId: input.tenantId,
        lessonId: input.lessonId,
        courseId: input.courseId,
        requestedBy: input.requestedBy,
        type: input.type,
        status: 'DRAFT',
        content: parsed as never,
        provider: chatResult.provider ?? null,
        model: chatResult.model ?? null,
        inputTokens: chatResult.inputTokens,
        outputTokens: chatResult.outputTokens,
      },
    });

    await this.publisher.publish(input.tenantId, input.requestedBy, EVENT.GENERATED, {
      draftId: draft.id,
      lessonId: draft.lessonId,
      courseId: draft.courseId,
      type: draft.type,
      inputTokens: chatResult.inputTokens,
      outputTokens: chatResult.outputTokens,
    });

    return draft;
  }

  // ---------------- listing ----------------

  async listDrafts(filter: ListDraftsFilter) {
    return this.prisma.modAiContentDraft.findMany({
      where: {
        tenantId: filter.tenantId,
        ...(filter.lessonId ? { lessonId: filter.lessonId } : {}),
        ...(filter.courseId ? { courseId: filter.courseId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getDraft(tenantId: string, draftId: string) {
    const draft = await this.prisma.modAiContentDraft.findFirst({
      where: { id: draftId, tenantId },
    });
    if (!draft) throw new DraftNotFoundError(draftId);
    return draft;
  }

  // ---------------- transiciones ----------------

  async updateContent(input: UpdateDraftContentInput) {
    const draft = await this.getDraft(input.tenantId, input.draftId);
    if (draft.status !== 'DRAFT') {
      throw new DraftNotInDraftStateError(draft.id, draft.status);
    }
    if (draft.type !== input.type) {
      throw new InvalidContentJsonError(
        input.type,
        `el draft es de tipo ${draft.type} pero se intentó actualizar como ${input.type}`,
      );
    }
    validateContentShape(input.type, input.content);
    return this.prisma.modAiContentDraft.update({
      where: { id: draft.id },
      data: { content: input.content as never },
    });
  }

  async publish(tenantId: string, reviewerId: string, draftId: string) {
    const draft = await this.getDraft(tenantId, draftId);
    if (draft.status !== 'DRAFT') {
      throw new DraftNotInDraftStateError(draft.id, draft.status);
    }
    const updated = await this.prisma.modAiContentDraft.update({
      where: { id: draft.id },
      data: {
        status: 'PUBLISHED',
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
      },
    });
    await this.publisher.publish(tenantId, reviewerId, EVENT.PUBLISHED, {
      draftId: updated.id,
      lessonId: updated.lessonId,
      courseId: updated.courseId,
      type: updated.type,
    });
    return updated;
  }

  async reject(tenantId: string, reviewerId: string, draftId: string, reason?: string) {
    const draft = await this.getDraft(tenantId, draftId);
    if (draft.status !== 'DRAFT') {
      throw new DraftNotInDraftStateError(draft.id, draft.status);
    }
    const updated = await this.prisma.modAiContentDraft.update({
      where: { id: draft.id },
      data: {
        status: 'REJECTED',
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        rejectReason: reason ?? null,
      },
    });
    await this.publisher.publish(tenantId, reviewerId, EVENT.REJECTED, {
      draftId: updated.id,
      lessonId: updated.lessonId,
      type: updated.type,
      reason: reason ?? null,
    });
    return updated;
  }
}

// ---------------- helpers ----------------

function pickSystemPrompt(type: DraftType): string {
  switch (type) {
    case 'SUMMARY':
      return SYSTEM_SUMMARY;
    case 'FLASHCARDS':
      return SYSTEM_FLASHCARDS;
    case 'QUIZ':
      return SYSTEM_QUIZ;
  }
}

function validateContentShape(type: DraftType, content: unknown): void {
  if (!content || typeof content !== 'object') {
    throw new InvalidContentJsonError(type, 'la respuesta no es un objeto JSON');
  }
  switch (type) {
    case 'SUMMARY': {
      const c = content as Partial<SummaryContent>;
      if (typeof c.text !== 'string' || c.text.trim().length < 20) {
        throw new InvalidContentJsonError(type, 'falta `text` o es demasiado corto');
      }
      return;
    }
    case 'FLASHCARDS': {
      const c = content as Partial<FlashcardsContent>;
      if (!Array.isArray(c.cards) || c.cards.length === 0) {
        throw new InvalidContentJsonError(type, 'falta `cards` o array vacío');
      }
      for (const card of c.cards) {
        if (typeof card.front !== 'string' || typeof card.back !== 'string') {
          throw new InvalidContentJsonError(type, 'card sin `front` o `back`');
        }
      }
      return;
    }
    case 'QUIZ': {
      const c = content as Partial<QuizContent>;
      if (!Array.isArray(c.questions) || c.questions.length === 0) {
        throw new InvalidContentJsonError(type, 'falta `questions` o array vacío');
      }
      for (const q of c.questions) {
        if (typeof q.prompt !== 'string' || typeof q.answer !== 'string') {
          throw new InvalidContentJsonError(type, 'question sin `prompt` o `answer`');
        }
        if (q.options !== undefined && !Array.isArray(q.options)) {
          throw new InvalidContentJsonError(type, '`options` debe ser array si está presente');
        }
      }
      return;
    }
  }
}
