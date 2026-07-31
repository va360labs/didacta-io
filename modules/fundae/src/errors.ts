/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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

export class CompanyNotFoundError extends FundaeError {
  constructor(companyId: string) {
    super('FUNDAE_COMPANY_NOT_FOUND', `La empresa bonificada ${companyId} no existe.`);
  }
}

export class CompanyNifDuplicadoError extends FundaeError {
  constructor(nif: string) {
    super(
      'FUNDAE_COMPANY_NIF_DUPLICADO',
      `Ya existe una empresa bonificada con NIF "${nif}" en este tenant.`,
    );
  }
}

export class CompanyTieneGruposActivosError extends FundaeError {
  constructor(companyId: string, count: number) {
    super(
      'FUNDAE_COMPANY_TIENE_GRUPOS_ACTIVOS',
      `La empresa ${companyId} no puede borrarse: tiene ${count} grupo(s) bonificable(s) activo(s).`,
    );
  }
}

export class RlptNotFoundError extends FundaeError {
  constructor(noticeId: string) {
    super('FUNDAE_RLPT_NOT_FOUND', `La notificación RLPT ${noticeId} no existe.`);
  }
}

export class RlptNotificacionInicialMissingError extends FundaeError {
  constructor(companyId: string) {
    super(
      'FUNDAE_RLPT_NOTIFICACION_INICIAL_MISSING',
      `La empresa ${companyId} no tiene una notificación inicial a la RLPT registrada; ` +
        'no se puede iniciar un grupo bonificable hasta hacerla y subir la evidencia.',
    );
  }
}

export class RlptPlazoNoCumplidoError extends FundaeError {
  constructor(companyId: string, plazoIso: string) {
    super(
      'FUNDAE_RLPT_PLAZO_NO_CUMPLIDO',
      `Aún no se cumplen los 15 días naturales de antelación a la RLPT ` +
        `(plazo: ${plazoIso}) para la empresa ${companyId}. Si hay discrepancia formalizada, registra el acta para autorizar el inicio.`,
    );
  }
}

export class GroupNotFoundError extends FundaeError {
  constructor(groupId: string) {
    super('FUNDAE_GROUP_NOT_FOUND', `El grupo bonificable ${groupId} no existe.`);
  }
}

export class GroupNumeroDuplicadoError extends FundaeError {
  constructor(numeroGrupo: number) {
    super(
      'FUNDAE_GROUP_NUMERO_DUPLICADO',
      `Ya existe un grupo con número ${numeroGrupo} en esta acción.`,
    );
  }
}

export class GroupTransicionInvalidaError extends FundaeError {
  constructor(from: string, to: string) {
    super('FUNDAE_GROUP_TRANSICION_INVALIDA', `No se puede pasar el grupo de "${from}" a "${to}".`);
  }
}

export class GroupCerradoError extends FundaeError {
  constructor(groupId: string) {
    super(
      'FUNDAE_GROUP_CERRADO',
      `El grupo ${groupId} está cerrado: no se pueden modificar costes ni metadatos.`,
    );
  }
}

export class CostNotFoundError extends FundaeError {
  constructor(costId: string) {
    super('FUNDAE_COST_NOT_FOUND', `El coste ${costId} no existe.`);
  }
}

export class CreditoInsuficienteError extends FundaeError {
  constructor(disponibleCents: number, requeridoCents: number) {
    super(
      'FUNDAE_CREDITO_INSUFICIENTE',
      `Crédito Fundae insuficiente: disponible ${(disponibleCents / 100).toFixed(2)} €, ` +
        `requerido ${(requeridoCents / 100).toFixed(2)} €.`,
    );
  }
}

export class GroupParticipantNotFoundError extends FundaeError {
  constructor(participantId: string) {
    super('FUNDAE_GROUP_PARTICIPANT_NOT_FOUND', `La matriculación ${participantId} no existe.`);
  }
}

export class GroupParticipantDuplicadoError extends FundaeError {
  constructor(userId: string, groupId: string) {
    super(
      'FUNDAE_GROUP_PARTICIPANT_DUPLICADO',
      `El usuario ${userId} ya está matriculado en el grupo ${groupId}.`,
    );
  }
}

export class GroupParticipantNotEnrolledInCourseError extends FundaeError {
  constructor(userId: string, courseId: string) {
    super(
      'FUNDAE_GROUP_PARTICIPANT_NOT_IN_COURSE',
      `El usuario ${userId} no está matriculado en el curso ${courseId} de la acción. ` +
        'Debe estar matriculado en el catálogo antes de añadirlo al grupo bonificable.',
    );
  }
}

export class GroupSinCursoError extends FundaeError {
  constructor(groupId: string) {
    super(
      'FUNDAE_GROUP_SIN_CURSO',
      `El grupo ${groupId} pertenece a una acción sin curso vinculado; ` +
        'no se puede hacer bulk-enroll desde el catálogo. Añade los participantes uno a uno.',
    );
  }
}
