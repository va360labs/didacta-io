/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { extractClientContext } from '../auth/client-context';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import {
  AdminUsersService,
  TENANT_ASSIGNABLE_ROLES,
  type AssignableRole,
} from './admin-users.service';

const inviteSchema = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(120).optional(),
  role: z.enum(TENANT_ASSIGNABLE_ROLES),
  /// Grupo de acceso al que añadir al invitado en el mismo alta (viaje 1:
  /// invitar con aula). Opcional; se valida contra el tenant en el service.
  accessGroupId: z.string().uuid().optional(),
});
type InviteDto = z.infer<typeof inviteSchema>;

/// Alta masiva desde CSV. El rol y el grupo son ÚNICOS para todo el lote (se
/// eligen una vez en el formulario, no por fila) para no exigirle al operador
/// que prepare un CSV con columnas de rol/grupo por persona. `rows` cap a 300:
/// el lote corre en segundo plano igual que `send-batch` de invitaciones, pero
/// un límite mantiene la memoria del progreso acotada.
const bulkInviteRowSchema = z.object({
  email: z.string().email().max(200),
  name: z.string().max(120).optional(),
});
const bulkInviteSchema = z.object({
  rows: z.array(bulkInviteRowSchema).min(1).max(300),
  role: z.enum(TENANT_ASSIGNABLE_ROLES),
  accessGroupId: z.string().uuid().optional(),
});
type BulkInviteDto = z.infer<typeof bulkInviteSchema>;

/// Paginación del listado de users (alpha.74).
/// `limit` cap a 500 — más que eso es DoS-friendly por la query de count.
/// `page` cap a 10000 — paranoia anti-overflow del offset.
const listQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['ACTIVE', 'PENDING', 'SUSPENDED', 'DEACTIVATED']).optional(),
  role: z.enum(TENANT_ASSIGNABLE_ROLES).optional(),
  externalSource: z.string().trim().min(1).max(40).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
type ListQueryDto = z.infer<typeof listQuerySchema>;

const setStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']),
});
type SetStatusDto = z.infer<typeof setStatusSchema>;

const roleSchema = z.object({
  role: z.enum(TENANT_ASSIGNABLE_ROLES),
});
type RoleDto = z.infer<typeof roleSchema>;

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

function requireAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException('Esta acción requiere rol de administrador.');
  }
  return user;
}

@ApiTags('Admin · Usuarios')
@ApiBearerAuth()
@Controller('admin/users')
@UseGuards(JwtAuthGuard)
export class AdminUsersController {
  constructor(
    private readonly service: AdminUsersService,
    private readonly tenantResolver: TenantResolverService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Listar usuarios del tenant (paginado, con filtros). Devuelve { items, total, page, limit, hasMore }.',
  })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQueryDto,
  ) {
    const u = requireAdmin(user);
    return this.service.list(u.tenantId, {
      search: query.search,
      status: query.status,
      role: query.role,
      externalSource: query.externalSource,
      page: query.page,
      limit: query.limit,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle del usuario (con roles + sessions recientes).' })
  async getOne(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = requireAdmin(user);
    return this.service.getDetail(u.tenantId, id);
  }

  @Post()
  @ApiOperation({
    summary:
      'Invitar a un usuario nuevo. Crea con status=PENDING y le envía email para que defina su contraseña.',
  })
  async invite(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(inviteSchema)) dto: InviteDto,
  ) {
    const u = requireAdmin(user);
    const webBaseUrl = await this.tenantResolver.resolveTenantWebBaseUrl(u.tenantId, req);
    return this.service.invite(
      u.tenantId,
      u.sub,
      {
        email: dto.email,
        name: dto.name,
        role: dto.role as AssignableRole,
        accessGroupId: dto.accessGroupId,
      },
      webBaseUrl,
      extractClientContext(req),
    );
  }

  @Post('bulk-invite')
  @ApiOperation({
    summary:
      'Alta masiva (CSV): crea varios usuarios con el mismo rol/grupo. Responde antes de terminar; el progreso se consulta en GET bulk-invite/status.',
  })
  async bulkInvite(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(bulkInviteSchema)) dto: BulkInviteDto,
  ) {
    const u = requireAdmin(user);
    const webBaseUrl = await this.tenantResolver.resolveTenantWebBaseUrl(u.tenantId, req);
    return this.service.startBulkInvite(
      u.tenantId,
      u.sub,
      dto.rows,
      dto.role as AssignableRole,
      dto.accessGroupId,
      webBaseUrl,
      extractClientContext(req),
    );
  }

  @Get('bulk-invite/status')
  @ApiOperation({ summary: 'Progreso del alta masiva en curso (o la última terminada).' })
  async bulkInviteStatus(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireAdmin(user);
    return this.service.estadoBulkInvite(u.tenantId);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary:
      'Cambia el status del usuario (ACTIVE/SUSPENDED/DEACTIVATED). Suspender invalida sus sessions activas.',
  })
  async setStatus(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setStatusSchema)) dto: SetStatusDto,
  ) {
    const u = requireAdmin(user);
    return this.service.setStatus(u.tenantId, u.sub, id, dto.status, extractClientContext(req));
  }

  @Post(':id/roles')
  @ApiOperation({ summary: 'Asignar un rol al usuario.' })
  async assignRole(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(roleSchema)) dto: RoleDto,
  ) {
    const u = requireAdmin(user);
    return this.service.assignRole(
      u.tenantId,
      u.sub,
      id,
      dto.role as AssignableRole,
      extractClientContext(req),
    );
  }

  @Patch(':id/roles/remove')
  @ApiOperation({ summary: 'Quitar un rol al usuario.' })
  async removeRole(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(roleSchema)) dto: RoleDto,
  ) {
    const u = requireAdmin(user);
    return this.service.removeRole(
      u.tenantId,
      u.sub,
      id,
      dto.role as AssignableRole,
      extractClientContext(req),
    );
  }

  @Post(':id/resend-invite')
  @ApiOperation({
    summary:
      'Reenvía email para definir contraseña al usuario (útil si el primer email se perdió).',
  })
  async resendInvite(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
  ) {
    const u = requireAdmin(user);
    const webBaseUrl = await this.tenantResolver.resolveTenantWebBaseUrl(u.tenantId, req);
    return this.service.resendInvite(u.tenantId, u.sub, id, webBaseUrl, extractClientContext(req));
  }
}
