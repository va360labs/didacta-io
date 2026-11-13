/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ModulesModule } from '../modules/modules.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SimpleModeController } from './simple-mode.controller';
import { SimpleModeService } from './simple-mode.service';

/**
 * Modo sencillo del aula: alta en 3 preguntas, «Empieza aquí» y publicar con
 * un botón. Infraestructura del host (como `/setup`): orquesta los servicios
 * públicos de los módulos a través de `ModuleRegistryService`.
 *
 * `PlatformCheckoutGate` llega solo si `PayoutsModule` está registrado (global
 * en modo plataforma); por eso el servicio lo recibe `@Optional()`.
 */
@Module({
  imports: [PrismaModule, AuthModule, ModulesModule],
  controllers: [SimpleModeController],
  providers: [SimpleModeService],
})
export class SimpleModeModule {}
