/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ModulesModule } from '../modules/modules.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AcademyHomeController } from './academy-home.controller';
import { AcademyHomeService } from './academy-home.service';
import { SiteContextController } from './site-context.controller';

/**
 * Superficie pública de la instancia: lo que se sirve a un visitante SIN
 * sesión, resuelto por el dominio de entrada.
 *
 * Deliberadamente estrecho. Todo lo que se cuelgue aquí es anónimo por
 * definición, así que no debe exponer nada que dependa de un usuario ni
 * revelar qué tenants existen en la instancia.
 */
@Module({
  // AuthModule aporta `PrismaTenantConfigService` (la política de altas de
  // mod.member-registration). `PlatformCheckoutGate` llega solo si
  // `PayoutsModule` está registrado (global en modo plataforma).
  imports: [PrismaModule, ModulesModule, AuthModule],
  controllers: [SiteContextController, AcademyHomeController],
  providers: [AcademyHomeService],
})
export class PublicModule {}
