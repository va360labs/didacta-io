/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * RegistryModule — opt-in de instalaciones Community contra Cloud god.
 *
 * No es una capability EE: el opt-in está disponible para cualquier
 * instalación Community. Lo que el opt-in habilita en Cloud god (newsletter,
 * comunicación directa, alertas) NO depende de licencia EE.
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RegistryController } from './registry.controller';
import { RegistryService } from './registry.service';
import { TelemetryHeartbeatService } from './telemetry-heartbeat.service';

// AuthModule aporta TokenService, dependencia del JwtAuthGuard que ahora
// protege RegistryController (super_admin). Sin él, el DI del guard rompe el
// boot.
@Module({
  imports: [AuthModule],
  controllers: [RegistryController],
  providers: [RegistryService, TelemetryHeartbeatService],
  exports: [RegistryService],
})
export class RegistryModule {}
