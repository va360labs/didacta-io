/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * GET /api/license — devuelve el estado público de la licencia para el
 * frontend. Sin secretos: solo edition + organizationName + capabilities
 * activas + warnings + expiresAt.
 *
 * El frontend lo consume vía useLicense() hook (`@didacta/license-sdk/react`).
 */

import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  LicenseService,
  toPublicLicenseState,
  type PublicLicenseState,
} from '@didacta/license-sdk';

@ApiTags('license')
@Controller('api')
export class LicenseController {
  constructor(private readonly license: LicenseService) {}

  @Get('license')
  @ApiOperation({
    summary: 'Public license state',
    description:
      'Returns the current license state in a public-safe shape. Used by the frontend to know which Enterprise capabilities are active and to warn the admin if the license is about to expire. No secrets are exposed.',
  })
  @ApiResponse({
    status: 200,
    description: 'Public license state.',
    schema: {
      example: {
        status: 'community',
        capabilities: [],
        warnings: [],
      },
    },
  })
  getState(): PublicLicenseState {
    return toPublicLicenseState(this.license.getState());
  }
}
