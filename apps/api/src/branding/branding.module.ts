/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * BrandingModule — registra controllers de branding (CE) y white-label (EE).
 *
 * IMPORTANTE: el patrón aquí es el aceptado para capabilities Enterprise
 * transversales del core: el .module.ts (CE) registra controllers `.ee.ts`
 * dentro del array `controllers` del @Module decorator. Los endpoints EE
 * están gateados a runtime por @RequiresCapability — sin licencia válida
 * el LicenseGuard rechaza con 402.
 *
 * El bundle final SIEMPRE contiene el código EE (no hay builds CE/EE
 * separados). Lo que cambia es el comportamiento runtime.
 *
 * ee-fence acepta este patrón en archivos `*.module.ts` que solo registran
 * los controllers EE (sin invocar lógica de negocio). Ver scripts/ee-fence.ts.
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrandingController } from './branding.controller';
import { BrandingService } from './branding.service';
import { WhiteLabelController } from './white-label.controller.ee';
import { WhiteLabelService } from './white-label.service.ee';

// AuthModule aporta TokenService, dependencia del JwtAuthGuard que protege
// WhiteLabelController (sin este import el DI del guard revienta el boot).
@Module({
  imports: [AuthModule],
  controllers: [BrandingController, WhiteLabelController],
  providers: [BrandingService, WhiteLabelService],
  exports: [BrandingService],
})
export class BrandingModule {}
