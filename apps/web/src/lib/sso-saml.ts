'use client';

/**
 * Cliente HTTP del 9º piloto License SDK (`feat:sso.saml`).
 *
 * Cubre:
 *   - Endpoints admin (/api/v1/admin/sso/saml/*) — JWT + capability EE.
 *   - Endpoint público de status (/api/v1/auth/saml/:tenantSlug/status) — sin
 *     auth, lo consume el form de signin para saber si pintar el botón SSO SAML.
 *
 * Mismo patrón que `lib/sso.ts`: tipos discriminados, manejo de 402 vía
 * ApiHttpError (status === 402 ⇒ capability faltante, mostrar upsell).
 */

import { apiFetch } from './api-client';

export interface SamlAttributeMapping {
  email: string;
  firstName?: string;
  lastName?: string;
}

export interface SamlSafeConfig {
  enabled: boolean;
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertificate: string;
  attributeMapping: SamlAttributeMapping;
  allowedEmailDomains: string[];
  autoProvisionUsers: boolean;
  spEntityId: string;
  spAcsUrl: string;
  spMetadataUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface SamlSpInfo {
  entityId: string;
  acsUrl: string;
  metadataUrl: string;
}

export interface SamlConfigResponseExisting {
  exists: true;
  config: SamlSafeConfig;
  capability?: string;
}

export interface SamlConfigResponseEmpty {
  exists: false;
  sp: SamlSpInfo;
  capability?: string;
}

export type SamlConfigResponse = SamlConfigResponseExisting | SamlConfigResponseEmpty;

export interface SamlConfigPutBody {
  enabled: boolean;
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertificate: string;
  attributeMapping: SamlAttributeMapping;
  allowedEmailDomains: string[];
  autoProvisionUsers: boolean;
}

export type SamlConnectionProbe =
  | {
      ok: true;
      certSubject?: string;
      certNotAfter?: string;
      certSignatureAlgorithm?: string;
    }
  | { ok: false; error: string };

export interface SamlStatusResponse {
  enabled: boolean;
}

const ADMIN_BASE = '/api/v1/admin/sso/saml';

export const samlAdminApi = {
  async getConfig(bearer: string): Promise<SamlConfigResponse> {
    return apiFetch<SamlConfigResponse>(`${ADMIN_BASE}/config`, { method: 'GET' }, bearer);
  },

  async saveConfig(bearer: string, body: SamlConfigPutBody): Promise<SamlConfigResponseExisting> {
    return apiFetch<SamlConfigResponseExisting>(
      `${ADMIN_BASE}/config`,
      { method: 'PUT', body: JSON.stringify(body) },
      bearer,
    );
  },

  async deleteConfig(bearer: string): Promise<{ deleted: boolean }> {
    return apiFetch<{ deleted: boolean }>(`${ADMIN_BASE}/config`, { method: 'DELETE' }, bearer);
  },

  async testConnection(
    bearer: string,
    idpSsoUrl: string,
    idpCertificate: string,
  ): Promise<SamlConnectionProbe> {
    return apiFetch<SamlConnectionProbe>(
      `${ADMIN_BASE}/test-connection`,
      { method: 'POST', body: JSON.stringify({ idpSsoUrl, idpCertificate }) },
      bearer,
    );
  },
};

export async function fetchSamlStatus(tenantSlug: string): Promise<SamlStatusResponse> {
  try {
    return await apiFetch<SamlStatusResponse>(
      `/api/v1/auth/saml/${encodeURIComponent(tenantSlug)}/status`,
      { method: 'GET' },
    );
  } catch {
    return { enabled: false };
  }
}

/**
 * URL completa para iniciar el flow SAML. El click del botón de signin hace
 * `window.location.href = ...` para que el navegador siga el redirect 302
 * del backend al IdP. NO usar fetch — el navegador necesita seguir cookies
 * del IdP.
 */
export function buildSamlLoginUrl(tenantSlug: string): string {
  return `/api/v1/auth/saml/${encodeURIComponent(tenantSlug)}/login`;
}
