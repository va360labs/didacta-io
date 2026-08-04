/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Post,
  Put,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { LicenseAdminService, type AdminLicenseStatusDto } from './license-admin.service';

const SetKeySchema = z.object({
  key: z.string().min(1).max(8192),
});

function requireSuperAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.includes('super_admin')) {
    throw new ForbiddenException('Solo super_admin puede gestionar la licencia de la instalación.');
  }
  return user;
}

/**
 * `/admin/licencia`: pegar la clave, validación en vivo, estado
 * (community/active/grace/expired/invalid/dev), plan, organización,
 * expiración, capabilities activas y warnings — B1 de
 * `work/migracion-env-a-panel.md`.
 */
@ApiTags('Admin License')
@ApiBearerAuth()
@Controller('admin/license')
@UseGuards(JwtAuthGuard)
export class LicenseAdminController {
  constructor(private readonly admin: LicenseAdminService) {}

  @Get()
  @ApiOperation({ summary: 'Estado actual de la licencia de la instalación' })
  async getStatus(@CurrentUser() user: SessionClaims | undefined): Promise<AdminLicenseStatusDto> {
    requireSuperAdmin(user);
    return this.admin.getStatus();
  }

  @Put()
  @ApiOperation({
    summary: 'Activa una licencia. Valida la firma antes de persistir; rechaza si es inválida.',
  })
  async setKey(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(SetKeySchema)) body: z.infer<typeof SetKeySchema>,
  ): Promise<AdminLicenseStatusDto> {
    const claims = requireSuperAdmin(user);
    return this.admin.setKey(body.key, claims.sub);
  }

  @Delete()
  @ApiOperation({
    summary: 'Quita la licencia guardada en el panel (vuelve a community o al env si hay)',
  })
  async clearKey(@CurrentUser() user: SessionClaims | undefined): Promise<AdminLicenseStatusDto> {
    const claims = requireSuperAdmin(user);
    return this.admin.clearKey(claims.sub);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Re-evalúa el estado (expiración/gracia) sin cambiar la clave' })
  async refresh(@CurrentUser() user: SessionClaims | undefined): Promise<AdminLicenseStatusDto> {
    requireSuperAdmin(user);
    return this.admin.getStatus();
  }
}
