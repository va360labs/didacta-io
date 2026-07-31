/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { forwardRef, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../../auth/auth.module';
import { ModulesModule } from '../modules.module';
import { FundaeController } from './fundae.controller';
import { FundaeCompaniesController } from './fundae-companies.controller';
import { FundaeGroupsController } from './fundae-groups.controller';
import { FundaeGroupParticipantsController } from './fundae-group-participants.controller';
import { FundaeRlptController } from './fundae-rlpt.controller';
import { FundaeErrorFilter } from './fundae-error.filter';

/// Backend del módulo `mod.fundae`. Encapsula sus 5 controllers (acciones,
/// empresas, grupos, participantes de grupo y notificaciones RLPT) + el
/// filter que mapea `FundaeError → 4xx/5xx con códigos estables`.
///
/// Dependencia con `ModuleRegistryService`: los controllers la inyectan
/// para resolver el módulo runtime y delegar en su servicio. Como
/// `ModuleRegistryService` vive en `ModulesModule` (el padre que también
/// importa `FundaeModule`), la relación es circular en el grafo de
/// NestJS — la rompemos con `forwardRef`.
///
/// Convención sub-módulo (ADR-011): todo el código del módulo (back +
/// front) vive bajo `apps/<api|web>/src/modules/<name>/`. El día que
/// `mod.fundae` se publique como `*.zip` distribuible vía marketplace,
/// este sub-module deja de existir y `ModuleRegistryService` lo carga
/// dinámicamente — la dependencia circular desaparece sola.
@Module({
  imports: [AuthModule, forwardRef(() => ModulesModule)],
  controllers: [
    FundaeController,
    FundaeCompaniesController,
    FundaeGroupsController,
    FundaeGroupParticipantsController,
    FundaeRlptController,
  ],
  providers: [{ provide: APP_FILTER, useClass: FundaeErrorFilter }],
})
export class FundaeModule {}
