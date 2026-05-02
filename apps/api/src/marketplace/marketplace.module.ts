import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ModulesModule } from '../modules/modules.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminMarketplaceController } from './admin-marketplace.controller';
import { InstalledModuleService } from './installed-module.service';
import { InstallPackageService } from './install-package.service';
import { MarketplaceErrorFilter } from './marketplace-error.filter';
import { ModuleLintService } from './module-lint.service';
import { ModuleMigrationService } from './module-migration.service';
import { ModulePackageService } from './module-package.service';
import { ModuleSandboxService } from './module-sandbox.service';
import { ModuleSignatureService } from './module-signature.service';

/// Marketplace de módulos (ADR-009).
///
/// Estado por PR:
///   - PR A: validador de paquetes + verificador de firma.
///   - PR B: endpoint `POST /admin/modules/install` + storage + persistencia
///     del row `InstalledModule`.
///   - PR C: lint estático del bundle + boot del módulo en VM aislada
///     (`node:vm`) + ejecución del hook `onInstall(ctx)`.
///   - PR D (este PR): aplicación de las migraciones SQL del paquete
///     (`prisma/migrations/*.sql`) dentro de transacción Prisma + linter
///     SQL que enforce `tablePrefix` y rechaza FKs cross-module. Aún sin
///     enrutado HTTP del módulo (DynamicModule llega en PR E) ni UI
///     super_admin (PR F).
///
/// Importa `AuthModule` para el `JwtAuthGuard` (regla de oro NestJS de este
/// repo: cualquier módulo con `JwtAuthGuard` importa `AuthModule`).
/// Importa `ModulesModule` para reusar el `ModuleContextFactory` que ya
/// resuelve el storage backend según `STORAGE_DRIVER`.
@Module({
  imports: [PrismaModule, AuthModule, ModulesModule],
  controllers: [AdminMarketplaceController],
  providers: [
    ModuleSignatureService,
    ModulePackageService,
    ModuleLintService,
    ModuleSandboxService,
    ModuleMigrationService,
    InstalledModuleService,
    InstallPackageService,
    MarketplaceErrorFilter,
  ],
  exports: [ModuleSignatureService, ModulePackageService, InstalledModuleService],
})
export class MarketplaceModule {}
