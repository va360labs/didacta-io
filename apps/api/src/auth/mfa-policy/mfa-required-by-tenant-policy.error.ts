/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Error específico para cuando la política tenant-wide MFA fuerza al usuario
 * a configurar segundo factor y ya pasó el grace period.
 *
 * El cliente lo distingue por el campo `code: 'mfa_required_by_tenant_policy'`
 * en el body de la respuesta 401, para mostrar un flujo guiado de setup en
 * vez de un toast genérico de credenciales inválidas.
 */

import { UnauthorizedException } from '@nestjs/common';

export interface MfaRequiredByTenantPolicyDetails {
  /** Días que tenía el usuario para configurar MFA (desde el cambio de política). */
  gracePeriodDays: number;
  /** Timestamp ISO en el que expiró el grace para este tenant. */
  gracePeriodExpiredAt: string;
  /** URL relativa donde el usuario debe ir a configurar MFA. */
  setupUrl: string;
}

export class MfaRequiredByTenantPolicyError extends UnauthorizedException {
  constructor(public readonly details: MfaRequiredByTenantPolicyDetails) {
    super({
      message:
        'Tu organización requiere MFA. El periodo de gracia ya expiró. ' +
        'Configura tu segundo factor para continuar.',
      code: 'mfa_required_by_tenant_policy',
      gracePeriodDays: details.gracePeriodDays,
      gracePeriodExpiredAt: details.gracePeriodExpiredAt,
      setupUrl: details.setupUrl,
    });
  }
}
