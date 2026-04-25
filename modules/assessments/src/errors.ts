export class AssessmentsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AssessmentsError';
  }
}

export class QuizNotFoundError extends AssessmentsError {
  constructor() {
    super('QUIZ_NOT_FOUND', 'El quiz solicitado no existe o no pertenece al tenant');
  }
}

export class QuestionNotFoundError extends AssessmentsError {
  constructor() {
    super('QUESTION_NOT_FOUND', 'La pregunta solicitada no existe o no pertenece al quiz');
  }
}

export class QuizNotPublishedError extends AssessmentsError {
  constructor() {
    super('QUIZ_NOT_PUBLISHED', 'No se puede iniciar un intento de un quiz no publicado');
  }
}

export class AttemptNotFoundError extends AssessmentsError {
  constructor() {
    super('ATTEMPT_NOT_FOUND', 'El intento no existe o no pertenece al usuario');
  }
}

export class AttemptAlreadySubmittedError extends AssessmentsError {
  constructor() {
    super('ATTEMPT_ALREADY_SUBMITTED', 'El intento ya fue enviado y no admite cambios');
  }
}

export class AttemptExpiredError extends AssessmentsError {
  constructor() {
    super('ATTEMPT_EXPIRED', 'El intento expiró por límite de tiempo y no admite envío');
  }
}

export class MaxAttemptsReachedError extends AssessmentsError {
  constructor(maxAttempts: number) {
    super(
      'MAX_ATTEMPTS_REACHED',
      `El alumno ha alcanzado el máximo de intentos permitidos (${maxAttempts})`,
    );
  }
}

export class QuizHasNoQuestionsError extends AssessmentsError {
  constructor() {
    super('QUIZ_HAS_NO_QUESTIONS', 'No se puede publicar un quiz sin preguntas');
  }
}

export class QuestionHasNoCorrectOptionError extends AssessmentsError {
  constructor() {
    super(
      'QUESTION_HAS_NO_CORRECT_OPTION',
      'Toda pregunta de tipo objetivo debe tener al menos una opción marcada como correcta',
    );
  }
}

export class AttemptNotPendingReviewError extends AssessmentsError {
  constructor() {
    super(
      'ATTEMPT_NOT_PENDING_REVIEW',
      'Solo se pueden corregir intentos en estado PENDING_REVIEW',
    );
  }
}

export class GradeExceedsQuestionPointsError extends AssessmentsError {
  constructor(questionId: string, scoreEarned: number, max: number) {
    super(
      'GRADE_EXCEEDS_QUESTION_POINTS',
      `La puntuación ${scoreEarned} para la pregunta ${questionId} excede el máximo (${max})`,
    );
  }
}
