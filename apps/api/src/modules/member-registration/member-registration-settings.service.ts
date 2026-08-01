/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Logger } from '@nestjs/common';
import { MemberRegistrationSettings } from '@didacta/mod-member-registration';
import { PrismaTenantConfigService } from '../prisma-tenant-config.service';

/**
 * Wrapper NestJS del resolutor de settings del módulo: la cascada
 * tenant_setting → env legacy → none vive en `modules/member-registration/`;
 * aquí solo se inyecta PrismaTenantConfigService como puerto de config (los
 * secretos llegan ya descifrados) y el Logger del host.
 */
@Injectable()
export class MemberRegistrationSettingsService extends MemberRegistrationSettings {
  constructor(tenantConfig: PrismaTenantConfigService) {
    super(tenantConfig, new Logger(MemberRegistrationSettingsService.name));
  }
}
