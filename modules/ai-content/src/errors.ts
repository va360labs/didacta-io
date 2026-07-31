/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

export class AiContentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AiContentError';
  }
}

export class DraftNotFoundError extends AiContentError {
  constructor(id: string) {
    super(`Draft no encontrado: ${id}`, 'AI_CONTENT_DRAFT_NOT_FOUND');
    this.name = 'DraftNotFoundError';
  }
}

export class DraftNotInDraftStateError extends AiContentError {
  constructor(id: string, currentStatus: string) {
    super(
      `Draft ${id} ya no está en estado DRAFT (estado actual: ${currentStatus}). No se puede publicar / rechazar / editar.`,
      'AI_CONTENT_DRAFT_NOT_IN_DRAFT',
    );
    this.name = 'DraftNotInDraftStateError';
  }
}

export class LessonTextEmptyError extends AiContentError {
  constructor(lessonId: string) {
    super(
      `La lección ${lessonId} no tiene texto extraíble. La IA necesita contenido textual para generar.`,
      'AI_CONTENT_LESSON_TEXT_EMPTY',
    );
    this.name = 'LessonTextEmptyError';
  }
}

export class AiContentProviderError extends AiContentError {
  constructor(reason: string) {
    super(
      `El proveedor IA falló al generar contenido: ${reason}. Revisa la config del tenant.`,
      'AI_CONTENT_PROVIDER_ERROR',
    );
    this.name = 'AiContentProviderError';
  }
}

export class InvalidContentJsonError extends AiContentError {
  constructor(type: string, reason: string) {
    super(
      `El JSON propuesto para draft tipo ${type} no es válido: ${reason}.`,
      'AI_CONTENT_INVALID_JSON',
    );
    this.name = 'InvalidContentJsonError';
  }
}
