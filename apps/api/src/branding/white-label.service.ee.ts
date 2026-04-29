/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Enterprise
 *
 * This file is part of Didacta Enterprise Edition and is licensed under the
 * Didacta Enterprise License (LICENSE_EE). It cannot be used in production
 * without a valid Didacta Enterprise license key. See LICENSE_EE for details.
 *
 * WhiteLabelService — lógica EE para configurar branding completo del tenant:
 * cambiar logo, colores, ocultar marca Didacta. Requiere licencia con la
 * capability `feat:white_label`.
 */

import { Injectable } from '@nestjs/common';
import { BrandingService } from './branding.service';
import type { ConfigureWhiteLabelDto } from './dto/configure-white-label.dto';

@Injectable()
export class WhiteLabelService {
  constructor(private readonly branding: BrandingService) {}

  configure(input: ConfigureWhiteLabelDto): {
    applied: ConfigureWhiteLabelDto;
    state: ReturnType<BrandingService['getRawState']>;
  } {
    if (input.logoUrl !== undefined) {
      this.branding.setLogoUrl(input.logoUrl);
    }
    if (input.primaryColor !== undefined) {
      this.branding.setPrimaryColor(input.primaryColor);
    }
    if (input.poweredByDidacta !== undefined) {
      this.branding.setPoweredByDidacta(input.poweredByDidacta);
    }

    return {
      applied: input,
      state: this.branding.getRawState(),
    };
  }

  preview(): {
    state: ReturnType<BrandingService['getRawState']>;
    canHideBrand: boolean;
  } {
    return {
      state: this.branding.getRawState(),
      canHideBrand: true,
    };
  }
}
