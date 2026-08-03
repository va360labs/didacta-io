/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Enterprise
 *
 * This file is part of Didacta Enterprise Edition and is licensed under the
 * Didacta Enterprise License (LICENSE_EE). It cannot be used in production
 * without a valid Didacta Enterprise license key. See LICENSE_EE for details.
 *
 * WhiteLabelController — endpoints EE gateados por @RequiresCapability.
 * Ruta base: /api/v1/branding/white-label.
 *
 * Sin licencia EE válida, cada endpoint devuelve 402 Payment Required vía
 * LicenseExceptionFilter (registrado globalmente en main.ts).
 */

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { LICENSE_CAPABILITIES, RequiresCapability } from '@didacta/license-sdk';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import {
  configureWhiteLabelDtoSchema,
  type ConfigureWhiteLabelDto,
} from './dto/configure-white-label.dto';
import { WhiteLabelService } from './white-label.service.ee';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

/**
 * La capability gatea la EDICIÓN (licencia), no la IDENTIDAD: sin este check,
 * en una instalación con licencia EE cualquier request anónima podía leer y
 * reconfigurar el branding white-label.
 */
function requireAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException('Configurar white-label requiere rol de administrador.');
  }
  return user;
}

@ApiTags('branding')
@ApiBearerAuth()
@Controller('branding/white-label')
@UseGuards(JwtAuthGuard)
export class WhiteLabelController {
  constructor(private readonly whiteLabel: WhiteLabelService) {}

  @Get('preview')
  @RequiresCapability(LICENSE_CAPABILITIES.WHITE_LABEL)
  @ApiOperation({
    summary: 'Preview current white-label state (Enterprise)',
    description:
      'Returns the raw branding state plus a flag indicating that this Enterprise license can hide the Didacta brand. Requires capability `feat:white_label` and an admin session.',
  })
  @ApiResponse({ status: 200, description: 'Current white-label state.' })
  @ApiResponse({ status: 402, description: 'Capability `feat:white_label` not licensed.' })
  preview(@CurrentUser() user: SessionClaims | undefined) {
    requireAdmin(user);
    return this.whiteLabel.preview();
  }

  @Post('configure')
  @RequiresCapability(LICENSE_CAPABILITIES.WHITE_LABEL)
  @ApiOperation({
    summary: 'Configure white-label branding (Enterprise)',
    description:
      'Allows the tenant admin to override logo, primary color and hide the Didacta brand. Requires capability `feat:white_label` and an admin session.',
  })
  @ApiResponse({ status: 200, description: 'White-label applied.' })
  @ApiResponse({ status: 402, description: 'Capability `feat:white_label` not licensed.' })
  configure(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(configureWhiteLabelDtoSchema)) body: ConfigureWhiteLabelDto,
  ) {
    requireAdmin(user);
    return this.whiteLabel.configure(body);
  }
}
