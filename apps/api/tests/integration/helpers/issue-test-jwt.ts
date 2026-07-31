/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Helper de tests de integración (ART-025).
 *
 * Emite JWT de acceso firmado HS256 alineado con `TokenService.sign()`:
 *
 *   header  = { alg: 'HS256' }
 *   payload = {
 *     sub, tenantId, roles, mfaVerified,
 *     kind: 'access',
 *     iss: AUTH_URL ?? 'https://didacta.local',
 *     aud: 'didacta-api',
 *     iat, exp,
 *   }
 *
 * Crítico:
 *   - `AUTH_SECRET` debe estar set ANTES de importar este módulo (lo hace
 *     `setup-db.ts` en `setup()`). Si se intenta usar sin AUTH_SECRET el
 *     `loadAuthConfig()` lanza para evitar bootstraps silenciosamente
 *     incorrectos. NO se cachea el secret a nivel módulo: lo leemos en cada
 *     llamada para soportar rotación entre suites de test si fuese necesario.
 *   - `mfaVerified=true` por defecto: el `JwtAuthGuard` exige MFA verificado
 *     en cualquier acción de roles `super_admin` / `tenant_admin` (LMS-109).
 *     Sin esto, el guard responde 403 con `code: 'mfa_required'` antes de
 *     llegar al `LicenseGuard`.
 */

import { SignJWT } from 'jose';
import { loadAuthConfig } from '../../../src/auth/auth.config';

export interface IssueTestJwtOptions {
  /** UUID del usuario, va al claim `sub`. */
  userId?: string;
  /** Tenant del usuario, va al claim `tenantId`. */
  tenantId?: string;
  /** Roles a inyectar. Default: `['tenant_admin']`. */
  roles?: readonly string[];
  /** Marca el token con MFA verificado. Default: true (admin necesita MFA). */
  mfaVerified?: boolean;
  /** TTL en segundos (override del default 1h). */
  ttlSeconds?: number;
}

/**
 * UUIDs deterministas para tenant + user de los tests de integración. Tienen
 * que ser UUID válidos porque las columnas relevantes en Prisma son `Uuid`
 * y los services las tipan como tal — Postgres rechaza cualquier otro string
 * con `Inconsistent column data: Error creating UUID`.
 */
export const TEST_TENANT_ID = '00000000-0000-4000-8000-000000000001';
export const TEST_USER_ID = '00000000-0000-4000-8000-000000000002';

/**
 * Construye y firma un JWT de access con el shape exacto que `TokenService`
 * emite en producción. Útil para que tests de integración monten requests con
 * Bearer auth real sin pasar por el flujo de login.
 *
 * Devuelve la string completa del JWT (header.payload.signature).
 */
export async function issueTestAccessJwt(opts: IssueTestJwtOptions = {}): Promise<string> {
  const config = loadAuthConfig();
  const secret = new TextEncoder().encode(config.jwtSecret);

  const userId = opts.userId ?? TEST_USER_ID;
  const tenantId = opts.tenantId ?? TEST_TENANT_ID;
  const roles = opts.roles ?? ['tenant_admin'];
  const mfaVerified = opts.mfaVerified ?? true;
  const ttl = opts.ttlSeconds ?? config.jwtAccessTtlSeconds;

  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({
    tenantId,
    roles,
    mfaVerified,
    kind: 'access',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(config.jwtIssuer)
    .setAudience('didacta-api')
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttl)
    .sign(secret);
}

/**
 * Devuelve un header `Authorization: Bearer <jwt>` listo para `supertest`.
 * Reduce ruido en los call-sites.
 */
export async function bearerHeader(opts: IssueTestJwtOptions = {}): Promise<string> {
  const jwt = await issueTestAccessJwt(opts);
  return `Bearer ${jwt}`;
}
