'use client';

/**
 * Cliente HTTP del 8º piloto License SDK (`feat:sso.oidc`).
 *
 * Cubre:
 *   - Endpoints admin (/api/v1/admin/sso/oidc/*) — requieren JWT + capability EE.
 *   - Endpoint público de status (/api/v1/auth/oidc/:tenantSlug/status) — sin
 *     auth, lo consume el form de signin para saber si pintar el botón SSO.
 *
 * Mismo patrón que `lib/scim.ts`: tipos discriminados, manejo de 402 vía
 * ApiHttpError (status === 402 ⇒ capability faltante, mostrar upsell).
 */

import { apiFetch } from './api-client';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/**
 * Vista safe de la config OIDC (sin clientSecret). Coincide con SafeOidcConfigView
 * del backend (`apps/api/src/sso/oidc/oidc.types.ts`).
 */
export interface OidcSafeConfig {
  enabled: boolean;
  issuer: string;
  clientId: string;
  /** True si hay clientSecret guardado. Nunca devuelve el plaintext. */
  hasSecret: boolean;
  allowedEmailDomains: string[];
  autoProvisionUsers: boolean;
  scopes: string[];
  /** URL de callback que el admin debe pegar en el panel del IdP. */
  redirectUri: string;
  createdAt: string;
  updatedAt: string;
}

export interface OidcConfigResponseExisting {
  exists: true;
  config: OidcSafeConfig;
  capability?: string;
}

export interface OidcConfigResponseEmpty {
  exists: false;
  /** URL de callback computada — el panel la muestra readonly desde el inicio. */
  redirectUri: string;
  capability?: string;
}

export type OidcConfigResponse = OidcConfigResponseExisting | OidcConfigResponseEmpty;

/**
 * DTO PUT (todos los campos requeridos por el backend salvo clientSecret, que
 * sólo se manda si el admin lo está rotando).
 */
export interface OidcConfigPutBody {
  enabled: boolean;
  issuer: string;
  clientId: string;
  /** Plaintext. Sólo enviar si se está creando o rotando — null/undefined preserva el guardado. */
  clientSecret?: string | null;
  allowedEmailDomains: string[];
  autoProvisionUsers: boolean;
  scopes: string[];
}

export type OidcDiscoveryProbe =
  | {
      ok: true;
      authorizationEndpoint: string;
      tokenEndpoint: string;
      jwksUri: string;
      issuer: string;
    }
  | { ok: false; error: string };

export interface OidcStatusResponse {
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// API admin
// ---------------------------------------------------------------------------

const ADMIN_BASE = '/api/v1/admin/sso/oidc';

export const oidcAdminApi = {
  async getConfig(bearer: string): Promise<OidcConfigResponse> {
    return apiFetch<OidcConfigResponse>(`${ADMIN_BASE}/config`, { method: 'GET' }, bearer);
  },

  async saveConfig(bearer: string, body: OidcConfigPutBody): Promise<OidcConfigResponseExisting> {
    return apiFetch<OidcConfigResponseExisting>(
      `${ADMIN_BASE}/config`,
      { method: 'PUT', body: JSON.stringify(body) },
      bearer,
    );
  },

  async deleteConfig(bearer: string): Promise<{ deleted: boolean }> {
    return apiFetch<{ deleted: boolean }>(`${ADMIN_BASE}/config`, { method: 'DELETE' }, bearer);
  },

  async testDiscovery(bearer: string, issuer: string): Promise<OidcDiscoveryProbe> {
    return apiFetch<OidcDiscoveryProbe>(
      `${ADMIN_BASE}/test-discovery`,
      { method: 'POST', body: JSON.stringify({ issuer }) },
      bearer,
    );
  },
};

// ---------------------------------------------------------------------------
// API pública (status del tenant — para signin)
// ---------------------------------------------------------------------------

/**
 * Devuelve `{ enabled: boolean }` sin exponer config — el form de signin lo
 * usa para decidir si pintar el botón "Iniciar sesión con SSO".
 *
 * No throws: si el endpoint no existe o el tenant no se encuentra, devuelve
 * `{ enabled: false }` para no romper el flujo de signin clásico.
 */
export async function fetchOidcStatus(tenantSlug: string): Promise<OidcStatusResponse> {
  try {
    return await apiFetch<OidcStatusResponse>(
      `/api/v1/auth/oidc/${encodeURIComponent(tenantSlug)}/status`,
      { method: 'GET' },
    );
  } catch {
    return { enabled: false };
  }
}

/**
 * URL completa para iniciar el flow OIDC. El click del botón de signin hace
 * `window.location.href = ...` para que el navegador siga el redirect 302
 * del backend al IdP. NO usar fetch — el navegador necesita seguir cookies
 * del IdP.
 */
export function buildOidcStartUrl(tenantSlug: string): string {
  return `/api/v1/auth/oidc/${encodeURIComponent(tenantSlug)}/start`;
}

// ---------------------------------------------------------------------------
// WordPress SSO (mod.wp-sso) — status público + bounce transparente
// ---------------------------------------------------------------------------

/** Config pública de WP-SSO. Coincide con `WpSsoService.ssoConfig()` del backend. */
export interface WpSsoStatus {
  configured: boolean;
  /** Si el signin debe rebotar a WordPress en modo `try` cuando no hay sesión. */
  autoRedirect: boolean;
  /** URL del WordPress origen (home_url) — destino del bounce. */
  wordpressUrl: string | null;
}

/**
 * Estado del SSO de WordPress (público, sin auth). El signin lo usa para decidir
 * el auto-bounce transparente. No throws: ante cualquier fallo devuelve apagado
 * para no romper el login clásico.
 */
export async function fetchWpSsoStatus(): Promise<WpSsoStatus> {
  try {
    return await apiFetch<WpSsoStatus>('/api/v1/modules/wp-sso/status', { method: 'GET' });
  } catch {
    return { configured: false, autoRedirect: false, wordpressUrl: null };
  }
}

/**
 * URL de bounce TRANSPARENTE: lleva al WordPress en modo `try`. Si hay sesión WP,
 * vuelve autenticado al callback; si no, el plugin devuelve EN SILENCIO a la
 * signin con `?wp_sso=login_required` (sin mostrar wp-login).
 */
export function buildWpSsoTryUrl(wordpressUrl: string): string {
  return `${wordpressUrl.replace(/\/+$/, '')}/?didacta_sso=try`;
}
