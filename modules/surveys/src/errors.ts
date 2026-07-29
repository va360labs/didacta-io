/**
 * Errores de dominio de mod.surveys. El host los mapea a HTTP en
 * `apps/api/src/modules/surveys/surveys-error.filter.ts` por `code`.
 */
export class SurveysError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'SurveysError';
  }
}

export class SurveysSurveyNotFoundError extends SurveysError {
  constructor() {
    super('Encuesta no encontrada.', 'SURVEYS_NOT_FOUND');
    this.name = 'SurveysSurveyNotFoundError';
  }
}

export class SurveysSurveyClosedError extends SurveysError {
  constructor() {
    super('La encuesta ya está cerrada.', 'SURVEYS_CLOSED');
    this.name = 'SurveysSurveyClosedError';
  }
}

/** El mismo usuario ya envió su respuesta (dedupe por respondent_hash). */
export class SurveysAlreadyRespondedError extends SurveysError {
  constructor() {
    super('Ya has respondido esta encuesta. ¡Gracias!', 'SURVEYS_ALREADY_RESPONDED');
    this.name = 'SurveysAlreadyRespondedError';
  }
}

export class SurveysInvalidAnswerError extends SurveysError {
  constructor(detail: string) {
    super(detail, 'SURVEYS_INVALID_ANSWER');
    this.name = 'SurveysInvalidAnswerError';
  }
}
