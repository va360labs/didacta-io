/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import type {
  CriterionScoreView,
  RubricCriterionDto,
  SuggestForAttemptDto,
  SuggestForAttemptResultView,
  SuggestionView,
} from './dto.js';
import {
  AttemptNotPendingReviewError,
  GraderProviderError,
  GraderResponseParseError,
  SuggestionNotFoundError,
} from './errors.js';
import { buildGraderPrompt, parseGraderResponse } from './prompt-builder.js';

/**
 * Función inyectada por el host (apps/api) que delega al AI Gateway con
 * resolución per-tenant de provider de chat.
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
    provider: string;
    model: string;
  }>;
}

interface AttemptRow {
  id: string;
  tenantId: string;
  status: string;
}

interface AnswerRow {
  id: string;
  questionId: string;
  textAnswer: string | null;
}

interface QuestionRow {
  id: string;
  type: string;
  prompt: string;
  points: number;
}

interface RubricRow {
  id: string;
  questionId: string;
  instructions: string;
  criteria: unknown;
  enabled: boolean;
}

interface SuggestionRow {
  id: string;
  attemptId: string;
  answerId: string;
  questionId: string;
  proposedScore: number;
  perCriterion: unknown;
  overallFeedback: string;
  provider: string;
  model: string;
  applied: boolean;
  createdAt: Date;
}

/** Tipos de pregunta que el grader sabe corregir. */
const GRADABLE_TYPES = new Set(['SHORT_ANSWER', 'LONG_ANSWER']);

/**
 * Genera sugerencias IA para todas las respuestas abiertas de un attempt.
 *
 * Flujo:
 *   1. Verifica que el attempt esté en PENDING_REVIEW (no tiene sentido
 *      sugerir si ya fue corregido o aún está en curso).
 *   2. Para cada answer cuya question sea SHORT_ANSWER / LONG_ANSWER y
 *      tenga rúbrica habilitada:
 *        - Si ya hay suggestion y `force=false` → reusa la persistida.
 *        - Si no o `force=true` → llama al chatFn (provider del tenant),
 *          parsea con tolerancia, persiste (upsert por answerId).
 *   3. Devuelve sugerencias generadas + skipped (con motivo) + tokens.
 *
 * No aplica las notas — solo sugiere. La aplicación es manual vía
 * `applySuggestion` (formador confirma) o vía `gradeAttempt` del módulo
 * assessments (formador escribe sus propios scores).
 */
