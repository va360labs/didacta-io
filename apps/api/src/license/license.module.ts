/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * ApiLicenseModule — registra el controller público GET /api/license.
 *
 * El módulo del SDK (LicenseModule.forRoot()) se importa en AppModule a nivel
 * raíz para tener LicenseService global. Este wrapper solo aporta el endpoint.
 */

import { Module } from '@nestjs/common';
import { LicenseController } from './license.controller';

@Module({
  controllers: [LicenseController],
})
export class ApiLicenseModule {}
