import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ModulesModule } from '../modules/modules.module';
import { AdminModulesController } from './admin-modules.controller';
import { AdminStatsController } from './admin-stats.controller';
import { AdminStatsService } from './admin-stats.service';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { CustomDomainsController } from './custom-domains/custom-domains.controller';
import { CustomDomainsService } from './custom-domains/custom-domains.service';

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
  imports: [AuthModule, ModulesModule],
  controllers: [
    AdminUsersController,
    AdminTenantsController,
    AdminModulesController,
    AdminStatsController,
    // Cuarto piloto License SDK — gate feat:custom_domains end-to-end.
    CustomDomainsController,
  ],
  providers: [AdminUsersService, AdminTenantsService, AdminStatsService, CustomDomainsService],
  exports: [AdminUsersService, AdminTenantsService, AdminStatsService],
})
export class AdminModule {}
