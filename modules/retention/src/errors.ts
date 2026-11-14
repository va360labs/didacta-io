/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Errores de dominio de mod.retention. El host los mapea a HTTP por `code` en
 * `apps/api/src/modules/retention/retention-error.filter.ts`. `detail` lleva
 * el dato (la variable que no existe…) aparte del `message` español, para que
 * cada idioma de la web escriba su frase con él.
 */
export class RetentionError extends Error {
  readonly detail?: string;

  constructor(
    message: string,
    public readonly code: string,
    options?: { detail?: string },
  ) {
    super(message);
    this.name = 'RetentionError';
    this.detail = options?.detail;
  }
}

export class RetentionAutomationNotFoundError extends RetentionError {
  constructor() {
    super('Mensaje automático no encontrado.', 'RETENTION_AUTOMATION_NOT_FOUND');
    this.name = 'RetentionAutomationNotFoundError';
  }
}

export class RetentionTemplateNotFoundError extends RetentionError {
  constructor() {
    super('No existe esa plantilla.', 'RETENTION_TEMPLATE_NOT_FOUND');
    this.name = 'RetentionTemplateNotFoundError';
  }
}

/** Texto vacío o más largo de lo que admite un mensaje directo. */
export class RetentionBodyInvalidError extends RetentionError {
  constructor() {
    super('Escribe el mensaje (entre 1 y 4.000 caracteres).', 'RETENTION_BODY_INVALID');
    this.name = 'RetentionBodyInvalidError';
  }
}

/** `{algo}` que no es ninguna de las variables que se pueden usar. */
export class RetentionUnknownVariableError extends RetentionError {
  constructor(tokens: string[]) {
    const list = tokens.map((t) => `{${t}}`).join(', ');
    super(`Variable desconocida: ${list}`, 'RETENTION_UNKNOWN_VARIABLE', { detail: list });
    this.name = 'RetentionUnknownVariableError';
  }
}

/** Una variable que existe pero no tiene valor en este tipo de mensaje. */
export class RetentionVariableNotAvailableError extends RetentionError {
  constructor(token: string) {
    super(
      `La variable {${token}} no se puede usar en este mensaje.`,
      'RETENTION_VARIABLE_NOT_AVAILABLE',
      { detail: `{${token}}` },
    );
    this.name = 'RetentionVariableNotAvailableError';
  }
}

export class RetentionDaysInvalidError extends RetentionError {
  constructor() {
    super('El número de días no es válido para este mensaje.', 'RETENTION_DAYS_INVALID');
    this.name = 'RetentionDaysInvalidError';
  }
}

export class RetentionSubjectInvalidError extends RetentionError {
  constructor() {
    super('El asunto del correo admite hasta 200 caracteres.', 'RETENTION_SUBJECT_INVALID');
    this.name = 'RetentionSubjectInvalidError';
  }
}

export class RetentionSettingsInvalidError extends RetentionError {
  constructor() {
    super(
      'Ajustes no válidos: revisa la franja horaria y las horas de espera.',
      'RETENTION_SETTINGS_INVALID',
    );
    this.name = 'RetentionSettingsInvalidError';
  }
}

/** Quien firma los mensajes tiene que ser del equipo del aula. */
export class RetentionSenderInvalidError extends RetentionError {
  constructor() {
    super(
      'Los mensajes solo los puede firmar alguien del equipo del aula.',
      'RETENTION_SENDER_INVALID',
    );
    this.name = 'RetentionSenderInvalidError';
  }
}

/** «Añadir a recuperación» sin un mensaje de recuperación activo. */
export class RetentionRecoveryNotConfiguredError extends RetentionError {
  constructor() {
    super(
      'Activa primero el mensaje de recuperación («Si no entra en X días»).',
      'RETENTION_RECOVERY_NOT_CONFIGURED',
    );
    this.name = 'RetentionRecoveryNotConfiguredError';
  }
}

/** La persona no es un miembro al que se le pueda escribir (equipo, baja…). */
export class RetentionMemberNotEligibleError extends RetentionError {
  constructor() {
    super('A esta persona no se le envían mensajes automáticos.', 'RETENTION_MEMBER_NOT_ELIGIBLE');
    this.name = 'RetentionMemberNotEligibleError';
  }
}
