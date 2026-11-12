/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, NotFoundException, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { readRequestLocale } from '../../common/checkout-locale';
import { resolvePublicHost } from '../../common/resolve-public-host';
import { runAsTenant } from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { PurchaseConsentService } from './purchase-consent.service';
import { PURCHASE_KINDS, type PurchaseKind } from './withdrawal-waiver';

// Falso positivo: el esquema se usa dentro de un decorador (@Query), que el
// análisis de flujo de la regla no cuenta como «sentencia posterior».
// eslint-disable-next-line no-useless-assignment
const querySchema = z.object({
  kind: z.enum(PURCHASE_KINDS).default('course'),
  /** Idioma en que la web va a enseñar el texto. Sin él, el de la cookie. */
  locale: z.string().max(16).optional(),
});

/**
 * El texto de la casilla de compra (renuncia al desistimiento), tal como se
 * va a guardar como prueba. Público: lo pinta la ficha de venta antes de que
 * el comprador tenga cuenta. Tenant por Host, igual que el catálogo.
 */
@ApiTags('Compras · Consentimiento')
@Controller('purchase-consent')
export class PurchaseConsentController {
  constructor(
    private readonly consents: PurchaseConsentService,
    private readonly tenantResolver: TenantResolverService,
  ) {}

  @Get('withdrawal-waiver')
  @ApiOperation({
    summary:
      'Texto (y versión) de la casilla «quiero empezar ya y pierdo el desistimiento» para esta aula, en el idioma del comprador.',
  })
  async waiver(
    @Req() req: FastifyRequest,
    @Query(new ZodValidationPipe(querySchema)) query: { kind: PurchaseKind; locale?: string },
  ) {
    const tenant = await this.tenantResolver.resolveByHost(resolvePublicHost(req));
    if (!tenant) {
      throw new NotFoundException({
        message: 'Comunidad no encontrada para este dominio.',
        code: 'PURCHASE_CONSENT_TENANT_NOT_FOUND',
      });
    }
    const rendered = await runAsTenant(tenant.id, () =>
      this.consents.render(tenant.id, query.kind, query.locale ?? readRequestLocale(req.headers)),
    );
    return {
      version: rendered.version,
      locale: rendered.locale,
      statement: rendered.statement,
      sellerLine: rendered.sellerLine,
      sellerName: rendered.sellerName,
    };
  }
}
