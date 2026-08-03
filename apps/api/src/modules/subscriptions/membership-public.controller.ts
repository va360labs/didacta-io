/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Body, Controller, Get, NotFoundException, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { extractClientContext } from '../../auth/client-context';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { resolveWebBaseUrl } from '../../common/resolve-web-base-url';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { ModuleRegistryService } from '../module-registry.service';
import { membershipCheckoutSchema, type MembershipCheckoutDto } from './membership.dto';

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
    return runAsTenant(tenantId, () =>
      this.registry.getMembershipService().getPublicPage(tenantId),
    );
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
    const base = resolveWebBaseUrl(req);
    return runAsTenant(tenantId, async () => {
      const { url, sessionId } = await this.registry
        .getMembershipService()
        .startMembershipCheckout({
          tenantId,
          planId: dto.planId,
          email: dto.email,
          referralCode: dto.referralCode,
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
    const host = req.headers.host ?? req.headers['x-forwarded-host'];
    const hostStr = Array.isArray(host) ? host[0] : host;
    const tenant = await this.tenantResolver.resolveByHost(hostStr);
    if (!tenant) {
      throw new NotFoundException('Comunidad no encontrada para este dominio.');
    }
    return tenant.id;
  }
}
