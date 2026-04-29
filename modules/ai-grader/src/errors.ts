export class AiGraderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AiGraderError';
  }
}

export class RubricNotFoundError extends AiGraderError {
  constructor(questionId: string) {
    super(
      'AI_GRADER_RUBRIC_NOT_FOUND',
      `No hay rúbrica configurada para la pregunta ${questionId}. ` +
        'El formador debe crear una antes de pedir sugerencias IA.',
    );
  }
}

export class RubricInvalidError extends AiGraderError {
  constructor(reason: string) {
    super('AI_GRADER_RUBRIC_INVALID', `Rúbrica inválida: ${reason}`);
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
    );
  }
}

export class GraderProviderError extends AiGraderError {
  constructor(provider: string, reason: string) {
    super('AI_GRADER_PROVIDER_ERROR', `Provider ${provider} falló: ${reason}`);
  }
}

export class GraderResponseParseError extends AiGraderError {
  constructor(detail: string) {
    super(
      'AI_GRADER_RESPONSE_PARSE_ERROR',
      `No pudimos parsear la respuesta del modelo: ${detail}`,
    );
  }
}
