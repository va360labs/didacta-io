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
  Put,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PayoutsInvoicingDisabledError,
  type InvoiceView,
  type TaxProfileView,
} from '@didacta/mod-payouts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractClientContext } from '../../auth/client-context';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { PrismaAuditLogService } from '../prisma-audit-log.service';
import { PayoutsInvoiceMailer } from './payouts-invoice-mailer';
import { PayoutsInvoicesWorker, type PayoutsInvoicesRunResult } from './payouts-invoices.worker';
import { PayoutsRuntime } from './payouts-runtime.service';

const ADMIN_ROLES = ['tenant_admin', 'super_admin'] as const;

const addressSchema = z.object({
  line1: z.string().max(200),
  line2: z.string().max(200).nullish(),
  postalCode: z.string().max(20),
  city: z.string().max(120),
  region: z.string().max(120).nullish(),
});

export const taxProfileSchema = z
  .object({
    entityType: z.enum(['individual', 'company']),
    legalName: z.string().max(200),
    country: z.string().max(2),
    /** Sin él se conserva el guardado. */
    taxId: z.string().max(40).nullish(),
    /** `''` lo borra; ausente lo conserva. */
    vatId: z.string().max(40).nullish(),
    address: addressSchema,
    birthDate: z.string().max(10).nullish(),
  })
  .strict();
type TaxProfileDto = z.infer<typeof taxProfileSchema>;

export const invoiceRunSchema = z
  .object({
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
    tenantId: z.string().uuid().optional(),
  })
  .strict()
  .default({});
type InvoiceRunDto = z.infer<typeof invoiceRunSchema>;

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

/** `GET /modules/payouts/invoices`. Contrato con la web. */
export interface PayoutsInvoicesResponse {
  /** `false`: la instalación no factura (faltan los datos del emisor). */
  readonly enabled: boolean;
  readonly items: readonly InvoiceView[];
}

/**
 * Las dos piezas legales del creador en Cobros:
 *
 *  - «Datos fiscales»: lo que necesitan la factura de la comisión y DAC7. El
 *    NIF nunca vuelve entero a la web ni pasa por los logs; la auditoría
 *    apunta QUIÉN los cambió y si quedaron completos, no los datos.
 *  - «Tus facturas»: la lista y el PDF de cada una, tal como se emitió.
 *
 * Y el botón del super_admin para emitir un mes a mano (todas las aulas o
 * una). El tenant sale SIEMPRE del token: no hay forma de nombrar otra aula.
 */
