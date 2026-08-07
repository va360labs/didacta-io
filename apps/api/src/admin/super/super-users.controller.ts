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
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { SuperUsersService, type SuperUsersListResult } from './super-users.service';

function requireSuperAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.includes('super_admin')) {
    throw new ForbiddenException({
      message: 'Esta acción requiere rol super_admin.',
      code: 'ADMIN_FORBIDDEN_SUPER_ADMIN_REQUIRED',
    });
  }
  return user;
}

/**
 * Listings cross-tenant para super_admin (follow-up `feat:multi_tenant.real`).
 *
 * Gates en orden:
 *  1. JwtAuthGuard — sesión válida.
 *  2. requireSuperAdmin — rol estricto super_admin (NO tenant_admin).
 *  3. license.requireCapability(MULTI_TENANT_REAL) — dentro del service;
 *     sin licencia EE devuelve 402 vía LicenseExceptionFilter global.
 *
 * En CE (1 tenant) el flujo correcto es usar `/admin/users` (tenant-scoped).
 * Este controller existe para holdings con varias filiales en EE.
 */
@ApiTags('Super · Usuarios cross-tenant (EE)')
@ApiBearerAuth()
@Controller('super/users')
@UseGuards(JwtAuthGuard)
export class SuperUsersController {
  constructor(private readonly service: SuperUsersService) {}

  @Get()
  @ApiOperation({
    summary:
      'Lista usuarios de todos los tenants con filtros. Requiere rol super_admin + licencia feat:multi_tenant.real.',
  })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('role') role?: string,
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<SuperUsersListResult> {
    requireSuperAdmin(user);
    return this.service.list({
      search,
      status,
      role,
      tenantId,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }
}
