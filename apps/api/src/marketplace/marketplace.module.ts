import { Module } from '@nestjs/common';
import { ModulePackageService } from './module-package.service';
import { ModuleSignatureService } from './module-signature.service';

/// Marketplace de módulos — fundaciones (PR A de ADR-009).
///
/// Solo expone los servicios de validación de paquetes `*.didactamod`. El
/// endpoint `POST /admin/modules/install`, el storage S3 y el boot en VM
/// llegan en PRs siguientes (B y C). Sin esos pasos, la activación dinámica
/// de módulos NO está disponible — hay que tratar este módulo como
/// infraestructura inerte que el resto de la app aún no consume.
@Module({
  providers: [ModuleSignatureService, ModulePackageService],
  exports: [ModuleSignatureService, ModulePackageService],
})
export class MarketplaceModule {}
