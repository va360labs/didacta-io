/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Opciones de un error de dominio. `detail` es el dato que el `message` español
 * lleva incrustado y que el catálogo inglés se tragaba al traducir por `code`:
 * viaja como campo APARTE hasta el front. Contrato completo en
 * `apps/api/src/common/module-error-body.ts`.
 */
export interface CoursesErrorOptions {
  readonly detail?: string;
}

export class CoursesError extends Error {
  readonly detail?: string;

  constructor(
    public readonly code: string,
    message: string,
    options?: CoursesErrorOptions,
  ) {
    super(message);
    this.name = 'CoursesError';
    this.detail = options?.detail;
  }
}

export class CourseNotFoundError extends CoursesError {
  constructor(courseId: string) {
    // SIN `detail` a propósito: `courses.controller.ts:244` lanza este MISMO
    // code con otra frase española («Curso no encontrado», sin el id). Una sola
    // key ES no puede rendir las dos byte a byte, así que el code se queda en
    // `EN_ONLY_BY_DESIGN` — ver la cabecera de `messages-parity.test.ts` ①.
    super('COURSE_NOT_FOUND', `Curso no encontrado: ${courseId}`);
  }
}

export class CourseSlugAlreadyExistsError extends CoursesError {
  constructor(slug: string) {
    super('COURSE_SLUG_EXISTS', `Ya existe un curso con slug "${slug}" en este tenant`, {
      detail: slug,
    });
  }
}

export class CourseAlreadyPublishedError extends CoursesError {
  constructor(courseId: string) {
    super('COURSE_ALREADY_PUBLISHED', `El curso ${courseId} ya está publicado`, {
      detail: courseId,
    });
  }
}

export class CourseHasNoLessonsError extends CoursesError {
  constructor() {
    super('COURSE_NO_LESSONS', 'No se puede publicar un curso sin al menos una lección');
  }
}

export class PublishValidationError extends CoursesError {
  constructor(public readonly reasons: readonly string[]) {
    super(
      'COURSE_PUBLISH_VALIDATION_FAILED',
      `Validación de publicación falló: ${reasons.join('; ')}`,
    );
  }
}
