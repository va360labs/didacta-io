import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ModulesModule } from '../modules/modules.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminMarketplaceController } from './admin-marketplace.controller';
import { InstalledModuleService } from './installed-module.service';
import { InstallPackageService } from './install-package.service';
import { MarketplaceErrorFilter } from './marketplace-error.filter';
import { ModulePackageService } from './module-package.service';
import { ModuleSignatureService } from './module-signature.service';

/// Marketplace de módulos (ADR-009).
///
/// Estado por PR:
///   - PR A (mergeado): validador de paquetes + verificador de firma.
///   - PR B (este PR): endpoint `POST /admin/modules/install` + storage +
///     persistencia del row `InstalledModule`. Sin ejecutar el módulo aún.
///   - PR C: VM aislada, `DynamicModule` hot-reload, UI super_admin.
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
    InstalledModuleService,
    InstallPackageService,
    MarketplaceErrorFilter,
  ],
  exports: [ModuleSignatureService, ModulePackageService, InstalledModuleService],
})
export class MarketplaceModule {}
