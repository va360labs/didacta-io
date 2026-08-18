/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiScopeGuard } from '../auth/api-scope.guard';
import { ModulesModule } from '../modules/modules.module';
import { IntegrationsController } from './integrations.controller';
import { MePurchasesController } from './me-purchases.controller';
import { IntegrationsService } from './integrations.service';

/**
 * API de lectura para integradores externos (`/api/v1/integrations`).
 *
 * Misma naturaleza que `InscribeModule`: infra del host, no un módulo del
 * marketplace. `/inscribe` es la mitad de escritura de esta integración (dar
 * de alta y de baja a un comprador) y `/integrations` es la de lectura (pintar
 * la ficha y saber por dónde va el alumno).
 *
 * Importa AuthModule por `JwtOrApiKeyGuard` y ModulesModule por el registry
 * (mod.billing, para la oferta). TenantResolverService y PrismaService llegan
 * de módulos globales.
 *
 * `MePurchasesController` cuelga de aquí y no de `MeController` porque comparte
 * el servicio: es la misma tabla vista desde el otro lado del mostrador —el
 * alumno mirando sus compras en vez de la tienda mirando las de él— y separarla
 * en otro módulo obligaría a exportar el servicio para nada.
 */
@Module({
  imports: [AuthModule, ModulesModule],
  controllers: [IntegrationsController, MePurchasesController],
  providers: [IntegrationsService, ApiScopeGuard],
})
export class IntegrationsModule {}
