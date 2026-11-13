/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { grantableApiKeyScopes } from '../auth/api-key-scopes';
import { ApiKeyService } from '../auth/api-key.service';
import { resolvePublicHost } from '../common/resolve-public-host';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { runAsTenant } from '../tenancy/tenant-context.storage';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import { isAgentScope } from './agent-scopes';

/** Lo que el guard deja en la petición, además de `request.user`. */
export interface AgentKeyContext {
  apiKeyId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    agentKey?: AgentKeyContext;
  }
}

const API_KEY_PREFIX = 'lmsk_';

/**
 * La clave del agente sale de `Authorization`, con cualquiera de los dos
 * esquemas: `Bearer lmsk_…` (el que mandan Claude Code, Codex, Cursor, Hermes y
 * el resto de clientes MCP con su opción de «token») o `ApiKey lmsk_…` (el del
 * resto de la API de Didacta). Nada más: ni query string ni otra cabecera.
 */
export function extractAgentToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^(Bearer|ApiKey)\s+(\S+)\s*$/i.exec(header.trim());
  const token = match?.[2];
  return token && token.startsWith(API_KEY_PREFIX) ? token : null;
}

/**
 * Puerta del servidor MCP: SOLO claves de API con algún scope `agent:*`.
 *
 * Tres reglas de aislamiento entre aulas, por orden:
 *
 *  1. El aula sale de la CLAVE y de nada más. El `tenantId` que acaba en
 *     `request.user` es el de la fila `api_key`; ninguna cabecera, parámetro
 *     o argumento de herramienta puede cambiarlo. (Este producto ya tuvo un
 *     fallo entre aulas por fiarse de metadatos del mensaje; aquí no hay
 *     metadatos que mirar.)
 *  2. Si el contexto de tenant ya está abierto (lo abre `TenantMiddleware`
 *     con la misma clave), tiene que ser el mismo aula. Si no coincide, algo
 *     raro pasa y se corta.
 *  3. El dominio solo sirve para RECHAZAR: si la petición llega por el
 *     dominio de otra aula, la clave no vale ahí (403). Nunca se usa para
 *     elegir aula. Así, quien pega la clave de un aula en la URL de otra
 *     recibe un error claro en vez de escribir en un sitio que no esperaba.
 *
 * Un JWT de sesión NO entra: la puerta es para agentes con clave propia,
 * revocable y con scopes, no para reutilizar la sesión de una persona.
 */
@Injectable()
export class AgentKeyGuard implements CanActivate {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly tenantContext: TenantContextService,
    private readonly tenantResolver: TenantResolverService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const token = extractAgentToken(req.headers['authorization']);
    if (!token) {
      throw new UnauthorizedException({
        message:
          'Falta la clave del agente. Envíala en la cabecera «Authorization: Bearer lmsk_…» (créala en el panel «Hazlo más rápido con tu agente de IA»).',
        code: 'AGENT_KEY_MISSING',
      });
    }

    // Primero se mira la clave SIN efectos (búsqueda global sancionada, como
    // hace TenantMiddleware) para saber de qué aula es; después se valida y se
    // marca `lastUsedAt` DENTRO del contexto de ESA aula. Así no depende de
    // que el middleware haya abierto el contexto: con RLS forzada, el update
    // de `lastUsedAt` fuera de contexto no encuentra la fila y reventaba.
    const peek = await this.apiKeys.resolveContext(token);
    const open = this.tenantContext.get();
    if (peek && open?.tenantId && open.tenantId !== peek.tenantId) {
      throw new ForbiddenException({
        message: 'La clave no pertenece a esta aula.',
        code: 'AGENT_KEY_OTHER_ACADEMY',
      });
    }
    const key = peek
      ? await runAsTenant(peek.tenantId, () => this.apiKeys.findValidByToken(token))
      : null;
    if (!key) {
      throw new UnauthorizedException({
        message: 'La clave del agente no es válida, ha caducado o se ha revocado.',
        code: 'AGENT_KEY_INVALID',
      });
    }

    const scopes = grantableApiKeyScopes(key.scopes).filter(isAgentScope);
    if (scopes.length === 0) {
      throw new ForbiddenException({
        message:
          'Esta clave no es de agente. Crea una desde el panel «Hazlo más rápido con tu agente de IA».',
        code: 'AGENT_KEY_NOT_AGENT',
      });
    }

    const byHost = await this.tenantResolver.resolveByHost(resolvePublicHost(req));
    if (byHost && byHost.id !== key.tenantId) {
      throw new ForbiddenException({
        message:
          'Esta clave es de otra aula. Usa la dirección del servidor MCP que aparece junto a la clave.',
        code: 'AGENT_KEY_OTHER_ACADEMY',
      });
    }

    req.user = {
      sub: key.userId,
      tenantId: key.tenantId,
      roles: scopes,
      mfaVerified: true,
    };
    req.agentKey = { apiKeyId: key.id };
    return true;
  }
}
