import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ModulesModule } from '../modules/modules.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminMarketplaceController } from './admin-marketplace.controller';
import { ModuleAssetsController } from './module-assets.controller';
import { InstalledModuleService } from './installed-module.service';
import { InstallPackageService } from './install-package.service';
import { MarketplaceErrorFilter } from './marketplace-error.filter';
import { ModuleLintService } from './module-lint.service';
import { ModuleMigrationService } from './module-migration.service';
import { ModulePackageService } from './module-package.service';
import { ModuleRouterService } from './module-router.service';
import { ModuleSandboxService } from './module-sandbox.service';
import { ModuleSignatureService } from './module-signature.service';
import { ModulesDispatcherController } from './modules-dispatcher.controller';
import { RateLimiterService } from './rate-limiter.service';
import { SandboxedDbService } from './sandboxed-db.service';
import { ScopedDidactaApiFactory } from './sandboxed-didacta.service';
import { SandboxedHttpService } from './sandboxed-http.service';
import { AdminUsersService } from '../admin/admin-users.service';
import { PasswordResetService } from '../auth/password-reset.service';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';

/// Marketplace de módulos (ADR-009).
///
/// Estado por PR:
///   - PR A: validador de paquetes + verificador de firma.
///   - PR B: endpoint `POST /admin/modules/install` + storage + persistencia
///     del row `InstalledModule`.
///   - PR C: lint estático del bundle + boot del módulo en VM aislada
///     (`node:vm`) + ejecución del hook `onInstall(ctx)`.
///   - PR D: aplicación de las migraciones SQL del paquete
///     (`prisma/migrations/*.sql`) dentro de transacción Prisma + linter
///     SQL que enforce `tablePrefix` y rechaza FKs cross-module.
///   - PR E (este PR): runtime router + dispatcher controller. Las
///     `routes` declaradas por un módulo en su `module.exports` se
///     enrutan automáticamente bajo `/api/v1<apiNamespace>/...` sin
///     restart de la API. Sin UI super_admin todavía (PR F).
///
/// Importa `AuthModule` para el `JwtAuthGuard` (regla de oro NestJS de este
/// repo: cualquier módulo con `JwtAuthGuard` importa `AuthModule`).
/// Importa `ModulesModule` para reusar el `ModuleContextFactory` que ya
/// resuelve el storage backend según `STORAGE_DRIVER`.
@Module({
  imports: [PrismaModule, AuthModule, ModulesModule],
  controllers: [AdminMarketplaceController, ModulesDispatcherController, ModuleAssetsController],
  providers: [
    ModuleSignatureService,
    ModulePackageService,
    ModuleLintService,
    ModuleSandboxService,
    ModuleMigrationService,
    ModuleRouterService,
    InstalledModuleService,
    InstallPackageService,
    SandboxedHttpService,
    SandboxedDbService,
    ScopedDidactaApiFactory,
    AdminUsersService,
    PasswordResetService,
    PrismaAuditLogService,
    RateLimiterService,
    MarketplaceErrorFilter,
  ],
  exports: [
    ModuleSignatureService,
    ModulePackageService,
    InstalledModuleService,
    ModuleRouterService,
  ],
})
export class MarketplaceModule {}
