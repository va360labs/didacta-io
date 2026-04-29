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

export class TokenQuotaExceededError extends AiTutorError {
  constructor(scope: 'user' | 'tenant', usedTokens: number, limitTokens: number) {
    super(
      'AI_TUTOR_TOKEN_QUOTA_EXCEEDED',
      `Cuota de tokens AI agotada para ${scope}: ${usedTokens}/${limitTokens}.`,
    );
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
