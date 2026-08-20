/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, NotFoundException, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { resolvePublicHost } from '../common/resolve-public-host';
import { PrismaService } from '../prisma/prisma.service';
import { TenantModulesService } from '../modules/tenant-modules.service';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';

/**
 * Contexto del sitio público, resuelto por dominio y SIN sesión.
 *
 * El equivalente autenticado (`GET /me/modules`) no sirve aquí: un visitante
 * anónimo no tiene tenant en ningún token, así que lo único que identifica al
 * tenant es el dominio por el que ha entrado.
 *
 * Devuelve lo mínimo para decidir qué se renderiza y bajo qué origen:
 *
 *   - `tenantId` / `tenantSlug` — a quién pertenece este dominio.
 *   - `activeModules` — qué módulos puede aportar rutas públicas.
 *   - `origin` — el origen canónico del sitio, DERIVADO DEL DOMINIO por el que
 *     ha llegado la petición. De aquí salen canonical, Open Graph y sitemap,
 *     y por eso mover el sitio de un dominio a otro es cambiar una fila y no
 *     desplegar.
 *
 * Devuelve 404 —no 403, ni una pista— si el dominio no está registrado o no
 * sirve el sitio: un host desconocido no debe poder averiguar qué tenants
 * existen en la instancia.
 */
@ApiTags('Sitio público')
@Controller('public')
export class SiteContextController {
  constructor(
    private readonly tenantResolver: TenantResolverService,
    private readonly tenantModules: TenantModulesService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('site-context')
  @ApiOperation({
    summary:
      'Contexto del sitio público del dominio de la petición: tenant, módulos activos y origen canónico. Sin sesión. 404 si el dominio no existe o no sirve el sitio público.',
  })
  @ApiResponse({ status: 404, description: 'El dominio no sirve un sitio público.' })
  async siteContext(@Req() req: FastifyRequest) {
    const tenant = await this.tenantResolver.resolveByRequest(req);
    if (!tenant) throw new NotFoundException('Dominio no encontrado.');

    const domain = await this.prisma.tenantDomain.findUnique({
      where: { hostname: tenant.hostname },
      select: { surface: true },
    });
    if (domain?.surface !== 'SITE') {
      throw new NotFoundException('Este dominio no sirve un sitio público.');
    }

    const modules = await this.tenantModules.list(tenant.id);
    const activeModules = modules.filter((m) => m.enabled).map((m) => m.name);

    return {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      tenantName: tenant.name,
      hostname: tenant.hostname,
      // El protocolo sale de lo que diga el proxy; en local, http.
      origin: `${forwardedProto(req)}://${resolvePublicHost(req) ?? tenant.hostname}`,
      activeModules,
    };
  }
}

function forwardedProto(req: FastifyRequest): string {
  const raw = req.headers['x-forwarded-proto'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const first = value?.split(',')[0]?.trim();
  if (first) return first;
  return req.protocol && req.protocol.length > 0 ? req.protocol : 'https';
}
