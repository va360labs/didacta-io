export class AiTutorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AiTutorError';
  }
}

export class CourseNotIndexedError extends AiTutorError {
  constructor(courseId: string) {
    super(
      'AI_TUTOR_COURSE_NOT_INDEXED',
      `El curso ${courseId} no está indexado todavía. ` +
        'Publica el curso o solicita re-indexación al admin.',
    );
  }
}

export class CourseNotPublishedError extends AiTutorError {
  constructor(courseId: string) {
    super(
      'AI_TUTOR_COURSE_NOT_PUBLISHED',
      `El curso ${courseId} no está publicado; el tutor IA solo opera sobre cursos publicados.`,
    );
  }
}

/**
 * El alumno pide el tutor de un curso en el que no está matriculado. La ficha
 * del curso ya esconde el contenido sin matrícula; sin esta comprobación el
 * tutor era una puerta trasera para leer resumido un curso sin comprarlo.
 */
export class CourseAccessDeniedError extends AiTutorError {
  constructor(courseId: string) {
    super(
      'AI_TUTOR_COURSE_ACCESS_DENIED',
      `Sin acceso al curso ${courseId}: el tutor sólo responde sobre cursos en los que estás matriculado.`,
    );
  }
}

/** Cuota diaria de preguntas del alumno. Se comprueba ANTES de gastar en IA. */
export class DailyQuestionQuotaExceededError extends AiTutorError {
  constructor(
    public readonly used: number,
    public readonly limit: number,
  ) {
    super(
      'AI_TUTOR_DAILY_QUESTION_QUOTA',
      `Has llegado a tu límite de ${limit} preguntas al tutor por día (llevas ${used}). ` +
        'Vuelve mañana o escribe a tu formador.',
    );
  }
}

export class TokenQuotaExceededError extends AiTutorError {
  constructor(scope: 'user' | 'tenant', usedTokens: number, limitTokens: number) {
    super(
      'AI_TUTOR_TOKEN_QUOTA_EXCEEDED',
      `Cuota de tokens AI agotada para ${scope}: ${usedTokens}/${limitTokens}.`,
    );
  }
}

/** El admin intenta revisar una respuesta que no existe (o es de otro tenant). */
export class MessageNotFoundError extends AiTutorError {
  constructor(messageId: string) {
    super(
      'AI_TUTOR_MESSAGE_NOT_FOUND',
      `No existe la respuesta ${messageId} del tutor en este tenant.`,
    );
  }
}

export class CorrectionNotFoundError extends AiTutorError {
  constructor(correctionId: string) {
    super('AI_TUTOR_CORRECTION_NOT_FOUND', `No existe la corrección ${correctionId}.`);
  }
}

export class EmbeddingsProviderError extends AiTutorError {
  constructor(provider: string, reason: string) {
    super('AI_TUTOR_EMBEDDINGS_PROVIDER_ERROR', `Provider ${provider} falló: ${reason}`);
  }
}

export class ChatProviderError extends AiTutorError {
  constructor(provider: string, reason: string) {
    super('AI_TUTOR_CHAT_PROVIDER_ERROR', `Provider ${provider} falló: ${reason}`);
  }
}
