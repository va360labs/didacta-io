import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { extractClientContext } from '../auth/client-context';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { TenantModulesService } from '../modules/tenant-modules.service';

const ADMIN_ROLES = ['super_admin', 'tenant_admin'] as const;

function requireTenantAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  const isAdmin = user.roles.some((r) => (ADMIN_ROLES as readonly string[]).includes(r));
  if (!isAdmin) {
    throw new ForbiddenException('Esta acción requiere rol tenant_admin o super_admin.');
  }
  return user;
}

@ApiTags('Admin · Módulos')
@ApiBearerAuth()
@Controller('admin/modules')
@UseGuards(JwtAuthGuard)
export class AdminModulesController {
  constructor(private readonly service: TenantModulesService) {}

  @Get()
  @ApiOperation({
    summary:
      'Listar módulos disponibles para mi tenant con su estado (enabled/disabled) y dependencias.',
  })
  async list(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireTenantAdmin(user);
    return this.service.list(u.tenantId);
  }

  @Post(':name/enable')
  @ApiOperation({
    summary: 'Activar un módulo en mi tenant. Idempotente si ya estaba activo.',
  })
  async enable(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('name') name: string,
  ) {
    const u = requireTenantAdmin(user);
    return this.service.enable(u.tenantId, name, u.sub, extractClientContext(req));
  }

  @Post(':name/disable')
  @ApiOperation({
    summary:
      'Desactivar un módulo en mi tenant. Si otros módulos activos dependen de él, requiere ?force=true (cascada).',
  })
  async disable(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('name') name: string,
    @Query('force') force?: string,
  ) {
    const u = requireTenantAdmin(user);
    return this.service.disable(
      u.tenantId,
      name,
      u.sub,
      { force: force === 'true' },
      extractClientContext(req),
    );
  }
}
