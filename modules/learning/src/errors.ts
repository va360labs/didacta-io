/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

export class LearningError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LearningError';
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
    super('INVITATION_INVALID', `Invitación inválida: ${reason}`);
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
    super('SCORM_PACKAGE_INVALID', `Paquete SCORM inválido: ${reason}`);
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
