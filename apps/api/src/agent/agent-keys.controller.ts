/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireApiKeyAdmin } from '../auth/api-key-scopes';
import { ApiKeyService } from '../auth/api-key.service';
import { extractClientContext } from '../auth/client-context';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PANEL_AGENT_SCOPES } from './agent-scopes';
import { AgentService } from './agent.service';
import type { AcademyLocale } from '../common/academy-defaults';

/**
 * Nombre de la clave cuando el panel no manda uno. Sale en `/admin/api-keys`,
 * así que va en el idioma del aula (antes, «Agente de IA» siempre).
 */
export const DEFAULT_AGENT_KEY_NAME: Record<AcademyLocale, string> = {
  es: 'Agente de IA',
  en: 'AI agent',
};

/** Ruta del servidor MCP del aula, relativa al dominio del aula. */
export const MCP_PATH = '/api/v1/mcp';

const createSchema = z
  .object({ name: z.string().trim().min(1).max(100).optional() })
  .strict()
  .default({});

/**
 * Crear la clave de conexión del panel «Hazlo más rápido con tu agente de IA».
 *
 * - Solo con SESIÓN de persona (`JwtAuthGuard`): una clave de API no puede
 *   acuñar otra. Si no, un agente podría darse claves nuevas a sí mismo.
 * - Solo administradores del aula (`requireApiKeyAdmin`, la misma regla que
 *   `/admin/api-keys`).
 * - Los scopes los fija el servidor (`PANEL_AGENT_SCOPES`); el cuerpo solo
 *   admite un nombre. El panel no puede pedir más.
 * - El token en claro se devuelve UNA vez, aquí. En la base solo queda su
 *   SHA-256. Se lista y se revoca en `/admin/api-keys` como cualquier otra.
 */
@ApiTags('Agentes')
@ApiBearerAuth()
@Controller('agent/keys')
@UseGuards(JwtAuthGuard)
export class AgentKeysController {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly agent: AgentService,
  ) {}

  @Post()
  @ApiOperation({
    summary:
      'Crear la clave de un agente de IA (solo admins). Scopes fijos agent:*. El token solo se devuelve aquí.',
  })
  async create(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
  ) {
    const u = requireApiKeyAdmin(user);
    const ctx = extractClientContext(req);
    const created = await this.apiKeys.create({
      tenantId: u.tenantId,
      userId: u.sub,
      name:
        body.name ??
        DEFAULT_AGENT_KEY_NAME[
          await this.agent.academyLocale(u.tenantId).catch((): AcademyLocale => 'es')
        ],
      scopes: [...PANEL_AGENT_SCOPES],
    });
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'admin.api_key.created',
      resourceType: 'api_key',
      resourceId: created.id,
      metadata: { name: created.name, scopes: created.scopes, purpose: 'agent' },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    return { ...created, mcpPath: MCP_PATH };
  }
}
