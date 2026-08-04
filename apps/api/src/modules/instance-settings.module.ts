/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { loadCipherKey } from '../auth/cipher-key';
import { InstanceSettingsController } from './instance-settings.controller';
import { PrismaInstanceConfigService } from './prisma-instance-config.service';
import { SecretCipherService } from './secret-cipher.service';

/**
 * Config a nivel de instalación (§7.1 de `work/migracion-env-a-panel.md`).
 * `SecretCipherService` se provee local (mismo patrón que Marketplace y
 * ModuleContextFactory) en vez de importarlo de AuthModule — evita un ciclo
 * de imports y usa la misma key resuelta por `loadCipherKey()`.
 *
 * `AuthModule` sí se importa: aporta `TokenService`, dependencia de
 * `JwtAuthGuard` que protege `InstanceSettingsController` (mismo motivo
 * documentado en `RegistryModule`).
 */
@Module({
  imports: [AuthModule],
  controllers: [InstanceSettingsController],
  providers: [
    {
      provide: SecretCipherService,
      useFactory: () => new SecretCipherService(loadCipherKey().key),
    },
    PrismaInstanceConfigService,
  ],
  exports: [PrismaInstanceConfigService],
})
export class InstanceSettingsModule {}
