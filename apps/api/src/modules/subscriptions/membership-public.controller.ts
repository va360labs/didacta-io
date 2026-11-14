/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Optional,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { toCheckoutLocale } from '@didacta/mod-billing';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { extractClientContext } from '../../auth/client-context';
import { readRequestLocale } from '../../common/checkout-locale';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { ModuleRegistryService } from '../module-registry.service';
import { PurchaseConsentService } from '../purchase-consent/purchase-consent.service';
import {
  PAYOUTS_NOT_READY_OFFER_REASON,
  PlatformCheckoutGate,
  withLocalCurrencyHint,
} from '../payouts/platform-checkout-gate';
import { membershipCheckoutSchema, type MembershipCheckoutDto } from './membership.dto';
import { resolvePublicHost } from '../../common/resolve-public-host';
import {
  checkoutSessionNotFound,
  ensureCheckoutSessionId,
  type PublicCheckoutResponse,
} from '../checkout-ui';

/**
 * Endpoints PÚBLICOS de la página de membresía (/join).
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
    /** Renuncia al desistimiento: prueba antes de pagar y confirmación después. */
    private readonly consents: PurchaseConsentService,
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
  ): Promise<PublicCheckoutResponse> {
    const tenantId = await this.resolveTenantId(req);
    const base = await this.tenantResolver.resolveTenantWebBaseUrl(tenantId, req);
    return runAsTenant(tenantId, async () => {
      const membership = this.registry.getMembershipService();
      // Modo plataforma: 409 si la cuenta no puede vender; si puede, el precio
      // del plan en la cuenta del operador (antes de crear nada).
      await this.payoutsGate?.prepareMembershipCheckout(tenantId, dto.planId, membership);
      // La casilla de la renuncia al desistimiento (422 sin ella, 409 si el
      // texto cambió), guardada antes de crear la sesión de pago.
      const consentId = await this.consents.accept({
        req,
        tenantId,
        purchaseKind: 'membership',
        itemRef: dto.planId,
        itemName: await this.planName(tenantId, dto.planId),
        userId: null,
        buyerEmail: dto.email ?? null,
        waiver: dto.withdrawalWaiver,
      });
      // Pago dentro de /join si la página lo pide y hay clave publicable de
      // la cuenta que cobra (plataforma o claves propias del aula).
      const publishableKey =
        dto.uiMode === 'embedded'
          ? await this.registry.resolveCheckoutPublishableKey(tenantId)
          : null;
      const requestLocale = readRequestLocale(req.headers);
      const checkoutLocale = toCheckoutLocale(requestLocale);
      const result = await membership.startMembershipCheckout({
        tenantId,
        planId: dto.planId,
        email: dto.email,
        referralCode: dto.referralCode,
        // Idioma con el que el comprador está navegando AHORA. Viaja en la
        // metadata de Stripe porque su fila de `user` no existe todavía: se
        // crea en el webhook, después del salto a la pasarela.
        locale: requestLocale,
        ...(checkoutLocale ? { checkoutLocale } : {}),
        successUrl: `${base}/join?status=success&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${base}/join?status=cancel`,
        // Embebido: una sola vuelta que PREGUNTA si se pagó.
        ...(publishableKey
          ? {
              uiMode: 'embedded' as const,
              returnUrl: `${base}/join?status=success&session_id={CHECKOUT_SESSION_ID}&checkout=embedded`,
            }
          : {}),
      });
      await this.consents.attachSession(tenantId, consentId, { sessionId: result.sessionId });
      // Client context solo para trazabilidad en logs de acceso (no se persiste aquí).
      void extractClientContext(req);
      if (publishableKey && result.clientSecret) {
        return {
          mode: 'embedded',
          sessionId: result.sessionId,
          url: null,
          clientSecret: result.clientSecret,
          publishableKey,
          amountTotal: result.amountTotal,
          currency: result.currency,
        };
      }
      return { mode: 'hosted', url: result.url ?? '', sessionId: result.sessionId };
    });
  }

  @Get('checkout-session/:sessionId')
  @ApiOperation({
    summary:
      'Vuelta del pago de la membresía: si la sesión de ESTA academia está completada, qué plan, cuánto y cuándo. No concede nada. 404 si no es una sesión de membresía de esta academia.',
  })
  async checkoutSession(@Req() req: FastifyRequest, @Param('sessionId') sessionId: string) {
    ensureCheckoutSessionId(sessionId);
    const tenantId = await this.resolveTenantId(req);
    return runAsTenant(tenantId, async () => {
      const membership = this.registry.getMembershipService();
      const state = await membership.getCheckoutSessionState(tenantId, sessionId);
      if (!state) throw checkoutSessionNotFound();
      const planName = state.planId ? await this.planName(tenantId, state.planId) : null;
      return {
        status: state.status,
        paid: state.paid,
        amount: state.amount,
        currency: state.currency,
        at: state.at,
        plan: planName ? { name: planName } : null,
      };
    });
  }

  /** Nombre del plan para la prueba y el correo (lectura del propio módulo). */
  private async planName(tenantId: string, planId: string): Promise<string | null> {
    try {
      const page = await this.registry.getMembershipService().getPublicPage(tenantId);
      return page.plans.find((plan) => plan.id === planId)?.name ?? null;
    } catch {
      return null;
    }
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
