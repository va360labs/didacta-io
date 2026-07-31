/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash } from 'node:crypto';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { REFERRAL_SCOPES } from '@didacta/mod-referrals';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { extractClientContext } from '../../auth/client-context';
import { resolveWebBaseUrl } from '../../common/resolve-web-base-url';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { ModuleRegistryService } from '../module-registry.service';

/**
 * Endpoints del módulo mod.referrals.
 *
 * - Miembro (JWT): su código/enlace y sus stats.
 * - Público (`POST track`): registro de clics de /unete?ref= — tenant por
 *   Host, sin sesión (el visitante aún no tiene cuenta). Best-effort.
 * - Admin (JWT + rol): config del programa, comisiones, referidores,
 *   aprobaciones/revocaciones y liquidaciones.
 */

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

const trackSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[a-z0-9]{3,32}$/i),
});

const configSchema = z
  .object({
    active: z.boolean(),
    commissionBps: z.number().int().min(0).max(10_000),
    scope: z.enum(REFERRAL_SCOPES),
    recurringMonths: z.number().int().min(1).max(120).nullable(),
    attributionWindowDays: z.number().int().min(1).max(365),
    guaranteeDays: z.number().int().min(0).max(120),
    minPayoutCents: z.number().int().min(0).max(100_000_000),
    requireActiveMembership: z.boolean(),
    memberCopy: z.string().trim().max(2000).nullable(),
  })
  .partial();

const listCommissionsSchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'PAID', 'REVOKED']).optional(),
  referrerUserId: z.string().uuid().optional(),
});

const revokeSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

const payoutSchema = z.object({
  referrerUserId: z.string().uuid(),
  commissionIds: z.array(z.string().uuid()).min(1).max(500),
  externalReference: z.string().trim().min(3).max(200),
});

@ApiTags('Referidos')
@Controller('modules/referrals')
export class ReferralsController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly tenantResolver: TenantResolverService,
  ) {}

  // ---------------- Miembro ----------------

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Código de referido del usuario (creándolo si no existe) y su enlace completo a /unete. 404 si el programa está inactivo; 403 si exige membresía activa y no la tiene.',
  })
  async me(@CurrentUser() user: SessionClaims | undefined, @Req() req: FastifyRequest) {
    const u = this.requireUser(user);
    const { code } = await this.registry.getReferralsService().getOrCreateCode(u.tenantId, u.sub);
    const base = resolveWebBaseUrl(req);
    return { code, url: `${base}/unete?ref=${encodeURIComponent(code)}` };
  }

  @Get('me/stats')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Stats del miembro: clics, altas atribuidas, comisiones por estado, historial y liquidaciones. Funciona aunque el programa esté inactivo (programActive=false) para mostrar el histórico.',
  })
  async myStats(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireUser(user);
    return this.registry.getReferralsService().memberStats(u.tenantId, u.sub);
  }

  // ---------------- Público (clics) ----------------

  @Post('track')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Registra un clic de /unete?ref=CODE (tenant por Host, dedupe por código+día+IP). Best-effort: nunca falla por código inválido o programa inactivo.',
  })
  async track(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(trackSchema)) dto: z.infer<typeof trackSchema>,
  ) {
    const tenantId = await this.resolveTenantId(req);
    const ctx = extractClientContext(req);
    // No guardamos la IP en claro: hash truncado suficiente para dedupe diario.
    const ipHash = createHash('sha256')
      .update(ctx.ip ?? 'unknown', 'utf8')
      .digest('hex')
      .slice(0, 32);
    const service = this.registry.getReferralsService();
    const registered = await service.registerClick(tenantId, dto.code.toLowerCase(), ipHash);
    // La ventana vuelve para que el cliente ajuste el TTL del código guardado.
    const { attributionWindowDays } = await service.getConfig(tenantId);
    return { registered, attributionWindowDays };
  }

  // ---------------- Admin ----------------

  @Get('admin/config')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Config del programa de referidos del tenant.' })
  async getConfig(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    return this.registry.getReferralsService().getConfig(u.tenantId);
  }

  @Put('admin/config')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Actualiza la config del programa. Los cambios NO recalculan comisiones ya devengadas (los bps quedan sellados por comisión).',
  })
  async updateConfig(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(configSchema)) dto: z.infer<typeof configSchema>,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getReferralsService().updateConfig(u.tenantId, dto);
  }

  @Get('admin/commissions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Comisiones del tenant con filtros y totales por estado.' })
  async listCommissions(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listCommissionsSchema))
    query: z.infer<typeof listCommissionsSchema>,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getReferralsService().listCommissions(u.tenantId, query);
  }

  @Get('admin/referrers')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Referidores con métricas agregadas (clics, altas, comisiones).' })
  async listReferrers(@CurrentUser() user: SessionClaims | undefined) {
    const u = this.requireAdmin(user);
    return this.registry.getReferralsService().listReferrers(u.tenantId);
  }

  @Post('admin/commissions/:id/approve')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Aprueba manualmente una comisión PENDING (sin esperar la garantía).' })
  async approveCommission(@CurrentUser() user: SessionClaims | undefined, @Param('id') id: string) {
    const u = this.requireAdmin(user);
    await this.registry.getReferralsService().approveCommissionNow(u.tenantId, id);
    return { ok: true };
  }

  @Post('admin/commissions/:id/revoke')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoca una comisión PENDING/APPROVED con motivo obligatorio.' })
  async revokeCommission(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(revokeSchema)) dto: z.infer<typeof revokeSchema>,
  ) {
    const u = this.requireAdmin(user);
    await this.registry.getReferralsService().revokeCommission(u.tenantId, id, dto.reason, u.sub);
    return { ok: true };
  }

  @Post('admin/payouts')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Registra una liquidación manual: marca un lote de comisiones APPROVED como PAID con referencia externa obligatoria. Atómica.',
  })
  async recordPayout(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(payoutSchema)) dto: z.infer<typeof payoutSchema>,
  ) {
    const u = this.requireAdmin(user);
    return this.registry.getReferralsService().recordPayout(u.tenantId, {
      referrerUserId: dto.referrerUserId,
      commissionIds: dto.commissionIds,
      externalReference: dto.externalReference,
      createdByUserId: u.sub,
    });
  }

  // ---------------- Helpers ----------------

  private requireUser(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    return user;
  }

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    const u = this.requireUser(user);
    if (!u.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException('Sólo super_admin / tenant_admin pueden gestionar referidos.');
    }
    return u;
  }

  /** Tenant por dominio (Host / X-Forwarded-Host), como MembershipPublicController. */
  private async resolveTenantId(req: FastifyRequest): Promise<string> {
    const host = req.headers.host ?? req.headers['x-forwarded-host'];
    const hostStr = Array.isArray(host) ? host[0] : host;
    const tenant = await this.tenantResolver.resolveByHost(hostStr);
    if (!tenant) {
      throw new ForbiddenException('Comunidad no encontrada para este dominio.');
    }
    return tenant.id;
  }
}
