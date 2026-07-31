/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiScopeGuard } from '../auth/api-scope.guard';
import { ModulesModule } from '../modules/modules.module';
import { InscribeController } from './inscribe.controller';
import { InscribeService } from './inscribe.service';

/**
 * Inscripción externa por API (`POST /api/v1/inscribe`).
 *
 * Importa AuthModule (JwtOrApiKeyGuard, PasswordService, SMTP, audit) y
 * ModulesModule (ModuleRegistryService → mod.learning). El endpoint NO vive
 * en un módulo de marketplace: es infra del host que conecta auth + enrollment
 * para compras que ocurren fuera de Didacta.
 */
@Module({
  imports: [AuthModule, ModulesModule],
  controllers: [InscribeController],
  providers: [InscribeService, ApiScopeGuard],
})
export class InscribeModule {}
