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

/**
 * Opciones de un error de dominio. `detail` es el dato que el `message` español
 * lleva incrustado y que el catálogo inglés se tragaba al traducir por `code`:
 * viaja como campo APARTE hasta el front. Contrato completo en
 * `apps/api/src/common/module-error-body.ts`.
 */
export interface ReferralsErrorOptions {
  readonly detail?: string;
}

export class ReferralsError extends Error {
  readonly detail?: string;

  constructor(
    message: string,
    public readonly code: string,
    options?: ReferralsErrorOptions,
  ) {
    super(message);
    this.name = 'ReferralsError';
    this.detail = options?.detail;
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
    super(`Comisión no encontrada: ${id}`, 'REFERRALS_COMMISSION_NOT_FOUND', { detail: id });
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

/** El creador apagó el canje como descuento en la cuota. */
export class ReferralsCreditDisabledError extends ReferralsError {
  constructor() {
    super(
      'En esta academia lo ganado no se puede usar como descuento en la cuota.',
      'REFERRALS_CREDIT_DISABLED',
    );
    this.name = 'ReferralsCreditDisabledError';
  }
}

/** No hay nada que canjear: sin comisiones aprobadas o ya tiene el máximo a favor. */
export class ReferralsCreditNothingError extends ReferralsError {
  constructor() {
    super(
      'Ahora mismo no tienes nada que usar como descuento en tu próxima cuota.',
      'REFERRALS_CREDIT_NOTHING',
    );
    this.name = 'ReferralsCreditNothingError';
  }
}

/** El aula no tiene Stripe para abonar (instancia sin pagos configurados). */
export class ReferralsCreditUnavailableError extends ReferralsError {
  constructor() {
    super(
      'El descuento en la cuota no está disponible en esta academia.',
      'REFERRALS_CREDIT_UNAVAILABLE',
    );
    this.name = 'ReferralsCreditUnavailableError';
  }
}

/** Stripe no confirmó el abono. Reintentar es seguro: misma clave, mismo importe. */
export class ReferralsCreditFailedError extends ReferralsError {
  constructor() {
    super(
      'No hemos podido aplicar el descuento. Vuelve a intentarlo: no se aplicará dos veces.',
      'REFERRALS_CREDIT_FAILED',
    );
    this.name = 'ReferralsCreditFailedError';
  }
}
