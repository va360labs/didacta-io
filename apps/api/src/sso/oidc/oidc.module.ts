/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * SsoOidcModule — 8º piloto License SDK (`feat:sso.oidc`).
 *
 * Wire de dependencias:
 *   - PrismaService (vía PrismaModule global) para upsert de users + lookup tenants.
 *   - PrismaTenantConfigService + PrismaAuditLogService + TokenService re-exportados
 *     por AuthModule (mismo patrón que custom-domains, scim, mfa-policy).
 *
 * El controller declara `Controller('auth/oidc')` y se monta bajo el prefijo
 * global `/api/v1`, así que las URLs son:
 *   - GET /api/v1/auth/oidc/:tenantSlug/start
 *   - GET /api/v1/auth/oidc/callback
 *
 * El admin endpoint /admin/sso/oidc/config vive en AdminModule (no aquí) para
 * mantener la separación pública/admin que ya tienen scim y custom-domains.
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { OidcController } from './oidc.controller';
import { OidcService } from './oidc.service';

@Module({
  imports: [AuthModule],
  controllers: [OidcController],
  providers: [OidcService],
  exports: [OidcService],
})
export class SsoOidcModule {}
