/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * SsoSamlModule — 9º piloto License SDK (`feat:sso.saml`).
 *
 * Wire de dependencias:
 *   - PrismaService (vía PrismaModule global) para upsert de users + lookup tenants.
 *   - PrismaTenantConfigService + PrismaAuditLogService + TokenService re-exportados
 *     por AuthModule (mismo patrón que OIDC, SCIM, custom-domains, mfa-policy).
 *
 * El controller declara `Controller('auth/saml')` y se monta bajo el prefijo
 * global `/api/v1`, así que las URLs son:
 *   - GET  /api/v1/auth/saml/:tenantSlug/status
 *   - GET  /api/v1/auth/saml/:tenantSlug/login
 *   - POST /api/v1/auth/saml/:tenantSlug/acs
 *   - GET  /api/v1/auth/saml/:tenantSlug/metadata
 *
 * El admin endpoint /admin/sso/saml/config vive en AdminModule (no aquí) para
 * mantener la separación pública/admin que ya tienen scim, custom-domains y oidc.
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { SamlController } from './saml.controller';
import { SamlService } from './saml.service';

@Module({
  imports: [AuthModule],
  controllers: [SamlController],
  providers: [SamlService],
  exports: [SamlService],
})
export class SsoSamlModule {}
