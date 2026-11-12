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
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ReconcileReport, SalesPage, SalesSummary } from '@didacta/mod-payouts';
import { z } from 'zod';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
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
  .default({});
type ReconcileRunDto = z.infer<typeof reconcileRunSchema>;

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
