/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Optional,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { ModuleRegistryService } from '../module-registry.service';
import { PlatformCheckoutGate } from '../payouts/platform-checkout-gate';
import {
  createPlanSchema,
  membershipConfigSchema,
  updatePlanSchema,
  type CreatePlanDto,
  type MembershipConfigDto,
  type UpdatePlanDto,
} from './membership.dto';
import { retentionConfigSchema, type RetentionConfigDto } from './retention.dto';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

/**
 * Administración de la membresía: planes (precio/periodicidad/trial/tachado)
 * y configuración de la página pública /join. Solo admins del tenant.
 */
@ApiTags('Membresía (admin)')
@ApiBearerAuth()
@Controller('membership/admin')
@UseGuards(JwtAuthGuard)
export class MembershipAdminController {
  constructor(
    private readonly registry: ModuleRegistryService,
    // Solo con cobros de plataforma encendidos: valida monedas e importes.
    @Optional() private readonly payoutsGate?: PlatformCheckoutGate,
  ) {}

  /**
   * Cobros de plataforma: la moneda del plan es una de la lista y el importe se
   * puede cobrar en ella (plan §9). Con claves propias, todo como siempre.
   */
  private async assertPlatformPlanPrice(
    tenantId: string,
    plan: {
      amountCents: number;
      compareAtCents?: number | null;
      currency: string;
      currencyOptions?: Record<string, number> | null;
    },
  ): Promise<void> {
    if (!this.payoutsGate) return;
    await this.payoutsGate.assertPrice(tenantId, {
      currency: plan.currency,
      // Un plan gratis (0) no pasa por Stripe: no hay importe que validar.
      amounts: [plan.amountCents, plan.compareAtCents ?? 0].filter((a) => a > 0),
      currencyOptions: plan.currencyOptions ?? null,
    });
  }

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException({
        message: 'Solo administradores pueden configurar la membresía.',
        code: 'SUBS_ADMIN_ROLE_REQUIRED',
      });
    }
    return user;
  }

  @Get('plans')
  @ApiOperation({ summary: 'Lista TODOS los planes de membresía (activos e inactivos).' })
  async listPlans(@CurrentUser() rawUser: SessionClaims | undefined) {
    const user = this.requireAdmin(rawUser);
    const plans = await this.registry.getMembershipService().listPlans(user.tenantId);
    return { plans };
  }

  @Post('plans')
  @ApiOperation({ summary: 'Crea un plan de membresía.' })
  async createPlan(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createPlanSchema)) dto: CreatePlanDto,
  ) {
    const user = this.requireAdmin(rawUser);
    await this.assertPlatformPlanPrice(user.tenantId, {
      amountCents: dto.amountCents,
      compareAtCents: dto.compareAtCents,
      currency: dto.currency ?? 'eur',
      currencyOptions: dto.currencyOptions,
    });
    return this.registry.getMembershipService().createPlan(user.tenantId, dto);
  }

  @Patch('plans/:id')
  @ApiOperation({
    summary:
      'Edita un plan. Cambiar importe/moneda/periodicidad rota el price de Stripe (se re-crea en el próximo checkout).',
  })
  async updatePlan(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updatePlanSchema)) dto: UpdatePlanDto,
  ) {
    const user = this.requireAdmin(rawUser);
    if (
      dto.amountCents !== undefined ||
      dto.currency !== undefined ||
      dto.currencyOptions !== undefined ||
      dto.compareAtCents !== undefined
    ) {
      const current = (await this.registry.getMembershipService().listPlans(user.tenantId)).find(
        (p) => p.id === id,
      );
      if (current) {
        await this.assertPlatformPlanPrice(user.tenantId, {
          amountCents: dto.amountCents ?? current.amountCents,
          compareAtCents:
            dto.compareAtCents === undefined ? current.compareAtCents : dto.compareAtCents,
          currency: dto.currency ?? current.currency,
          currencyOptions:
            dto.currencyOptions === undefined
              ? (current.currencyOptions as Record<string, number> | null)
              : dto.currencyOptions,
        });
      }
    }
    return this.registry.getMembershipService().updatePlan(user.tenantId, id, dto);
  }

  @Delete('plans/:id')
  @ApiOperation({
    summary: 'Borra un plan sin ventas; si ya vendió suscripciones, lo desactiva (historial).',
  })
  async deletePlan(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const user = this.requireAdmin(rawUser);
    await this.registry.getMembershipService().deletePlan(user.tenantId, id);
    return { ok: true };
  }

  @Get('config')
  @ApiOperation({ summary: 'Configuración de la página pública de membresía.' })
  async getConfig(@CurrentUser() rawUser: SessionClaims | undefined) {
    const user = this.requireAdmin(rawUser);
    return this.registry.getMembershipService().getConfig(user.tenantId);
  }

  @Put('config')
  @ApiOperation({
    summary:
      'Actualiza la configuración: activo, headline, grupo de acceso, precios individuales por curso, testimonial.',
  })
  async updateConfig(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Body(new ZodValidationPipe(membershipConfigSchema)) dto: MembershipConfigDto,
  ) {
    const user = this.requireAdmin(rawUser);
    return this.registry.getMembershipService().updateConfig(user.tenantId, dto);
  }

  // ---------------- Oferta al darse de baja ----------------

  @Get('retention')
  @ApiOperation({
    summary:
      '«Cuando alguien quiere irse»: qué se ofrece al darse de baja (pausa y meses ' +
      'máximos, descuento con % y meses).',
  })
  async getRetention(@CurrentUser() rawUser: SessionClaims | undefined) {
    const user = this.requireAdmin(rawUser);
    return this.registry.getRetentionService().getConfig(user.tenantId);
  }

  @Put('retention')
  @ApiOperation({ summary: 'Guarda la oferta al darse de baja.' })
  async updateRetention(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Body(new ZodValidationPipe(retentionConfigSchema)) dto: RetentionConfigDto,
  ) {
    const user = this.requireAdmin(rawUser);
    return this.registry.getRetentionService().updateConfig(user.tenantId, dto);
  }

  @Get('retention/summary')
  @ApiOperation({
    summary:
      'Resumen de bajas: cuántos pulsaron «Darme de baja», cuántos se quedaron (pausa o ' +
      'descuento), los motivos y las últimas salidas. `days` = ventana (90 por defecto).',
  })
  async retentionSummary(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Query('days') days?: string,
  ) {
    const user = this.requireAdmin(rawUser);
    const parsed = days ? Number.parseInt(days, 10) : undefined;
    return this.registry.getRetentionService().summary(user.tenantId, {
      ...(parsed !== undefined && Number.isFinite(parsed) ? { sinceDays: parsed } : {}),
    });
  }
}
