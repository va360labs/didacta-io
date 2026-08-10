/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * ScimModule — séptimo piloto License SDK (`feat:scim`).
 *
 * Wire de dependencias:
 *   - PrismaService (vía PrismaModule global) para CRUD de usuarios.
 *   - PrismaAuditLogService (re-exportado por AuthModule, mismo patrón que
 *     `custom-domains`) para registrar audit log de cada operación SCIM.
 *
 * Importamos AuthModule (en vez de declarar PrismaAuditLogService como
 * provider) para reusar la instancia y mantener consistencia con los pilotos
 * previos. Esto evita "two instances of audit log service in the container"
 * que pasó en MIG-013.
 *
 * El controller declara `Controller('scim/v2')`. En `main.ts` se excluye
 * `/scim` del prefijo global `/api/v1` para que la URL pública sea
 * `https://<host>/scim/v2/...` — los IdPs esperan exactamente esa forma.
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ScimAuthGuard } from './scim-auth.guard';
import { ScimContentTypeInterceptor } from './scim-content-type.interceptor';
import { ScimExceptionFilter } from './scim-exception.filter';
import { ScimController } from './scim.controller';
import { ScimService } from './scim.service';

@Module({
  imports: [AuthModule],
  controllers: [ScimController],
  // El filtro y el interceptor van declarados como providers (no como
  // instancias en el `@UseFilters` / `@UseInterceptors`) para que Nest los
  // resuelva por DI: así el filtro puede tener su propio Logger y ambos
  // participan del ciclo de vida del contenedor.
  providers: [ScimService, ScimAuthGuard, ScimExceptionFilter, ScimContentTypeInterceptor],
  exports: [ScimService],
})
export class ScimModule {}
