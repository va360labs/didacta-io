/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tipos compartidos del módulo `mfa-policy` (tercer piloto License SDK).
 *
 * El backend persiste la política tenant-wide en `tenant_setting` con
 * `module_name='auth'`, `key='mfa-policy'`, `is_secret=false`. Lo expone vía
 * GET/PUT /api/v1/admin/mfa-policy. El PUT está gateado por la capability
 * `feat:mfa.enforcement`; sin licencia EE → 402 Payment Required.
 *
 * En plan community (sin la capability) seguimos forzando MFA por rol
 * (`super_admin`, `tenant_admin`) — eso ya funciona desde LMS-109. Lo único
 * que aporta esta capability es **forzar MFA al resto del tenant**:
 * formadores, alumnos, managers.
 */

export const MFA_POLICY_MODULE_NAME = 'auth';
export const MFA_POLICY_KEY = 'mfa-policy';

/** Valores aceptados para el grace period (días) ofrecidos al admin. */
export const MFA_GRACE_PERIOD_OPTIONS_DAYS = [1, 3, 7, 14, 30] as const;
export type MfaGracePeriodOption = (typeof MFA_GRACE_PERIOD_OPTIONS_DAYS)[number];

/**
 * Estado persistido de la política tenant-wide.
 *
 * - `requiredForAll`: si true, todos los usuarios del tenant deben tener MFA
 *   configurado. Aplica solo cuando la capability EE está activa; si la
 *   licencia se revoca o expira, el enforcement queda inerte (failsafe vía
 *   `LicenseService.isCapabilityEnabled`).
 * - `gracePeriodDays`: días que tienen los usuarios para configurar MFA
 *   contados desde `updatedAt`. Pasado ese plazo, el login se bloquea con
 *   `MfaRequiredByTenantPolicyError` mientras no tengan MFA habilitado.
 * - `updatedAt`: timestamp ISO del último cambio. Marca el inicio del grace.
 * - `updatedBy`: userId que hizo el cambio (audit minimal sin FK cross-module).
 */
export interface MfaPolicyState {
  requiredForAll: boolean;
  gracePeriodDays: number;
  updatedAt: string;
  updatedBy: string | null;
}

/** Política por defecto cuando el tenant aún no ha configurado nada. */
export function defaultMfaPolicy(now: Date = new Date()): MfaPolicyState {
  return {
    requiredForAll: false,
    gracePeriodDays: 7,
    updatedAt: now.toISOString(),
    updatedBy: null,
  };
}

/**
 * Resultado de evaluar la política contra un usuario concreto en el momento
 * del login. El AuthService lo usa para decidir si permite, marca o bloquea.
 *
 * - `outcome === 'allow'`: login normal (política off, capability inactiva,
 *   o usuario ya tiene MFA habilitado).
 * - `outcome === 'warn'`: usuario sin MFA pero dentro del grace period.
 *   Se le permite entrar pero el cliente recibe `mfaRequiredSoon=true` para
 *   mostrarle el aviso.
 * - `outcome === 'block'`: usuario sin MFA fuera del grace period. El
 *   AuthService lanza `MfaRequiredByTenantPolicyError` (401 con código
 *   `mfa_required_by_tenant_policy` y URL de setup).
 */
export type MfaPolicyOutcome =
  | { outcome: 'allow' }
  | {
      outcome: 'warn';
      gracePeriodDays: number;
      gracePeriodExpiresAt: string;
      setupUrl: string;
    }
  | {
      outcome: 'block';
      gracePeriodDays: number;
      gracePeriodExpiredAt: string;
      setupUrl: string;
    };
