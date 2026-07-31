/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * ScimAuthGuard — guard para endpoints SCIM con Bearer token estático
 * (séptimo piloto License SDK).
 *
 * Por qué un guard distinto del JwtAuthGuard:
 *   Los IdPs (Okta, Azure AD, Auth0, Google Workspace) NO entienden el JWT
 *   propietario de Didacta. Lo que sí saben hacer es enviar un Bearer token
 *   estático configurado en el panel del IdP. SCIM 2.0 no impone esquema de
 *   auth concreto — RFC 7644 §2: "the SCIM service provider MAY use any
 *   suitable authentication scheme". El estándar de facto en la industria
 *   es Bearer token con un secreto provisto al IdP por el admin del SaaS.
 *
 * Diseño:
 *   - El admin genera el token en /admin/scim (panel web). El token se entrega
 *     UNA SOLA VEZ; sólo el hash queda persistido en `tenant_setting`.
 *   - El guard recibe `Authorization: Bearer <token>`, hashea el token y busca
 *     en TODOS los tenants un setting con ese hash. Si encuentra → tenant
 *     resuelto. Si no → 401 SCIM.
 *
 * Búsqueda lineal (acotada):
 *   El piloto hace un findMany sobre `tenant_setting` con módulo='scim' y
 *   recorre comparando hashes. Esto es O(N) sobre la cantidad de tenants con
 *   token SCIM activo — aceptable porque normalmente son decenas, no millones.
 *   En producción real con miles de tenants conviene migrar a una columna
 *   tokenHash con índice único (TODO follow-up).
 *
 * Tenant scoping:
 *   El guard inyecta `tenantId` en `req.scimTenantId` (no toca req.user para
 *   no confundirse con el SessionClaims del JWT). El service y controller
 *   usan exclusivamente este campo para filtrar.
 */

import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SCIM_TOKEN_KEY, SCIM_TOKEN_MODULE_NAME, makeScimError } from './scim.types';
import type { ScimApiTokenRecord } from './scim.types';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Tenant resuelto a partir del Bearer SCIM. Sólo lo setea el ScimAuthGuard.
     * NO se cruza con `req.user` (SessionClaims del JWT) para evitar mezclar
     * trust boundaries.
     */
    scimTenantId?: string;
  }
}

/**
 * Hash determinista del token SCIM. Usamos sha256 hex — colisiones
 * computacionalmente imposibles para un token de 36+ caracteres aleatorios.
 *
 * Determinismo importa: el guard hashea el token recibido y compara con el
 * hash persistido. Si cambiamos el algoritmo invalidamos los tokens emitidos.
 */
export function hashScimToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

@Injectable()
export class ScimAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const auth = req.headers['authorization'];

    if (!auth || typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        makeScimError(401, 'Missing or invalid Authorization header. Expected Bearer token.'),
      );
    }

    const rawToken = auth.slice('Bearer '.length).trim();
    if (rawToken.length === 0) {
      throw new UnauthorizedException(makeScimError(401, 'Empty Bearer token.'));
    }

    const wantedHash = hashScimToken(rawToken);

    // Buscamos en todos los tenants el setting SCIM. La selección incluye
    // tenantId + valueJson para reconstruir el record.
    const candidates = await this.prisma.tenantSetting.findMany({
      where: {
        moduleName: SCIM_TOKEN_MODULE_NAME,
        key: SCIM_TOKEN_KEY,
        // Sólo settings no cifrados — el token SCIM lo guardamos como hash en
        // valueJson.tokenHash, no como secret cifrado, porque NO necesitamos
        // recuperar el plaintext: sólo comparar el hash. Mantener isSecret=false
        // simplifica esta búsqueda y evita un decrypt N veces por request.
        isSecret: false,
      },
      select: { tenantId: true, valueJson: true },
    });

    for (const row of candidates) {
      const record = row.valueJson as unknown as ScimApiTokenRecord | null;
      if (!record || typeof record.tokenHash !== 'string') continue;
      if (timingSafeEqualStr(record.tokenHash, wantedHash)) {
        req.scimTenantId = row.tenantId;
        return true;
      }
    }

    throw new UnauthorizedException(makeScimError(401, 'Bearer token not recognized.'));
  }
}

/**
 * Comparación de strings constante en tiempo (defensa contra timing attacks).
 * Para sha256 hex (64 chars) el coste es despreciable.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
