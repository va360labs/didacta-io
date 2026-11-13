/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  ReconcileReport,
  RefundPreview,
  RefundResult,
  SalesPage,
  SalesSummary,
} from '@didacta/mod-payouts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractClientContext } from '../../auth/client-context';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { PrismaAuditLogService } from '../prisma-audit-log.service';
import { PayoutsReconcileWorker } from './payouts-reconcile.worker';
import { PayoutsRuntime } from './payouts-runtime.service';

const ADMIN_ROLES = ['tenant_admin', 'super_admin'] as const;

export const salesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
type SalesQuery = z.infer<typeof salesQuerySchema>;

export const reconcileRunSchema = z
  .object({
    deep: z.boolean().default(false),
    windowHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .optional(),
  })
  .prefault({});
type ReconcileRunDto = z.infer<typeof reconcileRunSchema>;

/** Importe en unidad mínima de la moneda del cargo; sin él, todo lo que queda. */
const amountSchema = z.coerce.number().int().min(1).max(2_147_483_647);

export const refundSchema = z
  .object({
    amount: amountSchema.optional(),
    /**
     * UUID que genera el diálogo al abrirse: es el id del reembolso. Un doble
     * clic (o un reintento) manda el mismo y acaba en UN solo reembolso.
     */
    requestId: z.string().uuid().optional(),
  })
  .default({});
type RefundDto = z.infer<typeof refundSchema>;

export const refundPreviewQuerySchema = z.object({ amount: amountSchema.optional() });
type RefundPreviewQuery = z.infer<typeof refundPreviewQuerySchema>;

/** `GET /modules/payouts/summary`. Contrato con la web. */
export interface PayoutsSummaryResponse extends SalesSummary {
  readonly operatorName: string;
  /** Comisión vigente del aula (puntos básicos), para el texto «5 % Didacta». */
  readonly feeBps: number;
}

function requireRole(
  user: SessionClaims | undefined,
  roles: readonly string[],
  code: string,
): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((role) => roles.includes(role))) {
    throw new ForbiddenException({
      message: `Esta acción requiere rol ${roles.join(' o ')}.`,
      code,
    });
  }
  return user;
}

/**
 * «Tus ventas» del creador y el disparo manual del conciliador.
 *
 * El tenant de las ventas y del resumen sale SIEMPRE del token
 * (`claims.tenantId`) y las consultas corren con su contexto (RLS): no hay
 * forma de nombrar otra aula desde aquí. Una sesión de soporte puede mirarlas
 * (son de solo lectura).
 */
@ApiTags('Payouts · Cobros')
@Controller('modules/payouts')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PayoutsSalesController {
  constructor(
    private readonly runtime: PayoutsRuntime,
    private readonly reconcile: PayoutsReconcileWorker,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  @Get('sales')
  @ApiOperation({ summary: 'Ventas del aula cobradas por la plataforma, más recientes primero.' })
  async sales(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(salesQuerySchema)) query: SalesQuery,
  ): Promise<SalesPage> {
    const u = requireRole(user, ADMIN_ROLES, 'PAYOUTS_ADMIN_ROLE_REQUIRED');
    return runAsTenant(u.tenantId, () =>
      this.runtime.reports.listSales(u.tenantId, { page: query.page, pageSize: query.pageSize }),
    );
  }

  @Get('summary')
  @ApiOperation({
    summary:
      'Resumen por divisa: vendido, comisiones de tarjeta, comisión del operador, recibido, pendiente y deuda.',
  })
  async summary(@CurrentUser() user: SessionClaims | undefined): Promise<PayoutsSummaryResponse> {
    const u = requireRole(user, ADMIN_ROLES, 'PAYOUTS_ADMIN_ROLE_REQUIRED');
    return runAsTenant(u.tenantId, async () => {
      const [summary, settings] = await Promise.all([
        this.runtime.reports.summary(u.tenantId),
        this.runtime.settings.get(u.tenantId),
      ]);
      return { ...summary, operatorName: this.runtime.config.displayName, feeBps: settings.feeBps };
    });
  }

  @Get('sales/:id/refund-preview')
  @ApiOperation({
    summary:
      'Qué pasaría al reembolsar (amount en la moneda del cargo; sin él, todo lo que queda): lo que recibe el alumno y lo que se descuenta al creador. No mueve dinero.',
  })
  async refundPreview(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') saleId: string,
    @Query(new ZodValidationPipe(refundPreviewQuerySchema)) query: RefundPreviewQuery,
  ): Promise<RefundPreview> {
    const u = requireRole(user, ADMIN_ROLES, 'PAYOUTS_ADMIN_ROLE_REQUIRED');
    return runAsTenant(u.tenantId, () =>
      this.runtime.refunds.preview(u.tenantId, saleId, query.amount),
    );
  }

  @Post('sales/:id/refund')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Reembolsa una venta (total, o parcial con amount). Devuelve el dinero al alumno, recupera del creador su parte y deja como deuda lo que no se pueda recuperar. Venta de otra academia: 404.',
  })
  async refund(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') saleId: string,
    @Body(new ZodValidationPipe(refundSchema)) dto: RefundDto,
  ): Promise<RefundResult> {
    const u = requireRole(user, ADMIN_ROLES, 'PAYOUTS_ADMIN_ROLE_REQUIRED');
    if (u.sup) {
      throw new ForbiddenException({
        message: 'Una sesión de soporte no puede reembolsar ventas.',
        code: 'PAYOUTS_SUPPORT_SESSION_FORBIDDEN',
      });
    }
    const result = await runAsTenant(u.tenantId, () =>
      this.runtime.refunds.refund({
        tenantId: u.tenantId,
        saleId,
        amount: dto.amount,
        requestId: dto.requestId,
        initiatedBy: u.sub,
      }),
    );
    const client = extractClientContext(req);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'payouts.sale.refunded',
      resourceType: 'payouts_sale',
      resourceId: saleId,
      metadata: {
        refundId: result.refundId,
        stripeRefundId: result.stripeRefundId,
        amount: result.amount,
        currency: result.currency,
        status: result.status,
      },
      ip: client.ip ?? undefined,
      userAgent: client.userAgent ?? undefined,
    });
    return result;
  }

  @Post('admin/reconcile/run-now')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Lanza una pasada del conciliador de cobros ahora (todas las aulas). Solo super_admin; nunca una sesión de soporte.',
  })
  async runNow(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(reconcileRunSchema)) dto: ReconcileRunDto,
  ): Promise<ReconcileReport> {
    const u = requireRole(user, ['super_admin'], 'PAYOUTS_SUPER_ADMIN_REQUIRED');
    if (u.sup) {
      throw new ForbiddenException({
        message: 'Una sesión de soporte no puede lanzar el conciliador.',
        code: 'PAYOUTS_SUPPORT_SESSION_FORBIDDEN',
      });
    }
    return this.reconcile.run({ deep: dto.deep, windowHours: dto.windowHours });
  }
}
