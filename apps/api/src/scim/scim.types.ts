/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tipos del schema SCIM 2.0 estándar (séptimo piloto License SDK).
 *
 * Spec referencia:
 *   - RFC 7643 — SCIM Core Schema (User, Group, Meta…).
 *   - RFC 7644 — SCIM Protocol (REST endpoints, ServiceProviderConfig, errores).
 *
 * Scope DELIBERADAMENTE acotado en este piloto:
 *   - Solo recursos `User` (sin `Group`).
 *   - Solo schema base `urn:ietf:params:scim:schemas:core:2.0:User`.
 *   - No soportamos extensiones empresariales
 *     (`urn:...:extension:enterprise:2.0:User`).
 *   - No exponemos /Bulk ni /Me (común que IdPs no los usen).
 *
 * Esto es suficiente para que Okta, Azure AD, Auth0 y Google Workspace puedan
 * crear / actualizar / desactivar usuarios.
 *
 * Persistencia:
 *   - Los usuarios viven en `app_user` (tabla User de Prisma) con su
 *     `tenantId`. SCIM no añade tabla nueva: mapea a campos existentes.
 *   - El token estático per-tenant se persiste en `tenant_setting`
 *     (module=scim, key=api-token, isSecret=true) — mismo patrón que MFA
 *     policy / custom domains.
 */

/** Schemas conocidos por el servidor SCIM (sólo el core User en este piloto). */
export const SCIM_SCHEMAS = {
  USER: 'urn:ietf:params:scim:schemas:core:2.0:User',
  LIST_RESPONSE: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  PATCH_OP: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  ERROR: 'urn:ietf:params:scim:api:messages:2.0:Error',
  SERVICE_PROVIDER_CONFIG: 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
  RESOURCE_TYPE: 'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
  SCHEMA: 'urn:ietf:params:scim:schemas:core:2.0:Schema',
} as const;

/** Persistencia del token SCIM dentro de `tenant_setting`. */
export const SCIM_TOKEN_MODULE_NAME = 'scim';
export const SCIM_TOKEN_KEY = 'api-token';

/**
 * Estructura del valor persistido en tenant_setting.
 *
 * - `tokenHash`: hash determinista del token (sha256 + base64url). NO
 *   guardamos el token plano: si se compromete el cifrado at-rest, el
 *   atacante necesita además fuerza bruta para llegar al token.
 * - `prefix`: primeros 8 chars del token plano para que el admin pueda
 *   identificar de un vistazo qué token está activo (estilo GitHub PAT).
 * - `createdAt`: ISO timestamp.
 * - `lastUsedAt`: ISO timestamp del último request SCIM autenticado correctamente.
 *   Se actualiza con throttle (1 vez por minuto máximo) para no escribir DB
 *   en cada request — fuera de scope del piloto, queda como TODO.
 */
export interface ScimApiTokenRecord {
  tokenHash: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Email SCIM (subset común — type/primary/value). */
export interface ScimEmail {
  /** Tipo del email: 'work' / 'home' / 'other'. Default: work. */
  type?: string;
  /** Si es el primario (RFC 7643: máx 1 por usuario). */
  primary?: boolean;
  /** El email en sí. */
  value: string;
}

/** Nombre estructurado SCIM (subset). */
export interface ScimName {
  givenName?: string;
  familyName?: string;
  formatted?: string;
}

/** Meta de cualquier recurso SCIM. */
export interface ScimMeta {
  resourceType: 'User';
  /** ISO timestamp de creación. */
  created: string;
  /** ISO timestamp de la última actualización. */
  lastModified: string;
  /** URL absoluta o relativa del recurso. */
  location: string;
}

/** Recurso User SCIM (subset suficiente para Okta/Azure AD/Auth0). */
export interface ScimUser {
  schemas: string[];
  /** UUID interno del usuario. */
  id: string;
  /** Identificador externo opcional (lo usa el IdP para correlacionar). */
  externalId?: string;
  /** Username — mapeamos a email del usuario interno. */
  userName: string;
  /** Si el usuario está habilitado. SCIM lo usa para activar/desactivar. */
  active: boolean;
  /** Nombre estructurado opcional. */
  name?: ScimName;
  /** Display name opcional. */
  displayName?: string;
  /** Lista de emails. El "primario" se usa como fallback si userName no es email. */
  emails?: ScimEmail[];
  /** Locale opcional (ISO 639). Mapea a User.locale. */
  locale?: string;
  /** Meta del recurso. */
  meta: ScimMeta;
}

/** Respuesta de list paginada SCIM. */
export interface ScimListResponse<T> {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

/**
 * Códigos SCIM "scimType" estandarizados para errores 4xx (RFC 7644 §3.12).
 * Listamos sólo los que usamos en este piloto.
 */
export type ScimErrorType =
  | 'invalidFilter'
  | 'invalidPath'
  | 'invalidSyntax'
  | 'invalidValue'
  | 'mutability'
  | 'noTarget'
  | 'uniqueness';

/** Respuesta de error SCIM estándar. */
export interface ScimError {
  schemas: string[];
  status: string;
  scimType?: ScimErrorType;
  detail: string;
}

/**
 * Construye un objeto error SCIM. El status va como string (RFC 7644 lo exige)
 * y `detail` es human-readable.
 */
export function makeScimError(status: number, detail: string, scimType?: ScimErrorType): ScimError {
  return {
    schemas: [SCIM_SCHEMAS.ERROR],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}
