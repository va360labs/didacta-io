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
import { RegistryController } from './registry.controller';
import { RegistryService } from './registry.service';

@Module({
  controllers: [RegistryController],
  providers: [RegistryService],
  exports: [RegistryService],
})
export class RegistryModule {}
