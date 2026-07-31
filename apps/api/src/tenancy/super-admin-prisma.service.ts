/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { withTenantContext } from '@didacta/database';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService, type TenantContext } from './tenant-context.service';

/**
 * Servicio para queries que necesitan bypass de RLS.
 *
 * Casos de uso válidos:
 * - Seeders y migraciones
 * - Jobs globales (ej: cleanup de datos huérfanos)
 * - Admin endpoints que operan cross-tenant (ej: listado de todos los tenants)
 * - Marketplace: instalación de módulos (tabla `installed_module` es global)
 *
 * NUNCA usar en request path de usuario final que no sea super_admin.
 * Para usuarios normales, usar `TenantPrismaService.withTenant()`.
 *
 * Arquitectura:
 * - En MVP, simplemente NO setea `app.current_tenant_id`
 * - Las tablas globales (sin `tenant_id`) funcionan sin RLS
 * - Las tablas con `tenant_id` devuelven 0 rows (policy `tenant_id = current_tenant_id()` falla)
 *
 * Futuro: usar una conexión separada con rol `didacta_super` (BYPASSRLS)
 * definido en rls.sql. Requiere segundo DATABASE_URL con credenciales distintas.
 *
 * @see packages/database/prisma/rls.sql — rol didacta_super
 * @see DISC-003 — historia de implementación
 */
@Injectable()
export class SuperAdminPrismaService {
  private readonly logger = new Logger(SuperAdminPrismaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Acceso al cliente Prisma SIN contexto de tenant.
   *
   * Solo funciona para:
   * - Tablas globales (sin columna `tenant_id`)
   * - Queries que no tocan datos de usuarios
   *
   * Para tablas con RLS, las queries devolverán 0 rows porque
   * `current_tenant_id()` retorna NULL.
   */
  get client(): PrismaService {
    return this.prisma;
  }

  /**
   * Ejecuta un callback con el cliente sin RLS.
   * Sugar syntax para consistencia con TenantPrismaService.
   */
  async run<T>(callback: (prisma: PrismaService) => Promise<T>): Promise<T> {
    return callback(this.prisma);
  }

  /**
   * Ejecuta un callback con un tenantId específico, pero SIN validar
   * que el usuario actual tenga acceso a ese tenant.
   *
   * PELIGROSO: solo usar en contextos donde ya se validó autorización
   * (ej: super_admin que está operando sobre un tenant específico).
   */
  async asAdmin<T>(tenantId: string, callback: (prisma: PrismaService) => Promise<T>): Promise<T> {
    this.logger.warn(
      `SuperAdmin bypass: ejecutando query como tenant ${tenantId}. ` +
        `Asegúrate de que el caller tiene autorización.`,
    );
    const parent = this.tenantContext.get();
    const ctx: TenantContext = {
      tenantId,
      userId: parent?.userId,
      traceId: parent?.traceId ?? `tx-${randomUUID()}`,
      gucApplied: true,
    };
    return this.tenantContext.run(ctx, () =>
      withTenantContext(this.prisma, tenantId, (tx) => callback(tx as unknown as PrismaService)),
    );
  }
}
