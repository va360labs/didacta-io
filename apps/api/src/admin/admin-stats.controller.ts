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
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { AdminStatsService, type StatsRange } from './admin-stats.service';

const ADMIN_ROLES = ['super_admin', 'tenant_admin'] as const;

const querySchema = z.object({
  range: z.enum(['all', '7d', '30d']).default('all'),
});

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

@ApiTags('Admin · Stats')
@ApiBearerAuth()
@Controller('admin/stats')
@UseGuards(JwtAuthGuard)
export class AdminStatsController {
  constructor(private readonly service: AdminStatsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Métricas agregadas del tenant: usuarios activos, cursos publicados, matriculaciones, certificados, tasa de finalización. Soporta rango temporal.',
  })
  async getStats(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(querySchema)) query: { range: StatsRange },
  ) {
    const u = requireTenantAdmin(user);
    return this.service.getStats(u.tenantId, query.range);
  }
}
