export class FundaeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FundaeError';
  }
}

export class ActionNotFoundError extends FundaeError {
  constructor(actionId: string) {
    super('FUNDAE_ACTION_NOT_FOUND', `La acción formativa ${actionId} no existe.`);
  }
}

export class CodigoDuplicadoError extends FundaeError {
  constructor(codigo: string) {
    super(
      'FUNDAE_CODIGO_DUPLICADO',
      `Ya existe una acción formativa con código "${codigo}" en este tenant.`,
    );
  }
}

export class FechasInvalidasError extends FundaeError {
  constructor() {
    super(
      'FUNDAE_FECHAS_INVALIDAS',
      'La fecha de inicio debe ser anterior o igual a la fecha de fin.',
    );
  }
}

export class CourseNotInTenantError extends FundaeError {
  constructor(courseId: string) {
    super('FUNDAE_COURSE_NOT_IN_TENANT', `El curso ${courseId} no pertenece a este tenant.`);
  }
}
