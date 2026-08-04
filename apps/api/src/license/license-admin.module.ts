/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InstanceSettingsModule } from '../modules/instance-settings.module';
import { LicenseAdminController } from './license-admin.controller';
import { LicenseAdminService } from './license-admin.service';

/**
 * Registra `/admin/license`. `LicenseService` llega inyectado desde el
 * `LicenseModule` global del SDK — este módulo no lo importa explícitamente.
 * `AuthModule` aporta `TokenService`, dependencia de `JwtAuthGuard` que
 * protege `LicenseAdminController` (mismo motivo que `RegistryModule`).
 */
@Module({
  imports: [InstanceSettingsModule, AuthModule],
  controllers: [LicenseAdminController],
  providers: [LicenseAdminService],
  exports: [LicenseAdminService],
})
export class LicenseAdminModule {}
