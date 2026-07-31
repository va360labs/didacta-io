/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { WpSsoController } from './wp-sso.controller';
import { WpSsoService } from './wp-sso.service';
import { WpSsoConfigService } from './wp-sso-config.service';

/**
 * SsoWpModule — SSO desde WordPress (mod.wp-sso). Community, sin gate EE.
 *
 * Reutiliza de AuthModule: PrismaService (global), TokenService,
 * PrismaAuditLogService y PrismaTenantConfigService — mismo patrón que
 * SsoOidcModule/SsoSamlModule.
 *
 * Config POR TENANT, cifrada en BD (WpSsoConfigService) — NO env. El admin la
 * gestiona desde /admin/sso-wordpress (WpSsoAdminController en AdminModule).
 *
 * URLs públicas (prefijo global /api/v1):
 *   - GET /api/v1/modules/wp-sso/:tenantSlug/callback?token=...
 *   - GET /api/v1/modules/wp-sso/:tenantSlug/status
 */
@Module({
  imports: [AuthModule],
  controllers: [WpSsoController],
  providers: [WpSsoService, WpSsoConfigService],
  exports: [WpSsoService, WpSsoConfigService],
})
export class SsoWpModule {}
