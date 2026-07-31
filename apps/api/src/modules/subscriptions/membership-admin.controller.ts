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
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { ModuleRegistryService } from '../module-registry.service';
import {
  createPlanSchema,
  membershipConfigSchema,
  updatePlanSchema,
  type CreatePlanDto,
  type MembershipConfigDto,
  type UpdatePlanDto,
} from './membership.dto';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

/**
 * Administración de la membresía: planes (precio/periodicidad/trial/tachado)
 * y configuración de la página pública /unete. Solo admins del tenant.
 */
@ApiTags('Membresía (admin)')
@ApiBearerAuth()
@Controller('membership/admin')
@UseGuards(JwtAuthGuard)
export class MembershipAdminController {
  constructor(private readonly registry: ModuleRegistryService) {}

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException('Solo administradores pueden configurar la membresía.');
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
}
