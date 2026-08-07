/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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
import { AdminBusinessMetricsService } from './admin-business-metrics.service';

const ADMIN_ROLES = ['super_admin', 'tenant_admin'] as const;

function requireTenantAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  const isAdmin = user.roles.some((r) => (ADMIN_ROLES as readonly string[]).includes(r));
  if (!isAdmin) {
    throw new ForbiddenException({
      message: 'Esta acción requiere rol tenant_admin o super_admin.',
      code: 'ADMIN_FORBIDDEN_TENANT_ADMIN_REQUIRED',
    });
  }
  return user;
}

@ApiTags('Admin · Métricas de negocio')
@ApiBearerAuth()
@Controller('admin/metrics/business')
@UseGuards(JwtAuthGuard)
export class AdminBusinessMetricsController {
  constructor(private readonly service: AdminBusinessMetricsService) {}

  @Get()
  @ApiOperation({
    summary:
      'KPIs del negocio (bloque 7): NPS 30d, ventas semanales, impagos, altas/bajas, conexiones, uso del tutor IA y actividad de comunidad. Todo de la BD local.',
  })
  async getMetrics(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireTenantAdmin(user);
    return this.service.getMetrics(u.tenantId);
  }
}