@ApiTags('Payouts · Cobros')
@Controller('modules/payouts')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PayoutsLegalController {
  constructor(
    private readonly runtime: PayoutsRuntime,
    private readonly invoicesWorker: PayoutsInvoicesWorker,
    private readonly mailer: PayoutsInvoiceMailer,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  @Get('tax-profile')
  @ApiOperation({
    summary:
      'Datos fiscales del creador (sin el NIF entero) y, si aún no hay, lo que ya sabe Stripe para proponerlo.',
  })
  async taxProfile(@CurrentUser() user: SessionClaims | undefined): Promise<TaxProfileView> {
    const u = requireRole(user, ADMIN_ROLES, 'PAYOUTS_ADMIN_ROLE_REQUIRED');
    const service = this.taxProfiles();
    return runAsTenant(u.tenantId, () => service.view(u.tenantId));
  }

  @Put('tax-profile')
  @ApiOperation({
    summary:
      'Guarda los datos fiscales. Valida el NIF (español con su control) y el NIF-IVA en VIES. Con los datos completos se liberan las ventas retenidas por faltarlos y se sustituyen las facturas que salieron sin ellos.',
  })
  async saveTaxProfile(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(taxProfileSchema)) dto: TaxProfileDto,
  ): Promise<TaxProfileView> {
    const u = requireRole(user, ADMIN_ROLES, 'PAYOUTS_ADMIN_ROLE_REQUIRED');
    if (u.sup) {
      throw new ForbiddenException({
        message: 'Una sesión de soporte no puede cambiar los datos fiscales.',
        code: 'PAYOUTS_SUPPORT_SESSION_FORBIDDEN',
      });
    }
    const service = this.taxProfiles();
    const result = await runAsTenant(u.tenantId, () =>
      service.save(
        u.tenantId,
        {
          entityType: dto.entityType,
          legalName: dto.legalName,
          country: dto.country,
          taxId: dto.taxId ?? null,
          ...(dto.vatId === undefined ? {} : { vatId: dto.vatId ?? '' }),
          address: dto.address,
          birthDate: dto.birthDate ?? null,
        },
        u.sub,
      ),
    );
    const client = extractClientContext(req);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'payouts.tax_profile.saved',
      resourceType: 'payouts_tax_profile',
      resourceId: u.tenantId,
      // Ni NIF, ni dirección, ni fecha: solo qué pasó.
      metadata: {
        complete: result.view.status === 'complete',
        becameComplete: result.becameComplete,
        vatStatus: result.view.profile?.vatStatus ?? null,
        releasedSales: result.releasedSales,
      },
      ip: client.ip ?? undefined,
      userAgent: client.userAgent ?? undefined,
    });
    await this.afterComplete(u.tenantId, result.releasedSales);
    return result.view;
  }

  @Get('invoices')
  @ApiOperation({ summary: 'Facturas de la comisión emitidas al aula, más recientes primero.' })
  async invoices(@CurrentUser() user: SessionClaims | undefined): Promise<PayoutsInvoicesResponse> {
    const u = requireRole(user, ADMIN_ROLES, 'PAYOUTS_ADMIN_ROLE_REQUIRED');
    const invoices = this.runtime.invoices;
    if (!invoices) return { enabled: false, items: [] };
    return { enabled: true, items: await runAsTenant(u.tenantId, () => invoices.list(u.tenantId)) };
  }

  @Get('invoices/:id/pdf')
  @ApiOperation({ summary: 'El PDF de una factura, tal como se emitió. De otra aula: 404.' })
  async invoicePdf(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') invoiceId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const u = requireRole(user, ADMIN_ROLES, 'PAYOUTS_ADMIN_ROLE_REQUIRED');
    const invoices = this.runtime.invoices;
    if (!invoices) throw new PayoutsInvoicingDisabledError();
    const { fileName, pdf } = await runAsTenant(u.tenantId, () =>
      invoices.pdf(u.tenantId, invoiceId),
    );
    void reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${fileName}"`)
      .header('cache-control', 'private, no-store')
      .send(pdf);
  }

  @Post('admin/invoices/run')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Emite ahora las facturas de un mes (por defecto, el anterior) a todas las aulas o a una. Idempotente. Solo super_admin; nunca una sesión de soporte.',
  })
  async runInvoices(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(invoiceRunSchema)) dto: InvoiceRunDto,
  ): Promise<PayoutsInvoicesRunResult> {
    const u = requireRole(user, ['super_admin'], 'PAYOUTS_SUPER_ADMIN_REQUIRED');
    if (u.sup) {
      throw new ForbiddenException({
        message: 'Una sesión de soporte no puede emitir facturas.',
        code: 'PAYOUTS_SUPPORT_SESSION_FORBIDDEN',
      });
    }
    if (!this.runtime.invoices) throw new PayoutsInvoicingDisabledError();
    const result = await this.invoicesWorker.run({ month: dto.month, tenantId: dto.tenantId });
    const client = extractClientContext(req);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'payouts.invoices.run',
      resourceType: 'payouts_invoice_run',
      resourceId: result.month,
      metadata: {
        month: result.month,
        onlyTenant: dto.tenantId ?? null,
        issued: result.issued,
        outcomes: result.outcomes,
        errors: result.errors,
      },
      ip: client.ip ?? undefined,
      userAgent: client.userAgent ?? undefined,
    });
    return result;
  }

  private taxProfiles() {
    const service = this.runtime.taxProfiles;
    if (!service) throw new PayoutsInvoicingDisabledError();
    return service;
  }

  /**
   * Con los datos completos: las ventas retenidas por faltarlos se liquidan
   * ya (sin Redis, aquí mismo; con Redis, el barrido de cada minuto) y las
   * facturas que salieron sin ellos se sustituyen y se mandan. Best-effort:
   * lo que falle lo repite el proceso diario.
   */
  private async afterComplete(tenantId: string, releasedSales: number): Promise<void> {
    try {
      if (releasedSales > 0 && this.runtime.settleInline) {
        const held = await runAsTenant(tenantId, () =>
          this.runtime.prisma.modPayoutsSale.findMany({
            where: { tenantId, status: 'HELD', stripeTransferId: null },
            select: { id: true },
            take: 200,
          }),
        );
        for (const sale of held) await this.runtime.settlement.settleSale(tenantId, sale.id);
      }
      const invoices = this.runtime.invoices;
      if (invoices) {
        const results = await runAsTenant(tenantId, () => invoices.issueSubstitutions(tenantId));
        for (const result of results) {
          if (result.outcome === 'issued') await this.mailer.send(tenantId, result.invoiceId);
        }
      }
    } catch {
      // El proceso diario lo vuelve a intentar.
    }
  }
}
