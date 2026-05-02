import { Module } from '@nestjs/common';
import { VersionCheckController } from './version-check.controller';

/// Endpoints transversales del sistema (no atan a un módulo). Hoy: el
/// proxy de Docker Hub para el banner "hay versión nueva" del sidebar.
/// Mañana puede absorber otros: telemetría server, healthchecks
/// extendidos, info de build (commit/sha), etc.
@Module({
  controllers: [VersionCheckController],
})
export class SystemModule {}
