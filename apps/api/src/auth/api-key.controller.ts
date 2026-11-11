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
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { ALLOWED_API_KEY_SCOPES, requireApiKeyAdmin } from './api-key-scopes';
import { ApiKeyService } from './api-key.service';
import { extractClientContext } from './client-context';
import { CurrentUser } from './decorators';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ZodValidationPipe } from './zod-validation.pipe';
import type { SessionClaims } from './token.service';

const createSchema = z.object({
  name: z.string().min(1).max(100),
  // Solo scopes del catálogo: el guard de API keys los vuelca en `roles`, así
  // que un scope libre como `tenant_admin` se leería como un rol.
  scopes: z.array(z.enum(ALLOWED_API_KEY_SCOPES)).default([]),
  expiresAt: z.string().datetime().optional(),
});

/**
 * Las API keys PROPIAS del administrador que llama (crear, listar, revocar).
 *
 * Hasta este arreglo bastaba con estar logueado y los scopes eran texto libre:
 * un alumno podía acuñarse una clave con `enrollments:write` y matricularse en
 * cualquier curso de pago, leer compras ajenas con `orders:read`, o pedir un
 * «scope» `tenant_admin`, que el guard copiaba tal cual a `roles`.
 *
 * Ahora aplica las MISMAS dos reglas que `/admin/api-keys`, y las dos viven en
 * `api-key-scopes.ts` para que no puedan volver a separarse:
 *   - solo `super_admin` / `tenant_admin` (`requireApiKeyAdmin`);
 *   - solo scopes del catálogo (`ALLOWED_API_KEY_SCOPES`).
 * Y deja el mismo rastro en el audit log, con las mismas acciones: que una
 * clave se cree por aquí y no por el panel no puede ser la forma de crearla
 * sin que conste.
 *
 * La única diferencia con `/admin/api-keys` es el alcance: aquí cada admin ve
 * y revoca las suyas; allí, todas las del tenant.
 */
@ApiTags('Auth · API Keys')
@ApiBearerAuth()
@Controller('auth/api-keys')
@UseGuards(JwtAuthGuard)
export class ApiKeyController {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Crear API key (solo admins). El token solo se devuelve una vez aquí.',
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

  @Get()
  @ApiOperation({ summary: 'Listar las API keys del admin actual (sin tokens en plano)' })
  async list(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireApiKeyAdmin(user);
    return this.apiKeys.listForUser(u.tenantId, u.sub);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Revocar una API key propia (solo admins; marca revokedAt, no la borra)',
  })
  async revoke(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
  ) {
    const u = requireApiKeyAdmin(user);
    const ctx = extractClientContext(req);
    await this.apiKeys.revoke(u.tenantId, u.sub, id);
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
