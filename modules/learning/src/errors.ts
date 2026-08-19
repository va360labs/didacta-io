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
export interface LearningErrorOptions {
  readonly detail?: string;
}

export class LearningError extends Error {
  readonly detail?: string;

  constructor(
    public readonly code: string,
    message: string,
    options?: LearningErrorOptions,
  ) {
    super(message);
    this.name = 'LearningError';
    this.detail = options?.detail;
  }
}

export class AlreadyEnrolledError extends LearningError {
  constructor() {
    super('ALREADY_ENROLLED', 'El usuario ya está matriculado en este curso');
  }
}

export class EnrollmentNotFoundError extends LearningError {
  constructor() {
    super(
      'ENROLLMENT_NOT_FOUND',
      'No existe matriculación para esa combinación de usuario y curso',
    );
  }
}

export class InvitationInvalidError extends LearningError {
  constructor(reason: string) {
    super('INVITATION_INVALID', `Invitación inválida: ${reason}`, { detail: reason });
  }
}

export class CourseNotPublishedError extends LearningError {
  constructor() {
    super('COURSE_NOT_PUBLISHED', 'El curso no está publicado');
  }
}

/** La lección aún no está liberada por el calendario de drip del curso. */
export class LessonLockedError extends LearningError {
  constructor(public readonly availableAt: Date | null) {
    super(
      'LESSON_LOCKED',
      availableAt
        ? `Esta lección se libera el ${availableAt.toISOString().slice(0, 10)}`
        : 'Esta lección aún no está disponible',
    );
  }
}

/**
 * La lección queda fuera del límite de contenido del PERIODO DE PRUEBA de la
 * membresía (trialLessonLimit): se desbloquea al pagar (fin del trial), no en
 * una fecha. Distinta de LessonLockedError (drip por calendario).
 */
export class TrialContentLockedError extends LearningError {
  constructor() {
    super(
      'TRIAL_CONTENT_LOCKED',
      'Esta lección estará disponible cuando termine tu periodo de prueba. Puedes pagar ahora para desbloquearla ya.',
    );
  }
}

export class ScormPackageInvalidError extends LearningError {
  constructor(reason: string) {
    super('SCORM_PACKAGE_INVALID', `Paquete SCORM inválido: ${reason}`, { detail: reason });
  }
}

export class ScormLessonTypeMismatchError extends LearningError {
  constructor() {
    super(
      'SCORM_LESSON_TYPE_MISMATCH',
      'La lección no es de tipo SCORM. Cambiá el tipo antes de subir el paquete.',
    );
  }
}

export class ScormPackageNotFoundError extends LearningError {
  constructor() {
    super('SCORM_PACKAGE_NOT_FOUND', 'No hay paquete SCORM asociado a esta lección');
  }
}

export class LearningPathNotFoundError extends LearningError {
  constructor() {
    super('LEARNING_PATH_NOT_FOUND', 'La ruta de aprendizaje no existe o no está publicada');
  }
}

export class LearningPathNotPublishedError extends LearningError {
  constructor() {
    super('LEARNING_PATH_NOT_PUBLISHED', 'La ruta de aprendizaje no está publicada');
  }
}

export class LearningPathAlreadyEnrolledError extends LearningError {
  constructor() {
    super('LEARNING_PATH_ALREADY_ENROLLED', 'Ya estás matriculado en esta ruta de aprendizaje');
  }
}

export class LearningPathEnrollmentNotFoundError extends LearningError {
  constructor() {
    super('LEARNING_PATH_ENROLLMENT_NOT_FOUND', 'No hay matriculación activa en esta ruta');
  }
}

export class LearningPathNoCourseError extends LearningError {
  constructor() {
    super('LEARNING_PATH_NO_COURSE', 'La ruta debe tener al menos un curso para publicarse');
  }
}

/**
 * La lección que se quiere marcar no pertenece al curso de la matrícula (o ya
 * no existe). Antes no se comprobaba: `trackProgress` aceptaba cualquier UUID
 * con `completed:true` y `recalcEnrollmentProgress` lo contaba contra el total
 * del curso, así que ocho UUID inventados bastaban para cruzar el umbral,
 * cerrar la matrícula y auto-emitirse el certificado sin abrir una lección.
 */
export class LessonNotInCourseError extends LearningError {
  constructor() {
    super('LESSON_NOT_IN_COURSE', 'Esa lección no pertenece al curso de tu matrícula');
  }
}

/**
 * La matrícula existe pero no está viva (CANCELLED tras un reembolso, PAUSED
 * por impago). No se registra progreso: sin esto, un alumno reembolsado seguía
 * enviando progreso con su `enrollmentId` viejo hasta cruzar el umbral y
 * llevarse curso completado, evento, certificado y puntos.
 */
export class EnrollmentNotActiveError extends LearningError {
  constructor(status: string) {
    super('ENROLLMENT_NOT_ACTIVE', `Tu matrícula está ${status} y no admite progreso`, {
      detail: status,
    });
  }
}

/**
 * El curso está a la venta, así que no se puede uno automatricular. Antes
 * `enrollSelf` solo comprobaba que estuviera PUBLISHED y el CTA de compra se
 * saltaba con una llamada a la API.
 */
export class CourseNotFreeError extends LearningError {
  constructor() {
    super('COURSE_NOT_FREE', 'Este curso no permite matriculación libre: hay que adquirirlo');
  }
}
