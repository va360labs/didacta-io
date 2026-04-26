import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

/**
 * Módulo administrativo: agrupa controllers y services destinados al panel
 * /admin/* (gestión de usuarios, roles, tenants, auditoría, branding, etc.).
 *
 * Importa AuthModule para reusar PrismaAuditLogService, PrismaTenantConfigService,
 * SmtpAdapterService y PasswordResetService sin duplicar providers.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminUsersController, AdminTenantsController],
  providers: [AdminUsersService, AdminTenantsService],
  exports: [AdminUsersService, AdminTenantsService],
})
export class AdminModule {}