export class AiGraderSuggestionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
    private readonly chatFn: ChatFn,
  ) {}

  async suggestForAttempt(
    tenantId: string,
    attemptId: string,
    dto: SuggestForAttemptDto,
  ): Promise<SuggestForAttemptResultView> {
    const startTs = Date.now();

    const attempt = (await this.prisma.modAssessmentsAttempt.findFirst({
      where: { id: attemptId, tenantId },
      select: { id: true, tenantId: true, status: true },
    })) as AttemptRow | null;
    if (!attempt) {
      throw new AttemptNotPendingReviewError(attemptId);
    }
    if (attempt.status !== 'PENDING_REVIEW') {
      throw new AttemptNotPendingReviewError(attemptId);
    }

    const answers = (await this.prisma.modAssessmentsAnswer.findMany({
      where: { tenantId, attemptId },
      select: { id: true, questionId: true, textAnswer: true },
    })) as AnswerRow[];

    // Cargamos las preguntas en una sola query: no hay relación Prisma
    // entre answer y question (cross-module sin FK por contrato modular).
    const questionIds = answers.map((a) => a.questionId);
    const questions = (await this.prisma.modAssessmentsQuestion.findMany({
      where: { tenantId, id: { in: questionIds }, deletedAt: null },
      select: { id: true, type: true, prompt: true, points: true },
    })) as QuestionRow[];
    const questionById = new Map(questions.map((q) => [q.id, q]));

    const generated: SuggestionView[] = [];
    const skipped: Array<{ questionId: string; reason: string }> = [];
    let totalInput = 0;
    let totalOutput = 0;

    for (const answer of answers) {
      const question = questionById.get(answer.questionId);
      if (!question) {
        // Pregunta borrada después del attempt: nada que hacer.
        skipped.push({
          questionId: answer.questionId,
          reason: 'pregunta no encontrada (¿borrada?)',
        });
        continue;
      }
      if (!GRADABLE_TYPES.has(question.type)) {
        // Auto-corregibles: no hay nada que sugerir.
        continue;
      }

      const rubric = (await this.prisma.modAiGraderRubric.findFirst({
        where: { tenantId, questionId: answer.questionId },
      })) as RubricRow | null;
      if (!rubric) {
        skipped.push({
          questionId: answer.questionId,
          reason: 'sin rúbrica configurada',
        });
        continue;
      }
      if (!rubric.enabled) {
        skipped.push({
          questionId: answer.questionId,
          reason: 'rúbrica deshabilitada',
        });
        continue;
      }

      // Reutilizar sugerencia persistida si existe y no se fuerza regenerar.
      if (!dto.force) {
        const existing = (await this.prisma.modAiGraderSuggestion.findFirst({
          where: { tenantId, attemptId, answerId: answer.id },
        })) as SuggestionRow | null;
        if (existing) {
          generated.push(toSuggestionView(existing));
          continue;
        }
      }

      const criteria = rubric.criteria as RubricCriterionDto[];
      const prompt = buildGraderPrompt({
        questionPrompt: question.prompt,
        studentAnswer: answer.textAnswer ?? '',
        rubricInstructions: rubric.instructions,
        criteria,
        maxScore: question.points,
      });

      let chatResult: Awaited<ReturnType<ChatFn>>;
      try {
        chatResult = await this.chatFn({
          tenantId,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
          maxTokens: 1200,
        });
      } catch (err) {
        this.ctx.logger.error('mod.ai-grader: chatFn falló', {
          tenantId,
          attemptId,
          answerId: answer.id,
          err: err instanceof Error ? err.message : String(err),
        });
        throw new GraderProviderError('gateway', err instanceof Error ? err.message : String(err));
      }
      totalInput += chatResult.inputTokens;
      totalOutput += chatResult.outputTokens;

      let parsed: ReturnType<typeof parseGraderResponse>;
      try {
        parsed = parseGraderResponse(chatResult.content, criteria);
      } catch (err) {
        // El modelo respondió algo no parseable. Se loga y se relanza
        // para que el caller decida (UI muestra error y propone reintento).
        this.ctx.logger.warn('mod.ai-grader: respuesta no parseable', {
          tenantId,
          attemptId,
          answerId: answer.id,
          provider: chatResult.provider,
          model: chatResult.model,
          rawSnippet: chatResult.content.slice(0, 200),
        });
        if (err instanceof GraderResponseParseError) throw err;
        throw new GraderResponseParseError(err instanceof Error ? err.message : String(err));
      }

      // Truncar de nuevo a points: defensa adicional a la del parser por
      // si la suma ponderada se calculó mal en algún edge case del modelo.
      const cappedScore = Math.min(parsed.proposedScore, question.points);

      const persisted = (await this.prisma.modAiGraderSuggestion.upsert({
        where: {
          attemptId_answerId: { attemptId, answerId: answer.id },
        },
        create: {
          tenantId,
          attemptId,
          answerId: answer.id,
          questionId: answer.questionId,
          proposedScore: cappedScore,
          perCriterion: parsed.perCriterion as unknown as object,
          overallFeedback: parsed.overallFeedback,
          provider: chatResult.provider,
          model: chatResult.model,
        },
        update: {
          proposedScore: cappedScore,
          perCriterion: parsed.perCriterion as unknown as object,
          overallFeedback: parsed.overallFeedback,
          provider: chatResult.provider,
          model: chatResult.model,
          applied: false,
          appliedById: null,
          appliedAt: null,
        },
      })) as SuggestionRow;

      generated.push(toSuggestionView(persisted));
    }

    const result: SuggestForAttemptResultView = {
      attemptId,
      generated,
      skipped,
      tokensUsed: { input: totalInput, output: totalOutput },
      durationMs: Date.now() - startTs,
    };

    this.ctx.logger.info('mod.ai-grader: sugerencias generadas', {
      tenantId,
      attemptId,
      generated: generated.length,
      skipped: skipped.length,
      tokens: totalInput + totalOutput,
      durationMs: result.durationMs,
    });

    return result;
  }

  /**
   * Lista todas las sugerencias persistidas para un attempt. Útil para que
   * la UI hidrate el formulario de corrección sin volver a llamar al modelo.
   */
  async listForAttempt(tenantId: string, attemptId: string): Promise<SuggestionView[]> {
    const rows = (await this.prisma.modAiGraderSuggestion.findMany({
      where: { tenantId, attemptId },
      orderBy: { createdAt: 'asc' },
    })) as SuggestionRow[];
    return rows.map(toSuggestionView);
  }

  /**
   * Marca una sugerencia como aplicada. NO modifica el attempt — eso
   * sigue siendo responsabilidad de `gradeAttempt` del módulo assessments
   * para mantener una sola fuente de verdad de la nota.
   *
   * El formador puede haber editado el score antes de aplicar; este método
   * solo registra "esta sugerencia se usó" para métricas de acuerdo IA-humano.
   */
  async markApplied(
    tenantId: string,
    suggestionId: string,
    appliedById: string,
  ): Promise<SuggestionView> {
    // Defensa multi-tenant: filtramos por tenantId en findFirst antes de
    // mutar. Sin esto, un suggestionId leakeado de otro tenant podría
    // marcarse vía PUT — Prisma `update({where:{id}})` ignoraría tenantId.
    const existing = (await this.prisma.modAiGraderSuggestion.findFirst({
      where: { id: suggestionId, tenantId },
      select: { id: true },
    })) as { id: string } | null;
    if (!existing) {
      throw new SuggestionNotFoundError(suggestionId);
    }
    const updated = (await this.prisma.modAiGraderSuggestion.update({
      where: { id: existing.id },
      data: {
        applied: true,
        appliedById,
        appliedAt: new Date(),
      },
    })) as SuggestionRow;
    this.ctx.logger.info('mod.ai-grader: sugerencia marcada como aplicada', {
      tenantId,
      suggestionId,
      appliedById,
    });
    return toSuggestionView(updated);
  }
}

function toSuggestionView(row: SuggestionRow): SuggestionView {
  return {
    id: row.id,
    attemptId: row.attemptId,
    answerId: row.answerId,
    questionId: row.questionId,
    proposedScore: row.proposedScore,
    perCriterion: row.perCriterion as CriterionScoreView[],
    overallFeedback: row.overallFeedback,
    provider: row.provider,
    model: row.model,
    applied: row.applied,
    createdAt: row.createdAt.toISOString(),
  };
}
