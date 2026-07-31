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

import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { LICENSE_CAPABILITIES, RequiresCapability } from '@didacta/license-sdk';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import {
  configureWhiteLabelDtoSchema,
  type ConfigureWhiteLabelDto,
} from './dto/configure-white-label.dto';
import { WhiteLabelService } from './white-label.service.ee';

@ApiTags('branding')
@ApiBearerAuth()
@Controller('branding/white-label')
export class WhiteLabelController {
  constructor(private readonly whiteLabel: WhiteLabelService) {}

  @Get('preview')
  @RequiresCapability(LICENSE_CAPABILITIES.WHITE_LABEL)
  @ApiOperation({
    summary: 'Preview current white-label state (Enterprise)',
    description:
      'Returns the raw branding state plus a flag indicating that this Enterprise license can hide the Didacta brand. Requires capability `feat:white_label`.',
  })
  @ApiResponse({ status: 200, description: 'Current white-label state.' })
  @ApiResponse({ status: 402, description: 'Capability `feat:white_label` not licensed.' })
  preview() {
    return this.whiteLabel.preview();
  }

  @Post('configure')
  @RequiresCapability(LICENSE_CAPABILITIES.WHITE_LABEL)
  @ApiOperation({
    summary: 'Configure white-label branding (Enterprise)',
    description:
      'Allows the tenant admin to override logo, primary color and hide the Didacta brand. Requires capability `feat:white_label`.',
  })
  @ApiResponse({ status: 200, description: 'White-label applied.' })
  @ApiResponse({ status: 402, description: 'Capability `feat:white_label` not licensed.' })
  configure(
    @Body(new ZodValidationPipe(configureWhiteLabelDtoSchema)) body: ConfigureWhiteLabelDto,
  ) {
    return this.whiteLabel.configure(body);
  }
}
