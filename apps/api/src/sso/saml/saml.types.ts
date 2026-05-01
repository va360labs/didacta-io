/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tipos del 9º piloto License SDK (`feat:sso.saml`) — login federado SAML 2.0.
 *
 * Spec referencia:
 *   - SAML 2.0 Core: https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf
 *   - SAML 2.0 Bindings: https://docs.oasis-open.org/security/saml/v2.0/saml-bindings-2.0-os.pdf
 *
 * Scope DELIBERADAMENTE acotado en este piloto (paralelo al OIDC):
 *   - Solo SP-initiated SSO (Web Browser SSO Profile).
 *   - Solo bindings HTTP-Redirect (AuthnRequest) + HTTP-POST (Response).
 *   - Solo 1 IdP per tenant.
 *   - SP NO firma AuthnRequest (depende del IdP). Roadmap futuro: cert SP signing.
 *   - Sin role mapping desde el IdP — todos los users provisioned automáticamente
 *     reciben role `student`.
 *
 * Persistencia:
 *   - Config per-tenant en `tenant_setting` (module='sso', key='saml.config').
 *   - El IdP cert (X.509 PEM) NO es secreto (es público por diseño SAML), así
 *     que NO se cifra at-rest. Para uniformidad mantenemos el storage `isSecret:
 *     false`. Si en una versión futura añadimos SP signing key, esa SÍ se cifrará.
 *   - State del flow (RelayState) en memoria con TTL 10 min, igual que OIDC.
 */

/** Persistencia de la config SAML dentro de `tenant_setting`. */
export const SAML_CONFIG_MODULE_NAME = 'sso';
export const SAML_CONFIG_KEY = 'saml.config';

/**
 * Mapeo de attributes SAML → campos del usuario. El admin lo configura porque
 * cada IdP nombra los attributes diferente. Defaults razonables que cubren la
 * mayoría de IdPs (Okta, Azure AD, Auth0, OneLogin, ADFS).
 */
export interface SamlAttributeMapping {
  /** Attribute SAML que contiene el email del usuario. Obligatorio. */
  email: string;
  /** Attribute con first name. Si vacío, no se setea. */
  firstName?: string;
  /** Attribute con last name. Si vacío, no se setea. */
  lastName?: string;
}

/** Attribute names más comunes — usados como defaults en la UI. */
export const COMMON_SAML_ATTRIBUTES = {
  EMAIL: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  FIRST_NAME: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
  LAST_NAME: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
} as const;

/**
 * Config SAML persistida por tenant. NUNCA se serializa al cliente HTTP en su
 * forma cruda — el admin endpoint la sanitiza (oculta el cert si es muy largo)
 * antes de devolverla.
 */
export interface TenantSamlConfig {
  /** Si false, /auth/saml/:slug/login devuelve 404. */
  enabled: boolean;
  /** EntityID del IdP (URN o URL único que identifica al IdP). */
  idpEntityId: string;
  /** URL del SSO endpoint del IdP donde redirigimos al usuario para login. */
  idpSsoUrl: string;
  /** X.509 cert PEM del IdP (público, usado para validar firmas de SAMLResponse). */
  idpCertificate: string;
  /**
   * Mapeo de attributes del Assertion → campos user. Si los attributes no llegan
   * con esos nombres en la SAMLResponse, el callback rechaza el login.
   */
  attributeMapping: SamlAttributeMapping;
  /**
   * Lista de domains permitidos (lowercase, sin @). Si vacía, cualquier email
   * pasa. Si tiene entradas, el email del Assertion DEBE pertenecer a uno.
   */
  allowedEmailDomains: string[];
  /**
   * Si true, crear users automáticamente al primer login (role 'student').
   * Si false, sólo permite login a users que YA existen en el tenant.
   */
  autoProvisionUsers: boolean;
  /** ISO timestamp creación. */
  createdAt: string;
  /** ISO timestamp último update. */
  updatedAt: string;
}

/**
 * Vista de la config para devolver al admin desde GET /admin/sso/saml/config.
 * Incluye el cert completo (es público) — pero la UI lo oculta tras "mostrar
 * cert" para no llenar la pantalla. SP entityId + ACS URL se devuelven aquí
 * porque el admin los necesita para configurar el IdP.
 */
export interface SafeSamlConfigView {
  enabled: boolean;
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertificate: string;
  attributeMapping: SamlAttributeMapping;
  allowedEmailDomains: string[];
  autoProvisionUsers: boolean;
  /** EntityID del SP (Didacta) — el admin lo copia al IdP. */
  spEntityId: string;
  /** ACS URL del SP (Didacta) — el admin lo copia al IdP. */
  spAcsUrl: string;
  /** URL del metadata SP — alternativa cómoda para IdPs que importan metadata. */
  spMetadataUrl: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * State efímero del flow SAML. Lo guardamos in-memory mapeado por `relayState`
 * (random 32 bytes b64url). Cuando llega el ACS callback con RelayState, lo
 * recuperamos y validamos.
 *
 * TTL 10 minutos: ventana razonable considerando login + MFA en el IdP.
 */
export interface SamlFlowState {
  /** UUID de tenant resuelto al iniciar el flow. */
  tenantId: string;
  /** Slug del tenant (para devolverlo en el redirect final). */
  tenantSlug: string;
  /** EntityID del IdP cuando el flow inició (defensa cambio config a mitad de flow). */
  idpEntityId: string;
  /** ID del AuthnRequest (validamos InResponseTo en la SAMLResponse). */
  requestId: string;
  /** Timestamp ms de expiración (epoch ms). */
  expiresAt: number;
  /** ISO timestamp inicio del flow (sólo para audit). */
  startedAt: string;
}

/**
 * Resultado de testConnection — el admin lo ve en el panel para confirmar
 * que el cert + sso URL son sintácticamente válidos antes de guardar.
 *
 * NO hace una llamada real al IdP (a diferencia de OIDC discovery): SAML no
 * tiene un endpoint de discovery estandarizado y consultable sin AuthnRequest.
 * Sólo valida formato del cert PEM y URL.
 */
export type SamlConnectionProbe =
  | {
      ok: true;
      /** Common name del cert (si lo trae). */
      certSubject?: string;
      /** ISO timestamp de validez del cert. */
      certNotAfter?: string;
      /** Algoritmo de firma del cert (SHA-256, etc.). */
      certSignatureAlgorithm?: string;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * Resultado interno parsea un SAMLResponse válido.
 */
export interface ParsedSamlAssertion {
  /** NameID del subject (típicamente email o un ID opaco). */
  nameId: string;
  /** Atributos planos extraídos del Assertion. */
  attributes: Record<string, string | string[]>;
  /** ID del Response (para audit). */
  responseId: string;
  /** InResponseTo del Response (debe matchear nuestro requestId). */
  inResponseTo?: string;
  /** Issuer declarado en el Response (debe matchear idpEntityId). */
  issuer: string;
}
