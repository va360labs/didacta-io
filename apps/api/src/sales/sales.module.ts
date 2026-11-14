/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SalesLedgerController } from './sales-ledger.controller';
import { SalesLedgerService } from './sales-ledger.service';

/**
 * «Ventas» con los datos de cada venta (`/admin/sales`). Infraestructura del
 * host, como `SimpleModeModule`: compone lecturas de varios módulos.
 *
 * `PayoutsRuntime` llega solo si `PayoutsModule` está registrado (global en
 * modo plataforma); por eso el servicio lo recibe `@Optional()`.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [SalesLedgerController],
  providers: [SalesLedgerService],
})
export class SalesModule {}
