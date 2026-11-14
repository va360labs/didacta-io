/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { extractClientContext } from '../auth/client-context';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import {
  academyDateLocale,
  academyLocale,
  academyTimeZone,
  type AcademyDefaultsPrisma,
} from '../common/academy-defaults';
import { PrismaAuditLogService } from '../modules/prisma-audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { runAsTenant } from '../tenancy/tenant-context.storage';
import { buyersTable, salesTable, toCsv, toXlsx } from './sales-export';
import { SALES_EXPORT_MAX_ROWS, SalesLedgerService } from './sales-ledger.service';
import {
  salesExportQuerySchema,
  salesListQuerySchema,
  type SaleDetailView,
  type SalesExportQuery,
  type SalesListQuery,
  type SalesPageView,
} from './sales-ledger.types';

/**
 * Quién ve las ventas con los datos de las personas: quien administra el aula.
 * (No hay un rol de pagos en este producto; si llega, entra aquí.)
 */
const SALES_ROLES = new Set(['tenant_admin', 'super_admin']);

function requireSalesAccess(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => SALES_ROLES.has(r))) {
    throw new ForbiddenException({
      message: 'Solo quien administra la academia puede ver sus ventas.',
      code: 'SALES_ADMIN_ROLE_REQUIRED',
    });
  }
  return user;
}

const CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

/** Nombre del fichero: `ventas-2026-11-14.csv` en el idioma del aula. */
export function exportFileName(
  locale: 'es' | 'en' | 'pt',
  view: 'sales' | 'buyers',
  format: 'csv' | 'xlsx',
  now: Date,
): string {
  const base =
    view === 'buyers'
      ? { es: 'compradores', en: 'buyers', pt: 'compradores' }[locale]
      : { es: 'ventas', en: 'sales', pt: 'vendas' }[locale];
  return `${base}-${now.toISOString().slice(0, 10)}.${format}`;
}

/**
 * «Ventas» del aula con los datos de cada venta, su detalle y la exportación.
 *
 * El aula sale SIEMPRE del token (`claims.tenantId`) y cada consulta corre con
 * su contexto (RLS) y filtrando por `tenant_id`: no hay forma de nombrar otra
 * aula. Una venta de otra academia es un 404.
 *
 * Exportar saca datos personales del aula (nombre, correo, país): queda en la
 * auditoría quién lo hizo, cuándo, con qué filtros y cuántas filas (RGPD). Una
 * sesión de soporte puede mirar las ventas pero no exportarlas.
 */
@ApiTags('Admin · Ventas')
@ApiBearerAuth()
@Controller('admin/sales')
@UseGuards(JwtAuthGuard)
export class SalesLedgerController {
  constructor(
    private readonly sales: SalesLedgerService,
    private readonly prisma: PrismaService,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Ventas del aula (pagos únicos y cuotas cobradas) con comprador, producto, cupón o referido, comisiones, neto, estado y país. Búsqueda y filtros por fechas, producto y estado.',
  })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(salesListQuerySchema)) query: SalesListQuery,
  ): Promise<SalesPageView> {
    const u = requireSalesAccess(user);
    const { page, pageSize, ...filters } = query;
    return this.sales.list(u.tenantId, filters, { page, pageSize });
  }

  @Get('export')
  @ApiOperation({
    summary:
      'Exporta las ventas filtradas (CSV UTF-8 con BOM o Excel) en el idioma del aula. `view=buyers`: una fila por comprador. Queda en la auditoría.',
  })
  async export(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(salesExportQuerySchema)) query: SalesExportQuery,
  ): Promise<void> {
    const u = requireSalesAccess(user);
    if (u.sup) {
      throw new ForbiddenException({
        message: 'Una sesión de soporte no puede exportar datos personales del aula.',
        code: 'SALES_SUPPORT_SESSION_FORBIDDEN',
      });
    }
    const { format, view, ...filters } = query;
    const prisma = this.prisma as unknown as AcademyDefaultsPrisma;
    const [{ rows, total }, locale, timeZone, platform] = await Promise.all([
      this.sales.all(u.tenantId, filters),
      runAsTenant(u.tenantId, () => academyLocale(prisma, u.tenantId)),
      runAsTenant(u.tenantId, () => academyTimeZone(prisma, u.tenantId)),
      this.sales.platformInfo(u.tenantId),
    ]);
    const options = {
      locale,
      timeZone: timeZone ?? 'UTC',
      dateLocale: academyDateLocale(locale),
      operatorName: platform?.operatorName ?? null,
      withSettlement: platform !== null || rows.some((r) => r.settlement !== null),
    };
    const table = view === 'buyers' ? buyersTable(rows, options) : salesTable(rows, options);
    const body = format === 'xlsx' ? toXlsx(table) : toCsv(table, locale);

    const client = extractClientContext(req);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'sales.exported',
      resourceType: 'sales',
      resourceId: u.tenantId,
      metadata: {
        format,
        view,
        rows: table.rows.length,
        sales: rows.length,
        truncated: total > SALES_EXPORT_MAX_ROWS,
        filters: {
          from: filters.from?.toISOString() ?? null,
          to: filters.to?.toISOString() ?? null,
          product: filters.product ?? null,
          status: filters.status ?? null,
          q: filters.q ?? null,
        },
      },
      ip: client.ip ?? undefined,
      userAgent: client.userAgent ?? undefined,
    });

    const name = exportFileName(locale, view, format, new Date());
    void reply
      .header('content-type', CONTENT_TYPES[format])
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store')
      .header('x-sales-total', String(total))
      .send(body);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Una venta (`order:<id>` o `invoice:<id>`) con su reparto, su historia (cobro, transferencia, reembolsos, reclamaciones) y su factura. De otra academia: 404.',
  })
  async detail(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
  ): Promise<SaleDetailView> {
    const u = requireSalesAccess(user);
    return this.sales.detail(u.tenantId, id);
  }
}
