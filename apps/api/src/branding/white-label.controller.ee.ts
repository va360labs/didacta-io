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
 *
 * Solo `super_admin`. El estado que tocan estos endpoints es GLOBAL: vive en
 * `BrandingService`, un singleton en memoria que comparten todos los tenants
 * de la instalación. Un `tenant_admin` que lo cambie se lo cambia a todos.
 * La marca propia de cada tenant (logo, colores, CSS) no pasa por aquí: va por
 * mod.theming, que sí es por tenant y sí es cosa de su `tenant_admin`.
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

/**
 * La capability gatea la EDICIÓN (licencia), no la IDENTIDAD: sin este check,
 * en una instalación con licencia EE cualquier request anónima podía leer y
 * reconfigurar el branding white-label.
 *
 * Y la identidad que hace falta es `super_admin`, no «algún admin»: en una
 * instalación con varios tenants, `tenant_admin` es el administrador de UNO, y
 * este estado es de todos.
 */
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
      'Returns the raw branding state plus a flag indicating that this Enterprise license can hide the Didacta brand. The state is global to the installation. Requires capability `feat:white_label` and a `super_admin` session.',
  })
  @ApiResponse({ status: 200, description: 'Current white-label state.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid session.' })
  @ApiResponse({ status: 402, description: 'Capability `feat:white_label` not licensed.' })
  @ApiResponse({ status: 403, description: 'Requires the `super_admin` role.' })
  preview(@CurrentUser() user: SessionClaims | undefined) {
    requireSuperAdmin(user);
    return this.whiteLabel.preview();
  }

  @Post('configure')
  @RequiresCapability(LICENSE_CAPABILITIES.WHITE_LABEL)
  @ApiOperation({
    summary: 'Configure white-label branding (Enterprise)',
    description:
      'Allows a super admin to override logo, primary color and hide the Didacta brand. The state is global to the installation: it applies to every tenant. Requires capability `feat:white_label` and a `super_admin` session.',
  })
  @ApiResponse({ status: 200, description: 'White-label applied.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid session.' })
  @ApiResponse({ status: 402, description: 'Capability `feat:white_label` not licensed.' })
  @ApiResponse({ status: 403, description: 'Requires the `super_admin` role.' })
  configure(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(configureWhiteLabelDtoSchema)) body: ConfigureWhiteLabelDto,
  ) {
    requireSuperAdmin(user);
    return this.whiteLabel.configure(body);
  }
}
