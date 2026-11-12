/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Body, Controller, Get, NotFoundException, Optional, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { extractClientContext } from '../../auth/client-context';
import { readRequestLocale } from '../../common/checkout-locale';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { ModuleRegistryService } from '../module-registry.service';
import {
  PAYOUTS_NOT_READY_OFFER_REASON,
  PlatformCheckoutGate,
  withLocalCurrencyHint,
} from '../payouts/platform-checkout-gate';
import { membershipCheckoutSchema, type MembershipCheckoutDto } from './membership.dto';
import { resolvePublicHost } from '../../common/resolve-public-host';

/**
 * Endpoints PÚBLICOS de la página de membresía (/unete).
 *
 * Sin JWT: el visitante aún no tiene cuenta — el tenant se resuelve por el
 * Host del request (igual que /modules/member-registration y /signin). El checkout es de
 * Stripe hosted: aquí solo se genera la URL de la session.
 */
@ApiTags('Membresía (público)')
@Controller('membership')
export class MembershipPublicController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly tenantResolver: TenantResolverService,
    /**
     * Solo con el modo plataforma encendido (E5): si el aula cobra por la
     * plataforma y su cuenta aún no puede vender, la página no ofrece planes y
     * el checkout responde 409, como los cursos.
     */
    @Optional() private readonly payoutsGate?: PlatformCheckoutGate,
  ) {}

  @Get('page')
  @ApiOperation({
    summary:
      'Datos de la página pública de membresía: planes activos, cursos publicados con su precio individual de referencia, y testimonial. Tenant por Host. 404 si la página no está activada.',
  })
  async page(@Req() req: FastifyRequest) {
    const tenantId = await this.resolveTenantId(req);
    // RLS F2: ruta pública sin middleware de tenant — las queries corren bajo
    // el ALS del tenant resuelto por Host.
    return runAsTenant(tenantId, async () => {
      const page = await this.registry.getMembershipService().getPublicPage(tenantId);
      // Sin modo plataforma (Community) la página sale tal cual, sin campos nuevos.
      const checkoutInfo = await this.payoutsGate?.publicCheckoutInfo(tenantId);
      if (!checkoutInfo) return page;
      // Cobros de plataforma sin terminar de conectar: la página se ve, sin venta.
      if (checkoutInfo.blockedReason) {
        return { ...page, plans: [], reason: PAYOUTS_NOT_READY_OFFER_REASON };
      }
      return {
        ...page,
        // ¿Verá el alumno el precio del plan en su moneda al pagar?
        plans: withLocalCurrencyHint(page.plans, checkoutInfo),
        // En modo plataforma el pago no admite cupones (`promotionCodes: 'deny'`):
        // la página no debe prometer que se pueden aplicar.
        couponsAtCheckout: !checkoutInfo.platform,
      };
    });
  }

  @Post('checkout')
  @ApiOperation({
    summary:
      'Crea la Stripe Checkout Session (mode=subscription) de un plan de membresía y devuelve su URL. Anónimo: Stripe recoge el email. Cupones habilitados; trial según el plan.',
  })
  async checkout(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(membershipCheckoutSchema)) dto: MembershipCheckoutDto,
  ) {
    const tenantId = await this.resolveTenantId(req);
    const base = await this.tenantResolver.resolveTenantWebBaseUrl(tenantId, req);
    return runAsTenant(tenantId, async () => {
      const membership = this.registry.getMembershipService();
      // Modo plataforma: 409 si la cuenta no puede vender; si puede, el precio
      // del plan en la cuenta del operador (antes de crear nada).
      await this.payoutsGate?.prepareMembershipCheckout(tenantId, dto.planId, membership);
      const { url, sessionId } = await membership.startMembershipCheckout({
        tenantId,
        planId: dto.planId,
        email: dto.email,
        referralCode: dto.referralCode,
        // Idioma con el que el comprador está navegando AHORA. Viaja en la
        // metadata de Stripe porque su fila de `user` no existe todavía: se
        // crea en el webhook, después del salto a la pasarela.
        locale: readRequestLocale(req.headers),
        successUrl: `${base}/unete?status=success`,
        cancelUrl: `${base}/unete?status=cancel`,
      });
      // Client context solo para trazabilidad en logs de acceso (no se persiste aquí).
      void extractClientContext(req);
      return { url, sessionId };
    });
  }

  /** Tenant por dominio (Host / X-Forwarded-Host), como InscripcionController. */
  private async resolveTenantId(req: FastifyRequest): Promise<string> {
    const hostStr = resolvePublicHost(req);
    const tenant = await this.tenantResolver.resolveByHost(hostStr);
    if (!tenant) {
      throw new NotFoundException({
        message: 'Comunidad no encontrada para este dominio.',
        code: 'SUBS_TENANT_NOT_FOUND',
      });
    }
    return tenant.id;
  }
}
