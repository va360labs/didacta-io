/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Opciones de un error de dominio. `detail` es el diagnóstico CRUDO que el
 * `message` español lleva incrustado (lo que responde el proveedor de IA): viaja
 * como campo APARTE hasta el front para que el catálogo inglés no se lo trague
 * al traducir por `code`. Contrato completo en
 * `apps/api/src/common/module-error-body.ts`.
 */
export interface AiGraderErrorOptions {
  readonly detail?: string;
  /**
   * Valores CON NOMBRE cuando el `message` interpola DOS o más con copy
   * español entre medias: `detail` es un campo único y colapsarlos ahí dejaría
   * el conector español dentro de la frase inglesa. Mismo contrato.
   */
  readonly params?: Readonly<Record<string, string>>;
}

export class AiGraderError extends Error {
  readonly detail?: string;
  readonly params?: Readonly<Record<string, string>>;

  constructor(
    public readonly code: string,
    message: string,
    options?: AiGraderErrorOptions,
  ) {
    super(message);
    this.name = 'AiGraderError';
    this.detail = options?.detail;
    this.params = options?.params;
  }
}

export class RubricNotFoundError extends AiGraderError {
  constructor(questionId: string) {
    super(
      'AI_GRADER_RUBRIC_NOT_FOUND',
      `No hay rúbrica configurada para la pregunta ${questionId}. ` +
        'El formador debe crear una antes de pedir sugerencias IA.',
      { detail: questionId },
    );
  }
}

export class RubricInvalidError extends AiGraderError {
  constructor(reason: string) {
    super('AI_GRADER_RUBRIC_INVALID', `Rúbrica inválida: ${reason}`, { detail: reason });
  }
}

export class QuestionNotGradableError extends AiGraderError {
  constructor(questionId: string, type: string) {
    super(
      'AI_GRADER_QUESTION_NOT_GRADABLE',
      `La pregunta ${questionId} es de tipo ${type}; AI Grader solo opera sobre ` +
        'SHORT_ANSWER y LONG_ANSWER.',
    );
  }
}

export class AttemptNotPendingReviewError extends AiGraderError {
  constructor(attemptId: string) {
    super(
      'AI_GRADER_ATTEMPT_NOT_PENDING',
      `El attempt ${attemptId} no está en estado PENDING_REVIEW; ` +
        'AI Grader solo sugiere notas para attempts pendientes de corrección.',
      { detail: attemptId },
    );
  }
}

export class GraderProviderError extends AiGraderError {
  constructor(provider: string, reason: string) {
    // Dos valores con copy español entre medias: `params` (no `detail`), para
    // que el inglés escriba SU frase y no herede el «falló» de la española.
    super('AI_GRADER_PROVIDER_ERROR', `Provider ${provider} falló: ${reason}`, {
      params: { provider, reason },
    });
  }
}

export class GraderResponseParseError extends AiGraderError {
  constructor(detail: string) {
    super(
      'AI_GRADER_RESPONSE_PARSE_ERROR',
      `No pudimos parsear la respuesta del modelo: ${detail}`,
      { detail },
    );
  }
}

export class SuggestionNotFoundError extends AiGraderError {
  constructor(suggestionId: string) {
    super(
      'AI_GRADER_SUGGESTION_NOT_FOUND',
      `Sugerencia ${suggestionId} no encontrada en este tenant.`,
      { detail: suggestionId },
    );
  }
}
