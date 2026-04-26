import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { PrismaAuditLogService } from './prisma-audit-log.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin', 'auditor']);

function requireAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException('Solo super_admin, tenant_admin o auditor pueden acceder al log');
  }
  return user;
}

@ApiTags('Audit')
@ApiBearerAuth()
@Controller('audit')
@UseGuards(JwtAuthGuard)
export class AuditController {
  constructor(private readonly auditLog: PrismaAuditLogService) {}

  @Get('verify')
  @ApiOperation({
    summary: 'Verificar la integridad de la cadena de auditoría del tenant del usuario.',
  })
  async verify(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireAdmin(user);
    return this.auditLog.verifyChain(u.tenantId);
  }

  @Get('entries')
  @ApiOperation({
    summary:
      'Listado del audit log del tenant con filtros (actor, action, resource, rango de fechas).',
  })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
    @Query('resourceType') resourceType?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('limit') limit?: string,
  ) {
    const u = requireAdmin(user);
    return this.auditLog.list(u.tenantId, {
      actorId,
      action,
      resourceType,
      dateFrom: dateFrom ? new Date(dateFrom) : undefined,
      dateTo: dateTo ? new Date(dateTo) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
