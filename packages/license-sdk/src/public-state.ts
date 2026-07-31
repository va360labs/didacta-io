/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tipo serializable que el backend manda al frontend (sin secretos).
 *
 * Vive en archivo separado para que el backend pueda importarlo desde
 * `@didacta/license-sdk` sin arrastrar dependencias de React.
 */

import type { LicenseStatus } from './types.js';

export interface PublicLicenseState {
  status: LicenseStatus;
  edition?: 'community' | 'enterprise' | 'cloud';
  organizationName?: string;
  expiresAt?: string;
  capabilities: string[];
  warnings: string[];
}

import type { LicenseState } from './types.js';

/**
 * Convierte el estado interno (con el payload completo) en el estado público
 * que viaja al frontend. Sin secretos, sin claims internos.
 */
export function toPublicLicenseState(state: LicenseState): PublicLicenseState {
  return {
    status: state.status,
    edition: state.subject?.edition,
    organizationName: state.subject?.organizationName,
    expiresAt: state.subject?.expiresAt ? state.subject.expiresAt.toISOString() : undefined,
    capabilities: state.subject?.capabilities ?? [],
    warnings: state.warnings,
  };
}
