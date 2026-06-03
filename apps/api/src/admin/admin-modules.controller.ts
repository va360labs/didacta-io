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

/**
 * Resuelve el tenantId sobre el que operar.
 * - tenant_admin: solo puede operar sobre su propio tenant. Si pasa
 *   ?tenantId distinto al suyo → 403.
 * - super_admin: puede pasar ?tenantId=<otro> para operar sobre cualquier
 *   tenant. Sin query param → opera sobre el suyo.
 */
function resolveTargetTenant(user: SessionClaims, queryTenantId?: string): string {
  if (!queryTenantId) return user.tenantId;
  if (queryTenantId === user.tenantId) return queryTenantId;
  if (!user.roles.includes('super_admin')) {
    throw new ForbiddenException(
      'Solo super_admin puede operar módulos en otro tenant. Omite ?tenantId para usar el tuyo.',
    );
  }
  return queryTenantId;
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
      'Listar módulos disponibles para mi tenant (o ?tenantId=<otro> si soy super_admin) con su estado y dependencias.',
  })
  async list(@CurrentUser() user: SessionClaims | undefined, @Query('tenantId') tenantId?: string) {
    const u = requireTenantAdmin(user);
    const target = resolveTargetTenant(u, tenantId);
    return this.service.list(target);
  }

  @Post(':name/enable')
  @ApiOperation({
    summary: 'Activar un módulo. Idempotente. ?tenantId=<otro> requiere super_admin.',
  })
  async enable(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('name') name: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const u = requireTenantAdmin(user);
    const target = resolveTargetTenant(u, tenantId);
    return this.service.enable(target, name, u.sub, extractClientContext(req));
  }

  @Post(':name/disable')
  @ApiOperation({
    summary:
      'Desactivar un módulo. ?force=true cascade en dependientes activos. ?tenantId=<otro> requiere super_admin.',
  })
  async disable(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('name') name: string,
    @Query('force') force?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const u = requireTenantAdmin(user);
    const target = resolveTargetTenant(u, tenantId);
    return this.service.disable(
      target,
      name,
      u.sub,
      { force: force === 'true' },
      extractClientContext(req),
    );
  }
}
