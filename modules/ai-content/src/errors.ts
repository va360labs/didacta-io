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
export interface AiContentErrorOptions {
  readonly detail?: string;
  /**
   * Valores CON NOMBRE cuando el `message` interpola DOS o más con copy
   * español entre medias: `detail` es un campo único y colapsarlos ahí dejaría
   * el conector español dentro de la frase inglesa. Mismo contrato.
   */
  readonly params?: Readonly<Record<string, string>>;
}

export class AiContentError extends Error {
  readonly detail?: string;
  readonly params?: Readonly<Record<string, string>>;

  constructor(
    message: string,
    public readonly code: string,
    options?: AiContentErrorOptions,
  ) {
    super(message);
    this.name = 'AiContentError';
    this.detail = options?.detail;
    this.params = options?.params;
  }
}

export class DraftNotFoundError extends AiContentError {
  constructor(id: string) {
    super(`Draft no encontrado: ${id}`, 'AI_CONTENT_DRAFT_NOT_FOUND', { detail: id });
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
      { detail: lessonId },
    );
    this.name = 'LessonTextEmptyError';
  }
}

export class AiContentProviderError extends AiContentError {
  constructor(reason: string) {
    super(
      `El proveedor IA falló al generar contenido: ${reason}. Revisa la config del tenant.`,
      'AI_CONTENT_PROVIDER_ERROR',
      { detail: reason },
    );
    this.name = 'AiContentProviderError';
  }
}

export class InvalidContentJsonError extends AiContentError {
  constructor(type: string, reason: string) {
    // Dos valores con copy español entre medias → `params`, no `detail`.
    super(
      `El JSON propuesto para draft tipo ${type} no es válido: ${reason}.`,
      'AI_CONTENT_INVALID_JSON',
      { params: { type, reason } },
    );
    this.name = 'InvalidContentJsonError';
  }
}
