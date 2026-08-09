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
export interface AiTutorErrorOptions {
  readonly detail?: string;
  /**
   * Valores CON NOMBRE cuando el `message` interpola DOS o más con copy
   * español entre medias: `detail` es un campo único y colapsarlos ahí dejaría
   * el conector español dentro de la frase inglesa. Mismo contrato.
   */
  readonly params?: Readonly<Record<string, string>>;
}

export class AiTutorError extends Error {
  readonly detail?: string;
  readonly params?: Readonly<Record<string, string>>;

  constructor(
    public readonly code: string,
    message: string,
    options?: AiTutorErrorOptions,
  ) {
    super(message);
    this.name = 'AiTutorError';
    this.detail = options?.detail;
    this.params = options?.params;
  }
}

export class CourseNotIndexedError extends AiTutorError {
  constructor(courseId: string) {
    super(
      'AI_TUTOR_COURSE_NOT_INDEXED',
      `El curso ${courseId} no está indexado todavía. ` +
        'Publica el curso o solicita re-indexación al admin.',
      { detail: courseId },
    );
  }
}

export class CourseNotPublishedError extends AiTutorError {
  constructor(courseId: string) {
    super(
      'AI_TUTOR_COURSE_NOT_PUBLISHED',
      `El curso ${courseId} no está publicado; el tutor IA solo opera sobre cursos publicados.`,
      { detail: courseId },
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
      { detail: courseId },
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
      { detail: messageId },
    );
  }
}

export class CorrectionNotFoundError extends AiTutorError {
  constructor(correctionId: string) {
    super('AI_TUTOR_CORRECTION_NOT_FOUND', `No existe la corrección ${correctionId}.`, {
      detail: correctionId,
    });
  }
}

export class EmbeddingsProviderError extends AiTutorError {
  constructor(provider: string, reason: string) {
    // Dos valores con copy español entre medias → `params`, no `detail`.
    super('AI_TUTOR_EMBEDDINGS_PROVIDER_ERROR', `Provider ${provider} falló: ${reason}`, {
      params: { provider, reason },
    });
  }
}

export class ChatProviderError extends AiTutorError {
  constructor(provider: string, reason: string) {
    // Dos valores con copy español entre medias → `params`, no `detail`.
    super('AI_TUTOR_CHAT_PROVIDER_ERROR', `Provider ${provider} falló: ${reason}`, {
      params: { provider, reason },
    });
  }
}
