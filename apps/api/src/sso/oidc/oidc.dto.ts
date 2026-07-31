/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * DTOs Zod para el 8º piloto License SDK (`feat:sso.oidc`).
 *
 * Validaciones clave:
 *   - issuer: HTTPS estricto. Aceptamos http://localhost para dev (suite de
 *     tests apunta a fixtures locales), pero en producción real el SDK del
 *     IdP rechaza igualmente cualquier issuer no-HTTPS.
 *   - clientId: string no vacío, hasta 255 chars (Okta usa GUID, Azure AD
 *     usa GUID, Auth0 usa string base64ish — 255 cubre todos los formatos).
 *   - clientSecret: opcional en PUT (rotación opcional — si no viene,
 *     mantenemos el ya guardado). Mín 16 chars cuando se escribe (Azure AD
 *     mínimo es 32, Okta 64, pero 16 cubre Keycloak self-hosted).
 *   - allowedEmailDomains: array de domains lowercase sin @. Vacío = sin
 *     filtro.
 *   - scopes: ['openid', 'email', 'profile'] por defecto. Permitimos el admin
 *     ampliar (`groups`, `offline_access`) pero NO restringir por debajo de
 *     `openid` (es obligatorio para que Authentication devuelva id_token).
 */

import { z } from 'zod';

const httpsIssuerRegex = /^https:\/\/[^\s/$.?#].[^\s]*$/i;
const localhostIssuerRegex = /^http:\/\/localhost(:\d{1,5})?(\/.*)?$/i;

const issuerSchema = z
  .string()
  .trim()
  .min(8)
  .max(500)
  .refine((v) => httpsIssuerRegex.test(v) || localhostIssuerRegex.test(v), {
    message: 'issuer debe ser HTTPS (o http://localhost en dev)',
  })
  // Quitamos trailing slash para no duplicar al concatenar /.well-known/openid-configuration.
  .transform((v) => v.replace(/\/+$/, ''));

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, {
    message: 'dominio inválido',
  });

const scopeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_:.-]+$/, { message: 'scope contiene caracteres inválidos' });

/**
 * Schema PUT /admin/sso/oidc/config.
 *
 * `clientSecret` es opcional: si el admin sólo cambia el resto de la config,
 * envía un PUT sin secret y el service preserva el secreto previo. Para
 * rotar, envía el nuevo plaintext.
 */
export const oidcConfigPutSchema = z
  .object({
    enabled: z.boolean(),
    issuer: issuerSchema,
    clientId: z.string().trim().min(1).max(255),
    clientSecret: z.string().trim().min(16).max(2048).optional().nullable(),
    allowedEmailDomains: z.array(domainSchema).max(50).default([]),
    autoProvisionUsers: z.boolean().default(false),
    scopes: z
      .array(scopeSchema)
      .min(1)
      .max(20)
      .refine((arr) => arr.includes('openid'), {
        message: 'la lista de scopes debe incluir "openid"',
      })
      .default(['openid', 'email', 'profile']),
  })
  .strict();

export type OidcConfigPutDto = z.infer<typeof oidcConfigPutSchema>;

/**
 * Schema POST /admin/sso/oidc/test-discovery.
 *
 * El admin envía sólo el issuer URL. El service hace OIDC Discovery y devuelve
 * los endpoints (authorization, token, jwks) si OK, o un mensaje de error.
 * Útil para validar el issuer ANTES de guardar la config completa.
 */
export const oidcTestDiscoverySchema = z
  .object({
    issuer: issuerSchema,
  })
  .strict();

export type OidcTestDiscoveryDto = z.infer<typeof oidcTestDiscoverySchema>;
