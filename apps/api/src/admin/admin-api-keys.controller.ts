/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ALLOWED_API_KEY_SCOPES, requireApiKeyAdmin } from '../auth/api-key-scopes';
import { ApiKeyService } from '../auth/api-key.service';
import { extractClientContext } from '../auth/client-context';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';

// El catálogo de scopes y la regla «solo admins» viven en
// `auth/api-key-scopes.ts`: los comparten este panel y `/auth/api-keys`, y
// ninguno de los dos puede aceptar scopes libres ni a quien no sea admin.
const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(ALLOWED_API_KEY_SCOPES)).min(1).default(['enrollments:write']),
  expiresAt: z.string().datetime().optional(),
});
type CreateDto = z.infer<typeof createSchema>;

/**
 * Gestión de API keys del tenant desde Administración. A diferencia de
 * `/auth/api-keys` (las claves propias del admin que llama), aquí el admin
 * ve/revoca TODAS las claves del tenant. El token en claro solo se devuelve al
 * crearla.
 */
@ApiTags('Admin · API Keys')
@ApiBearerAuth()
@Controller('admin/api-keys')
@UseGuards(JwtAuthGuard)
export class AdminApiKeysController {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Listar las API keys del tenant (sin tokens en plano) con su creador.',
  })
  async list(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireApiKeyAdmin(user);
    return this.apiKeys.listForTenant(u.tenantId);
  }

  @Post()
  @ApiOperation({
    summary: 'Crear una API key del tenant. El token solo se devuelve una vez aquí.',
  })
  async create(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createSchema)) body: CreateDto,
  ) {
    const u = requireApiKeyAdmin(user);
    const ctx = extractClientContext(req);
    const created = await this.apiKeys.create({
      tenantId: u.tenantId,
      userId: u.sub,
      name: body.name,
      scopes: body.scopes,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'admin.api_key.created',
      resourceType: 'api_key',
      resourceId: created.id,
      metadata: { name: created.name, scopes: created.scopes },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
    return created;
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revocar una API key del tenant (marca revokedAt, no la borra).' })
  async revoke(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
  ) {
    const u = requireApiKeyAdmin(user);
    const ctx = extractClientContext(req);
    await this.apiKeys.revokeForTenant(u.tenantId, id);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'admin.api_key.revoked',
      resourceType: 'api_key',
      resourceId: id,
      metadata: {},
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });
  }
}
