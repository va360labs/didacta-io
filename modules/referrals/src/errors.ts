/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Errores del dominio mod.referrals.
 *
 * Heredan de ReferralsError para que el filtro de NestJS
 * (apps/api/src/modules/referrals/referrals-error.filter.ts) los mapee a HTTP
 * con códigos estables.
 */

export class ReferralsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ReferralsError';
  }
}

/** El programa no está activo para el tenant (config.active = false). */
export class ReferralsProgramInactiveError extends ReferralsError {
  constructor() {
    super('El programa de referidos no está activo.', 'REFERRALS_PROGRAM_INACTIVE');
    this.name = 'ReferralsProgramInactiveError';
  }
}

/** El referidor no cumple el requisito de membresía activa para participar. */
export class ReferralsMembershipRequiredError extends ReferralsError {
  constructor() {
    super(
      'Necesitas una membresía activa para participar en el programa de referidos.',
      'REFERRALS_MEMBERSHIP_REQUIRED',
    );
    this.name = 'ReferralsMembershipRequiredError';
  }
}

export class ReferralsCommissionNotFoundError extends ReferralsError {
  constructor(id: string) {
    super(`Comisión no encontrada: ${id}`, 'REFERRALS_COMMISSION_NOT_FOUND');
    this.name = 'ReferralsCommissionNotFoundError';
  }
}

/** Transición de estado inválida (p.ej. revocar una comisión ya pagada). */
export class ReferralsCommissionStateError extends ReferralsError {
  constructor(message: string) {
    super(message, 'REFERRALS_COMMISSION_STATE');
    this.name = 'ReferralsCommissionStateError';
  }
}

/** La liquidación no cumple las reglas (mínimo, lote inválido, moneda mixta…). */
export class ReferralsPayoutValidationError extends ReferralsError {
  constructor(message: string) {
    super(message, 'REFERRALS_PAYOUT_INVALID');
    this.name = 'ReferralsPayoutValidationError';
  }
}

/** Config con valores fuera de rango (la validación de forma la hace zod en el host). */
export class ReferralsConfigValidationError extends ReferralsError {
  constructor(message: string) {
    super(message, 'REFERRALS_CONFIG_INVALID');
    this.name = 'ReferralsConfigValidationError';
  }
}
