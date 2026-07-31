/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * AuditExportModule — quinto piloto License SDK
 * (`feat:reports.advanced_signed`).
 *
 * Vivimos como módulo separado (en lugar de inflar `ModulesModule`) porque:
 *   - Acopla `adm-zip` solo donde se usa.
 *   - El day-2 (XLSX, PDF, signed S3 URLs) probablemente añada providers que
 *     no pertenecen al stack base de `modules/`.
 *
 * Importa AuthModule para reusar `PrismaAuditLogService` (ya provisto allí
 * según el patrón establecido por el resto de pilotos).
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AuditExportController } from './audit-export.controller';
import { AuditExportService } from './audit-export.service';

@Module({
  imports: [AuthModule],
  controllers: [AuditExportController],
  providers: [AuditExportService],
  exports: [AuditExportService],
})
export class AuditExportModule {}
