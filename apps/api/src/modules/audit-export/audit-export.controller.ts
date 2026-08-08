/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * AuditExportController — quinto piloto License SDK
 * (`feat:reports.advanced_signed`).
 *
 *   GET /api/v1/audit/entries.zip?from=...&to=...
 *
 * Devuelve un ZIP firmado con el listado de entries del audit log del tenant
 * en el rango pedido. Sin licencia EE → 402 vía LicenseExceptionFilter.
 *
 * Decisión de modulado: vivimos en `modules/audit-export/` con su propio
 * controller en lugar de añadir el endpoint a `audit.controller.ts` para:
 *
 *  1. Aislar la dependencia `adm-zip` del controller "ligero" de audit log.
 *  2. Mantener el shape del controller existente intocado (no rompe contract
 *     visible por integradores que dependen del export de la clase).
 *  3. Permitir que la lógica de export evolucione (XLSX, PDF, S3 streaming)
 *     sin contaminar el listado.
 *
 * El namespace HTTP (`/audit/entries.zip`) sigue siendo el de auditoría —
 * desde fuera, el endpoint pertenece a la familia /audit/* tal como pide el
 * contrato del producto.
 *
 * Audit-trail: cada descarga registra una entry `audit.report.exported` para
 * trazabilidad. Si la descarga es voluminosa o se solicita repetidamente, el
 * propio audit log mostrará el patrón.
 */

import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { LICENSE_CAPABILITIES, RequiresCapability } from '@didacta/license-sdk';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { extractClientContext } from '../../auth/client-context';
import type { SessionClaims } from '../../auth/token.service';
import { PrismaAuditLogService } from '../prisma-audit-log.service';
import { AuditExportService } from './audit-export.service';
import { auditExportRangeSchema, type AuditExportRangeDto } from './audit-export.dto';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

function requireAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException({
      message: 'Solo super_admin y tenant_admin pueden exportar el audit log firmado.',
      code: 'AUDIT_EXPORT_ADMIN_REQUIRED',
    });
  }
  return user;
}

@ApiTags('Audit · Signed Exports')
@ApiBearerAuth()
@Controller('audit')
@UseGuards(JwtAuthGuard)
export class AuditExportController {
  constructor(
    private readonly exportService: AuditExportService,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  @Get('entries.zip')
  @RequiresCapability(LICENSE_CAPABILITIES.REPORTS_ADVANCED_SIGNED)
  @ApiOperation({
    summary:
      'Exporta el audit log del tenant como ZIP firmado (manifest.json + ' +
      'audit-entries.ndjson + signature.json). Requiere capability ' +
      '`feat:reports.advanced_signed`. Sin licencia → 402.',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'Limite inferior del rango (ISO 8601 con offset).',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'Limite superior del rango (ISO 8601 con offset).',
  })
  @ApiResponse({ status: 200, description: 'ZIP firmado.' })
  @ApiResponse({ status: 400, description: 'Rango inválido (from > to o ISO malformado).' })
  @ApiResponse({ status: 402, description: 'Capability no licenciada.' })
  @ApiResponse({ status: 403, description: 'Solo super_admin / tenant_admin.' })
  async download(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(auditExportRangeSchema)) range: AuditExportRangeDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const u = requireAdmin(user);

    const result = await this.exportService.buildSignedZip(u.tenantId, {
      from: range.from ? new Date(range.from) : undefined,
      to: range.to ? new Date(range.to) : undefined,
    });

    // Audit-trail de la propia descarga: trazable como cualquier otra acción
    // del tenant. Importante registrar ANTES de stream el cuerpo para que un
    // fallo de stream no deje la descarga "fantasma" sin registro.
    const ctx = extractClientContext(req);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'audit.report.exported',
      resourceType: 'audit_report',
      resourceId: result.manifest.generatedAt,
      metadata: {
        range: result.manifest.range,
        entryCount: result.manifest.entryCount,
        manifestSha256: result.signature.manifestSha256,
        filename: result.filename,
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    void reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${result.filename}"`)
      .header('X-Audit-Manifest-Sha256', result.signature.manifestSha256)
      .header('X-Audit-Entry-Count', String(result.manifest.entryCount))
      .status(200)
      .send(result.zip);
  }
}
