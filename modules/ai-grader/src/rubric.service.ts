/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { ModuleContext } from '@didacta/core-kernel';
import type { PrismaClient } from '@didacta/database';
import {
  upsertRubricSchema,
  type RubricCriterionDto,
  type RubricView,
  type UpsertRubricDto,
} from './dto.js';
import { QuestionNotGradableError, RubricInvalidError, RubricNotFoundError } from './errors.js';

interface QuestionRow {
  id: string;
  type: string;
  points: number;
}

const GRADABLE_TYPES = new Set(['SHORT_ANSWER', 'LONG_ANSWER']);

/**
 * CRUD de rúbricas para AI Grader.
 *
 * Reglas de negocio:
 *   - Solo se permite rúbrica sobre preguntas SHORT_ANSWER / LONG_ANSWER.
 *   - La suma de pesos de los criterios debe igualar `question.points`.
 *     Esto garantiza que el `proposedScore` máximo nunca exceda los
 *     puntos de la pregunta y que la rúbrica use TODO el rango disponible.
 *   - Aislamiento por tenantId: el caller NUNCA pasa tenantId desde el
 *     cliente, siempre desde el JWT.
 */
export class AiGraderRubricService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ctx: ModuleContext,
  ) {}

  async get(tenantId: string, questionId: string): Promise<RubricView | null> {
    const row = (await this.prisma.modAiGraderRubric.findFirst({
      where: { tenantId, questionId },
    })) as {
      id: string;
      questionId: string;
      instructions: string;
      criteria: unknown;
      enabled: boolean;
      createdAt: Date;
      updatedAt: Date;
    } | null;
    return row ? toRubricView(row) : null;
  }

  async require(tenantId: string, questionId: string): Promise<RubricView> {
    const r = await this.get(tenantId, questionId);
    if (!r) throw new RubricNotFoundError(questionId);
    return r;
  }

  /**
   * Upsert atómico — si ya hay rúbrica para la pregunta, la reemplaza por
   * completo (no merge parcial: la rúbrica es una unidad coherente).
   * Valida tipo de pregunta + suma de pesos antes de persistir.
   */
  async upsert(tenantId: string, questionId: string, dto: UpsertRubricDto): Promise<RubricView> {
    // Re-parse en server-side para defensa en profundidad (el controller ya
    // lo hizo, pero un caller programático podría saltearse el pipe).
    const parsed = upsertRubricSchema.parse(dto);

    const question = (await this.prisma.modAssessmentsQuestion.findFirst({
      where: { tenantId, id: questionId, deletedAt: null },
      select: { id: true, type: true, points: true },
    })) as QuestionRow | null;
    if (!question) {
      throw new RubricInvalidError(`pregunta ${questionId} no existe en este tenant`);
    }
    if (!GRADABLE_TYPES.has(question.type)) {
      throw new QuestionNotGradableError(questionId, question.type);
    }

    const totalWeight = parsed.criteria.reduce((acc, c) => acc + c.weight, 0);
    if (totalWeight !== question.points) {
      throw new RubricInvalidError(
        `la suma de pesos (${totalWeight}) debe igualar los puntos de la pregunta (${question.points})`,
      );
    }

    const existing = (await this.prisma.modAiGraderRubric.findFirst({
      where: { tenantId, questionId },
      select: { id: true },
    })) as { id: string } | null;

    const data = {
      instructions: parsed.instructions,
      criteria: parsed.criteria as unknown as object,
      enabled: parsed.enabled ?? true,
    };

    if (existing) {
      const updated = (await this.prisma.modAiGraderRubric.update({
        where: { id: existing.id },
        data,
      })) as never;
      this.ctx.logger.info('mod.ai-grader: rúbrica actualizada', {
        tenantId,
        questionId,
        criteria: parsed.criteria.length,
      });
      return toRubricView(updated);
    }

    const created = (await this.prisma.modAiGraderRubric.create({
      data: { tenantId, questionId, ...data },
    })) as never;
    this.ctx.logger.info('mod.ai-grader: rúbrica creada', {
      tenantId,
      questionId,
      criteria: parsed.criteria.length,
    });
    return toRubricView(created);
  }

  async remove(tenantId: string, questionId: string): Promise<{ deleted: boolean }> {
    const r = await this.prisma.modAiGraderRubric.deleteMany({
      where: { tenantId, questionId },
    });
    return { deleted: (r as { count: number }).count > 0 };
  }
}

function toRubricView(row: {
  id: string;
  questionId: string;
  instructions: string;
  criteria: unknown;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): RubricView {
  return {
    id: row.id,
    questionId: row.questionId,
    instructions: row.instructions,
    criteria: row.criteria as RubricCriterionDto[],
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
