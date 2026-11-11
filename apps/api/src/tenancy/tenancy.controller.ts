/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { resolvePublicHost } from '../common/resolve-public-host';
import { TenantResolverService } from './tenant-resolver.service';

/**
 * ¿Este hostname pertenece a algún tenant?
 *
 * Existe para que el middleware del web pueda devolver 404 en un subdominio sin
 * asignar (UC-C403 AC2). Con el comodín `*.didacta.io`, Traefik enruta al pool
 * CUALQUIER nombre —esa es justo la propiedad que hace que un aula recién
 * aprovisionada funcione sin tocar el proxy—, así que la única capa que puede
 * decir «este host no es de nadie» es la aplicación.
 *
 * `auth/tenant-context` ya responde algo parecido, pero además consulta
 * theming y dos cifras reales del tenant. Esto lo llama el middleware en CADA
 * navegación: tiene que ser una sola consulta a `tenant_domain` y nada más.
 *
 * No revela nada que no fuera público: quién quiera saber si un subdominio
 * existe solo tiene que visitarlo.
 *
 * `suspended` distingue el aula que existe pero está suspendida del host que no
 * es de nadie, para que el web pueda decírselo a quien llega en vez de un «Not
 * Found». Va con `known: false` y SIN slug ni surface: de un tenant suspendido
 * no sale nada más que el hecho de que lo está. Y como `known` sigue en false,
 * un web anterior a este campo se comporta como antes (404).
 */
@ApiTags('Tenancy')
@Controller('tenancy')
export class TenancyController {
  constructor(private readonly tenantResolver: TenantResolverService) {}

  @Get('resolve')
  @ApiOperation({
    summary:
      'Resuelve el host público del request a un tenant. { known, slug, host, surface, suspended }.',
    description:
      'El host sale de `X-Forwarded-Host` y, si no viene, de `Host`. El middleware del web reenvía el suyo en `X-Forwarded-Host` para preguntar por el dominio del visitante y no por el del salto interno. `surface` dice si ese dominio sirve la app del aula (`APP`) o el sitio público (`SITE`), para que el middleware reparta sin una segunda llamada por navegación. `suspended: true` significa que el dominio es de un tenant suspendido: llega con `known: false` y sin `slug` ni `surface`.',
  })
  async resolve(@Req() req: FastifyRequest) {
    const host = resolvePublicHost(req);
    const resolution = await this.tenantResolver.resolveHostStatusByRequest(req);
    const tenant = resolution.status === 'active' ? resolution.tenant : null;
    return {
      known: tenant !== null,
      slug: tenant?.slug ?? null,
      host: host ?? null,
      surface: tenant?.surface ?? null,
      suspended: resolution.status === 'suspended',
    };
  }
}
