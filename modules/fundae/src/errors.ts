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

export class BlockNotFoundError extends FundaeError {
  constructor(blockId: string) {
    super('FUNDAE_BLOCK_NOT_FOUND', `El módulo formativo ${blockId} no existe.`);
  }
}

export class BlockHoursExceedActionError extends FundaeError {
  constructor(totalRequested: number, actionHours: number) {
    super(
      'FUNDAE_BLOCK_HOURS_EXCEED',
      `La suma de horas de los bloques (${totalRequested}h) supera las horas de la acción (${actionHours}h).`,
    );
  }
}

export class BlockOrdinalDuplicadoError extends FundaeError {
  constructor(ordinal: number) {
    super(
      'FUNDAE_BLOCK_ORDINAL_DUPLICADO',
      `Ya existe un bloque con ordinal ${ordinal} en esta acción.`,
    );
  }
}

export class ParticipantNotInActionError extends FundaeError {
  constructor(userId: string) {
    super(
      'FUNDAE_PARTICIPANT_NOT_IN_ACTION',
      `El usuario ${userId} no está matriculado en el curso vinculado a esta acción.`,
    );
  }
}

export class ActionWithoutCourseError extends FundaeError {
  constructor(actionId: string) {
    super(
      'FUNDAE_ACTION_WITHOUT_COURSE',
      `La acción ${actionId} no tiene curso vinculado; no es posible generar evidencias por participante.`,
    );
  }
}
