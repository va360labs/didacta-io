/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { forwardRef, Inject, Module, type BeforeApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModuleRegistryService } from '../module-registry.service';
import { ModulesModule } from '../modules.module';
import { SoporteErrorFilter } from './soporte-error.filter';
import { SoporteController } from './soporte.controller';

/// Backend del módulo `mod.soporte` («Ayuda y sugerencias»): controller fino y
/// filtro de errores. El servicio lo construye el ModuleRegistryService
/// (exportado por ModulesModule); AuthModule aporta el JwtAuthGuard;
/// PrismaModule es global (el nombre del autor).
///
/// Convención sub-módulo (ADR-011): forwardRef recíproco con ModulesModule.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [SoporteController],
  providers: [{ provide: APP_FILTER, useClass: SoporteErrorFilter }],
})
export class SoporteModule implements BeforeApplicationShutdown {
  constructor(
    @Inject(forwardRef(() => ModuleRegistryService))
    private readonly registry: ModuleRegistryService,
  ) {}

  /**
   * Los avisos de un ticket salen en segundo plano, justo después de responder.
   * Si el contenedor se para en ese instante (un despliegue), se les da unos
   * segundos para terminar en vez de cortar un correo a medias.
   */
  async beforeApplicationShutdown(): Promise<void> {
    try {
      await this.registry.getSoporteService().esperarAvisos(8_000);
    } catch {
      // Sin servicio (arranque a medias) no hay nada que esperar.
    }
  }
}
