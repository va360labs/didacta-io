'use client';

/**
 * Cliente HTTP del endpoint admin de tokens SCIM (séptimo piloto License SDK).
 *
 * Backend: `apps/api/src/admin/scim/scim-admin.controller.ts`. Los endpoints
 * /scim/v2/* (que consumen los IdPs) NO son consumidos por el frontend — los
 * llama el IdP directamente con su Bearer token.
 *
 * El token plano sólo se devuelve UNA SOLA VEZ tras `create()`; el panel debe
 * mostrarlo en un modal y avisar al usuario que lo copie YA. Despúes solo
 * tenemos `prefix` para identificar visualmente cuál token está activo.
 */

import { apiFetch } from './api-client';

export interface ScimTokenStatusInactive {
  active: false;
}

export interface ScimTokenStatusActive {
  active: true;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type ScimTokenStatus = ScimTokenStatusInactive | ScimTokenStatusActive;

export interface ScimTokenCreated {
  /** Token plano. SOLO disponible ahora — guardarlo en el panel del IdP. */
  token: string;
  /** Primeros 13 chars (prefijo "scim_" + 8 chars del hash) para identificación visual. */
  prefix: string;
  createdAt: string;
  warning: string;
}

export interface ScimTokenRevoked {
  revoked: boolean;
  prefix?: string;
  message?: string;
}

const BASE = '/api/v1/admin/scim/token';

export const scimTokenApi = {
  async status(bearer: string): Promise<ScimTokenStatus> {
    return apiFetch<ScimTokenStatus>(BASE, { method: 'GET' }, bearer);
  },
  async create(bearer: string): Promise<ScimTokenCreated> {
    return apiFetch<ScimTokenCreated>(BASE, { method: 'POST' }, bearer);
  },
  async revoke(bearer: string): Promise<ScimTokenRevoked> {
    return apiFetch<ScimTokenRevoked>(BASE, { method: 'DELETE' }, bearer);
  },
};
