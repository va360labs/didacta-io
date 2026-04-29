/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * GET /api/v1/branding/options — opciones de branding públicas para el frontend.
 *
 * Disponible en Community sin licencia. Si la capability `feat:white_label`
 * está activa, el flag `whiteLabelEnabled` es true y el frontend puede ocultar
 * el footer "Powered by Didacta" según la configuración del admin.
 */

import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { LicenseService, LICENSE_CAPABILITIES } from '@didacta/license-sdk';
import { BrandingService, type PublicBrandingOptions } from './branding.service';

@ApiTags('branding')
@Controller('branding')
export class BrandingController {
  constructor(
    private readonly branding: BrandingService,
    private readonly license: LicenseService,
  ) {}

  @Get('options')
  @ApiOperation({
    summary: 'Public branding options',
    description:
      'Returns the active branding options for rendering the UI. When the Enterprise capability `feat:white_label` is active, additional flags allow hiding the Didacta brand in the footer.',
  })
  @ApiResponse({
    status: 200,
    description: 'Public branding options.',
    schema: {
      example: {
        logoUrl: '/assets/didacta-logo.svg',
        primaryColor: '#2563eb',
        poweredByDidacta: true,
        whiteLabelEnabled: false,
      },
    },
  })
  getOptions(): PublicBrandingOptions {
    const whiteLabelEnabled = this.license.isCapabilityEnabled(
      LICENSE_CAPABILITIES.WHITE_LABEL,
    );
    return this.branding.getPublicOptions(whiteLabelEnabled);
  }
}
