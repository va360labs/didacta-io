/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InstanceSettingsModule } from '../modules/instance-settings.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';
import { SetupTokenService } from './setup-token.service';

/**
 * Bootstrap del primer arranque. Endpoints públicos:
 *
 *   GET  /setup/status  → ¿hay al menos un tenant?
 *   POST /setup/init    → crea tenant + super_admin (idempotente, 409 si ya existe,
 *                          403 si falta o no coincide el token de setup — ver
 *                          `SetupTokenService`).
 *
 * Importa AuthModule porque reusa PasswordService + TokenService +
 * PrismaAuditLogService. Importa InstanceSettingsModule por
 * `PrismaInstanceConfigService`, donde `SetupTokenService` persiste el hash
 * del token (mismo patrón que `LicenseAdminModule`). No expone providers —
 * solo controladores HTTP.
 */
@Module({
  imports: [PrismaModule, AuthModule, InstanceSettingsModule],
  controllers: [SetupController],
  providers: [SetupService, SetupTokenService],
})
export class SetupModule {}
