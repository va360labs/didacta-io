import {
  Controller,
  ForbiddenException,
  Get,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { PrismaAuditLogService } from './prisma-audit-log.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

@ApiTags('Audit')
@ApiBearerAuth()
@Controller('audit')
@UseGuards(JwtAuthGuard)
export class AuditController {
  constructor(private readonly auditLog: PrismaAuditLogService) {}

  @Get('verify')
  @ApiOperation({
    summary: 'Verificar la integridad de la cadena de auditoría del tenant del usuario',
  })
  async verify(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    const isAdmin = user.roles.some((r) => ADMIN_ROLES.has(r));
    if (!isAdmin) {
      throw new ForbiddenException('Solo super_admin o tenant_admin pueden verificar la cadena');
    }
    return this.auditLog.verifyChain(user.tenantId);
  }
}
