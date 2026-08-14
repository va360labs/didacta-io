/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ModulesModule } from '../modules/modules.module';
import { SsoOidcModule } from '../sso/oidc/oidc.module';
import { SsoSamlModule } from '../sso/saml/saml.module';
import { SsoWpModule } from '../sso/wp/wp-sso.module';
import { AdminAcademyController } from './admin-academy.controller';
import { AdminApiKeysController } from './admin-api-keys.controller';
import { AdminModulesController } from './admin-modules.controller';
import { AdminProvisioningController } from './admin-provisioning.controller';
import { AdminSmtpController } from './admin-smtp.controller';
import { AdminStripeController } from './admin-stripe.controller';
import { AdminStatsController } from './admin-stats.controller';
import { AdminStatsService } from './admin-stats.service';
import { AdminBusinessMetricsController } from './admin-business-metrics.controller';
import { AdminImagesController } from './admin-images.controller';
import { AdminImagesService } from './admin-images.service';
import { AdminBusinessMetricsService } from './admin-business-metrics.service';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { CustomDomainsController } from './custom-domains/custom-domains.controller';
import { CustomDomainsService } from './custom-domains/custom-domains.service';
import { ScimAdminTokenController } from './scim/scim-admin.controller';
import { OidcAdminController } from './sso/oidc-admin.controller';
import { SamlAdminController } from './sso/saml-admin.controller';
import { WpSsoAdminController } from './sso/wp-sso-admin.controller';
import { SuperUsersController } from './super/super-users.controller';
import { SuperUsersService } from './super/super-users.service';
import { SupportAccessController } from './support-access.controller';
import { SupportAccessService } from './support-access.service';

/**
 * Módulo administrativo: agrupa controllers y services destinados al panel
 * /admin/* (gestión de usuarios, roles, tenants, auditoría, branding, módulos,
 * stats).
 *
 * Importa AuthModule para reusar PrismaAuditLogService, PrismaTenantConfigService,
 * SmtpAdapterService y PasswordResetService sin duplicar providers.
 *
 * Importa ModulesModule para reusar TenantModulesService (HU-TA-002).
 */
@Module({
  imports: [AuthModule, ModulesModule, SsoOidcModule, SsoSamlModule, SsoWpModule],
  controllers: [
    InvitationsController,
    AdminUsersController,
    AdminTenantsController,
    AdminModulesController,
    AdminStatsController,
    // Bloque 7 — KPIs de negocio (/admin/metricas): NPS, ventas, impagos,
    // altas/bajas, conexiones y uso del tutor IA, todo de la BD local.
    AdminBusinessMetricsController,
    // Reoptimización del histórico de imágenes (/admin/imagenes). Lo que se
    // sube nuevo ya nace optimizado en la capa de storage.
    AdminImagesController,
    // Gestión de API keys del tenant (Administración → Claves API). Reusa
    // ApiKeyService + PrismaAuditLogService de AuthModule (ya importado).
    AdminApiKeysController,
    // Identidad de la PROPIA academia (nombre + dirección). Existe aparte de
    // AdminTenantsController porque aquel exige super_admin al recibir un id
    // ajeno: el dueño de una academia es tenant_admin y no podía ni ponerle
    // nombre a la suya. Este no acepta id, opera sobre el tenant del token.
    AdminAcademyController,
    // SMTP per-tenant — GET/PUT/POST test. Wrappea el almacenamiento
    // genérico de tenant_setting con un contrato dedicado (alpha.75).
    AdminSmtpController,
    // Stripe per-tenant (Administración → Pagos) — GET/PUT/POST test, mismo
    // patrón que AdminSmtpController. Comparte credenciales entre mod.billing
    // y mod.subscriptions (TenantStripeResolverService).
    AdminStripeController,
    // Cuarto piloto License SDK — gate feat:custom_domains end-to-end.
    CustomDomainsController,
    // Séptimo piloto License SDK — gestión del token SCIM por tenant.
    // Los endpoints /scim/v2/* viven en ScimModule (AppModule); este
    // controller solo gestiona el bearer token estático (admin con JWT).
    ScimAdminTokenController,
    // 8º piloto License SDK — gestión config OIDC del tenant. Reutiliza
    // OidcService importado vía SsoOidcModule.
    OidcAdminController,
    // 9º piloto License SDK — gestión config SAML del tenant. Reutiliza
    // SamlService importado vía SsoSamlModule.
    SamlAdminController,
    // WP-SSO (Community, sin gate EE) — gestión config por tenant desde
    // /admin/sso-wordpress. Reutiliza WpSsoConfigService vía SsoWpModule.
    WpSsoAdminController,
    // Follow-up `feat:multi_tenant.real` — listings cross-tenant para
    // super_admin (holdings con varias filiales). Gateado por capability EE.
    SuperUsersController,
    // UC-C103 — emisión/revocación de la credencial de provisioning que usa un
    // plano de control externo (Didacta Cloud, o el script de cualquier
    // self-hoster) sobre la lista blanca de rutas de tenants.
    AdminProvisioningController,
    // U8 — canje del acceso de soporte. Es la ÚNICA ruta pública de este
    // módulo: quien canjea todavía no tiene sesión, precisamente está pidiendo
    // una. Lo que la protege es el token de un solo uso que trae en el cuerpo.
    SupportAccessController,
  ],
  providers: [
    InvitationsService,
    AdminUsersService,
    AdminTenantsService,
    AdminStatsService,
    AdminBusinessMetricsService,
    AdminImagesService,
    CustomDomainsService,
    SuperUsersService,
    // U8 — emisión, revocación y canje del acceso de soporte de vida corta.
    SupportAccessService,
  ],
  exports: [
    AdminUsersService,
    AdminTenantsService,
    AdminStatsService,
    SuperUsersService,
    // Lo consume MeController para pintar el banner del aula mientras dura un
    // acceso de soporte.
    SupportAccessService,
  ],
})
export class AdminModule {}
