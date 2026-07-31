/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tipos del 8º piloto License SDK (`feat:sso.oidc`) — login federado OIDC.
 *
 * Spec referencia:
 *   - OIDC Core 1.0: https://openid.net/specs/openid-connect-core-1_0.html
 *   - OIDC Discovery 1.0: https://openid.net/specs/openid-connect-discovery-1_0.html
 *   - PKCE: RFC 7636.
 *
 * Scope DELIBERADAMENTE acotado en este piloto:
 *   - Solo Authorization Code + PKCE (single flow).
 *   - Solo 1 IdP per tenant (Okta / Azure AD / Auth0 / Google Workspace / Keycloak).
 *   - Sin discovery dinámico de userinfo extendido — usamos sólo claims del
 *     id_token (sub, email, name, email_verified).
 *   - Sin role mapping desde el IdP — todos los users provisioned automáticamente
 *     reciben role `student`. Los admins lo cambian luego en /admin/usuarios.
 *
 * Persistencia:
 *   - Config per-tenant en `tenant_setting` (module='sso', key='oidc.config',
 *     isSecret=true). El clientSecret se cifra con AES-256-GCM (mismo patrón
 *     que SMTP credentials, Zoom secrets, etc.).
 *   - State del flow OIDC en memoria (Map con TTL 10min). Suficiente para
 *     piloto monoinstance. TODO follow-up: migrar a Redis para multi-instance.
 */

/** Persistencia de la config OIDC dentro de `tenant_setting`. */
export const OIDC_CONFIG_MODULE_NAME = 'sso';
export const OIDC_CONFIG_KEY = 'oidc.config';

/**
 * Config OIDC persistida por tenant. NUNCA se serializa al cliente HTTP en su
 * forma cruda — el admin endpoint la sanitiza (oculta clientSecret) antes de
 * devolverla.
 */
export interface TenantOidcConfig {
  /** Si false, /auth/oidc/:slug/start devuelve 404. */
  enabled: boolean;
  /** URL HTTPS del issuer (sin trailing slash; OIDC Discovery agrega /.well-known). */
  issuer: string;
  /** Client ID emitido por el IdP. */
  clientId: string;
  /** Client secret EN CLARO. Sólo se devuelve descifrado por tenantConfig.get(). */
  clientSecret: string;
  /**
   * Lista de domains permitidos (lowercase, sin @). Si vacía, cualquier email
   * pasa. Si tiene entradas, el email del id_token DEBE pertenecer a uno de
   * estos domains o el callback rechaza el login.
   */
  allowedEmailDomains: string[];
  /**
   * Si true, crear users automáticamente al primer login (role 'student').
   * Si false, sólo permite login a users que YA existen en el tenant.
   */
  autoProvisionUsers: boolean;
  /** Scopes solicitados al IdP. Default ['openid', 'email', 'profile']. */
  scopes: string[];
  /** ISO timestamp creación. */
  createdAt: string;
  /** ISO timestamp último update. */
  updatedAt: string;
}

/**
 * Vista de la config sin secret para devolver al admin desde GET /admin/sso/oidc/config.
 * `hasSecret` indica si hay un clientSecret persistido (para que el admin
 * sepa si tiene que escribir uno nuevo o si ya hay uno guardado).
 */
export interface SafeOidcConfigView {
  enabled: boolean;
  issuer: string;
  clientId: string;
  /** True si hay un clientSecret persistido. NUNCA devolvemos el plaintext. */
  hasSecret: boolean;
  allowedEmailDomains: string[];
  autoProvisionUsers: boolean;
  scopes: string[];
  /** URL del callback configurada en este servidor — el admin la copia al panel del IdP. */
  redirectUri: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * State efímero del flow OIDC. Lo guardamos in-memory mapeado por `state`
 * (random 32 bytes b64url). Cuando llega el callback, recuperamos el state
 * por la query param y validamos.
 *
 * TTL 10 minutos: si el usuario tarda más entre el redirect al IdP y la
 * respuesta del callback, abortamos. Window razonable considerando el
 * tiempo necesario para login + MFA en el IdP.
 */
export interface OidcFlowState {
  /** UUID de tenant resuelto al iniciar el flow. */
  tenantId: string;
  /** Slug del tenant (para devolverlo en el redirect final). */
  tenantSlug: string;
  /** Nonce que pondremos en la authorization URL y validaremos en id_token. */
  nonce: string;
  /** Code verifier de PKCE (S256). */
  codeVerifier: string;
  /** Issuer URL (para detectar si el admin cambió la config a mitad de flow). */
  issuer: string;
  /** Client ID (idem). */
  clientId: string;
  /** Timestamp ms de expiración (epoch ms). */
  expiresAt: number;
  /** ISO timestamp inicio del flow (sólo para audit). */
  startedAt: string;
}

/**
 * Resultado de testDiscovery — el admin lo ve en el panel para confirmar que
 * el issuer URL es correcto antes de guardar la config.
 */
export type OidcDiscoveryProbe =
  | {
      ok: true;
      authorizationEndpoint: string;
      tokenEndpoint: string;
      jwksUri: string;
      issuer: string;
    }
  | {
      ok: false;
      error: string;
    };
