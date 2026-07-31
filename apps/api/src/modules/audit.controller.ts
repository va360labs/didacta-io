/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LicenseService, LICENSE_CAPABILITIES } from '@didacta/license-sdk';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { PrismaAuditLogService } from './prisma-audit-log.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin', 'auditor']);

/**
 * Retención máxima del audit log en plan Community (días). Más allá requiere
 * capability Enterprise `feat:audit.long_retention`.
 */
export const COMMUNITY_AUDIT_RETENTION_DAYS = 90;

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
  constructor(
    private readonly auditLog: PrismaAuditLogService,
    private readonly license: LicenseService,
  ) {}

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
      'Listado del audit log del tenant con filtros (actor, action, resource, rango de fechas). En plan Community el rango efectivo está limitado a los últimos 90 días (truncado silencioso); con la capability Enterprise `feat:audit.long_retention` activa el rango es ilimitado. Para ver la política activa llama GET /audit/retention-info.',
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
    const rawDateFrom = dateFrom ? new Date(dateFrom) : undefined;
    const rawDateTo = dateTo ? new Date(dateTo) : undefined;

    // Gate de retención larga (capability EE). Si no está activa, recortamos
    // el dateFrom efectivo a now-90d. Si está activa, dejamos la fecha tal cual.
    const longRetention = this.license.isCapabilityEnabled(
      LICENSE_CAPABILITIES.AUDIT_LONG_RETENTION,
    );
    const effectiveDateFrom = longRetention
      ? rawDateFrom
      : applyCommunityRetentionFloor(rawDateFrom);

    return this.auditLog.list(u.tenantId, {
      actorId,
      action,
      resourceType,
      dateFrom: effectiveDateFrom,
      dateTo: rawDateTo,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('retention-info')
  @ApiOperation({
    summary:
      'Devuelve la política activa de retención del audit log para el tenant del caller (plan + maxDays). El frontend lo usa para mostrar un aviso "Plan Community: solo últimos 90 días" o "Plan Enterprise: retención ilimitada".',
  })
  retentionInfo(@CurrentUser() user: SessionClaims | undefined) {
    requireAdmin(user);
    const longRetention = this.license.isCapabilityEnabled(
      LICENSE_CAPABILITIES.AUDIT_LONG_RETENTION,
    );
    return {
      plan: longRetention ? 'enterprise' : 'community',
      maxDays: longRetention ? null : COMMUNITY_AUDIT_RETENTION_DAYS,
      capability: LICENSE_CAPABILITIES.AUDIT_LONG_RETENTION,
    };
  }
}

/**
 * Si el caller pide un dateFrom anterior a `now - COMMUNITY_AUDIT_RETENTION_DAYS`,
 * devolvemos el floor. Si pide más reciente o no pide nada, se respeta la fecha
 * pedida (o se aplica el floor cuando no hay dateFrom para acotar el query a
 * los últimos 90d en plan community).
 */
function applyCommunityRetentionFloor(rawDateFrom: Date | undefined): Date {
  const floor = new Date(Date.now() - COMMUNITY_AUDIT_RETENTION_DAYS * 86_400_000);
  if (!rawDateFrom) return floor;
  return rawDateFrom.getTime() < floor.getTime() ? floor : rawDateFrom;
}
