/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Module } from '@nestjs/common';
import { ModulesModule } from '../modules/modules.module';
import { PrismaModule } from '../prisma/prisma.module';
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
  imports: [PrismaModule, ModulesModule],
  controllers: [SiteContextController],
})
export class PublicModule {}
