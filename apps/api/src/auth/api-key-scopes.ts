/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AGENT_SCOPES } from '../agent/agent-scopes';
import type { SessionClaims } from './token.service';

/**
 * Catálogo ÚNICO de scopes que puede llevar una API key, la cree quien la cree
 * (`/admin/api-keys` o `/auth/api-keys`). Mantenerlo acotado evita claves con
 * permisos arbitrarios. Casos de uso: inscripción externa
 * (`POST /api/v1/inscribe`), lectura del catálogo y del estado del alumno para
 * pintar fichas fuera de Didacta (`GET /api/v1/integrations/…`) y publicación
 * en la comunidad (`POST /api/v1/community-api/posts`).
 *
 * `enrollments:read` va aparte de `enrollments:write` porque permite consultar
 * el estado de CUALQUIER email del tenant: quien solo necesita pintar una
 * ficha de venta no tiene por qué poder matricular, y al revés.
 *
 * ⛔ `JwtOrApiKeyGuard` vuelca los scopes de la key en `request.user.roles`.
 * Un scope fuera de este catálogo (p. ej. `tenant_admin`) se leería como un
 * ROL en cualquier comprobación de rol. Por eso el catálogo se aplica en los
 * dos extremos: al crear (ningún endpoint acepta scopes libres) y al usar (el
 * guard descarta lo que no esté aquí, ver `grantableApiKeyScopes`).
 *
 * El panel (`apps/web/src/lib/admin-api-keys.ts`) tiene su propia copia de la
 * lista para pintar las casillas.
 */
export const ALLOWED_API_KEY_SCOPES = [
  'enrollments:write',
  'enrollments:read',
  'courses:read',
  'community:post',
  'orders:write',
  'orders:read',
  // Puerta de agentes (servidor MCP del aula). Ver `agent/agent-scopes.ts`:
  // ahí está qué concede cada uno y, sobre todo, lo que NO conceden.
  ...AGENT_SCOPES,
] as const;
export type ApiKeyScope = (typeof ALLOWED_API_KEY_SCOPES)[number];

const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_API_KEY_SCOPES);

/**
 * Lo que una key puede otorgar de verdad: sus scopes guardados, menos todo lo
 * que no esté en el catálogo.
 *
 * Existe por las claves YA emitidas. Hasta este arreglo `POST /auth/api-keys`
 * aceptaba cualquier cadena como scope, así que en una instalación puede haber
 * filas con `scopes = ['tenant_admin']` o `['super_admin']`. Cerrar la creación
 * no las borra; filtrarlas al usarlas sí les quita el poder, sin tocar datos.
 */
export function grantableApiKeyScopes(scopes: readonly string[]): ApiKeyScope[] {
  return scopes.filter((s): s is ApiKeyScope => ALLOWED_SET.has(s));
}

/**
 * Una API key concede poderes de TENANT, no de la persona que la crea:
 * `enrollments:write` matricula a cualquiera en cualquier curso o grupo y
 * `orders:*` lee y escribe compras de cualquier alumno. Por eso solo las
 * gestionan los administradores, entren por el panel o por la API.
 *
 * `formador` queda fuera a propósito: edita contenido, pero no matricula gente
 * ni ve compras del tenant, y tampoco crea claves desde el panel. Dejarle este
 * camino reabriría el mismo atajo con otro rol.
 */
const API_KEY_ADMIN_ROLES: ReadonlySet<string> = new Set(['super_admin', 'tenant_admin']);

export function requireApiKeyAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => API_KEY_ADMIN_ROLES.has(r))) {
    throw new ForbiddenException({
      message: 'Esta acción requiere rol de administrador.',
      code: 'ADMIN_FORBIDDEN_ADMIN_ROLE_REQUIRED',
    });
  }
  return user;
}
