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
