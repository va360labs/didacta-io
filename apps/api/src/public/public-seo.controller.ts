/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, NotFoundException, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { resolvePublicHost } from '../common/resolve-public-host';
import { runAsTenant } from '../tenancy/tenant-context.storage';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import { PublicSeoService, type PublicSeoResponse } from './public-seo.service';

/**
 * Lo que el aula del dominio de la petición enseña a los buscadores (ver
 * `PublicSeoService`). SIN sesión, como la propia portada.
 *
 * El aula sale SIEMPRE del dominio (`X-Forwarded-Host` y, si no viene, `Host`):
 * la ruta no lee query ni body, así que no hay forma de pedir el sitemap de
 * otra. Un dominio que no es de ningún aula da 404 (sin pista de qué aulas
 * existen); el de un SITIO público no es un aula y contesta que no se indexa
 * nada de ella (su sitio tiene sus propias reglas).
 */
@ApiTags('Sitio público')
@Controller('public')
export class PublicSeoController {
  constructor(
    private readonly tenantResolver: TenantResolverService,
    private readonly seo: PublicSeoService,
  ) {}

  @Get('seo')
  @ApiOperation({
    summary:
      'Indexación del aula del dominio de la petición: si se indexa, dominio canónico, idioma, datos públicos de la academia y fichas de venta con su última modificación. Sin sesión. `{ indexable: false }` con la página pública apagada.',
  })
  @ApiResponse({ status: 404, description: 'El dominio no es de ningún aula activa.' })
  async publicSeo(@Req() req: FastifyRequest): Promise<PublicSeoResponse> {
    const tenant = await this.tenantResolver.resolveByHost(resolvePublicHost(req));
    if (!tenant) {
      throw new NotFoundException({
        message: 'Academia no encontrada para este dominio.',
        code: 'PUBLIC_SEO_NOT_FOUND',
      });
    }
    if (tenant.surface === 'SITE') return { indexable: false };
    // RLS: ruta pública sin middleware de tenant. Todo corre bajo el aula
    // resuelta por el dominio.
    return runAsTenant(tenant.id, () => this.seo.get(tenant.id), { traceLabel: 'public-seo' });
  }
}
