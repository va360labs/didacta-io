import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ModulesModule } from '../modules/modules.module';
import { SsoOidcModule } from '../sso/oidc/oidc.module';
import { SsoSamlModule } from '../sso/saml/saml.module';
import { AdminModulesController } from './admin-modules.controller';
import { AdminStatsController } from './admin-stats.controller';
import { AdminStatsService } from './admin-stats.service';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { CustomDomainsController } from './custom-domains/custom-domains.controller';
import { CustomDomainsService } from './custom-domains/custom-domains.service';
import { ScimAdminTokenController } from './scim/scim-admin.controller';
import { OidcAdminController } from './sso/oidc-admin.controller';
import { SamlAdminController } from './sso/saml-admin.controller';
import { SuperUsersController } from './super/super-users.controller';
import { SuperUsersService } from './super/super-users.service';

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
  imports: [AuthModule, ModulesModule, SsoOidcModule, SsoSamlModule],
  controllers: [
    AdminUsersController,
    AdminTenantsController,
    AdminModulesController,
    AdminStatsController,
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
    // Follow-up `feat:multi_tenant.real` — listings cross-tenant para
    // super_admin (holdings con varias filiales). Gateado por capability EE.
    SuperUsersController,
  ],
  providers: [
    AdminUsersService,
    AdminTenantsService,
    AdminStatsService,
    CustomDomainsService,
    SuperUsersService,
  ],
  exports: [AdminUsersService, AdminTenantsService, AdminStatsService, SuperUsersService],
})
export class AdminModule {}
