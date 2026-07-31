'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cliente HTTP para la política MFA tenant-wide.
 *
 * Backend: `apps/api/src/auth/mfa-policy/`. La capability EE
 * `feat:mfa.enforcement` gatea solo el PUT (mutación). El GET es siempre
 * accesible para super_admin / tenant_admin — el frontend lo usa para pintar
 * el panel incluso en plan community (con upsell card).
 */

import { apiFetch } from './api-client';

export interface MfaPolicy {
  /** Si true, todos los usuarios del tenant deben tener MFA configurado. */
  requiredForAll: boolean;
  /** Días que tienen los usuarios para configurar MFA tras un cambio de política. */
  gracePeriodDays: number;
  /** Timestamp ISO del último cambio. Marca el inicio del grace period. */
  updatedAt: string;
  /** ID del usuario que hizo el último cambio (audit minimal). */
  updatedBy: string | null;
}

export interface MfaPolicyState {
  policy: MfaPolicy;
  /** True si la capability EE está activa AND la política tiene `requiredForAll=true`. */
  enforcementActive: boolean;
  /** Capability requerida (`feat:mfa.enforcement`). */
  capability: string;
  /** True si el tenant tiene una licencia EE activa con la capability. */
  licensed: boolean;
}

export interface UpdateMfaPolicyDto {
  requiredForAll: boolean;
  gracePeriodDays: number;
}

export const mfaPolicyApi = {
  async get(bearer: string): Promise<MfaPolicyState> {
    return apiFetch<MfaPolicyState>('/api/v1/admin/mfa-policy', { method: 'GET' }, bearer);
  },
  async update(bearer: string, dto: UpdateMfaPolicyDto): Promise<MfaPolicyState> {
    return apiFetch<MfaPolicyState>(
      '/api/v1/admin/mfa-policy',
      { method: 'PUT', body: JSON.stringify(dto) },
      bearer,
    );
  },
};

/** Valores recomendados para el selector de grace period. */
export const MFA_GRACE_PERIOD_OPTIONS_DAYS = [1, 3, 7, 14, 30] as const;
