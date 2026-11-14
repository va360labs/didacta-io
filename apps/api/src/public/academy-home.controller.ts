/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, NotFoundException, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { resolvePublicHome, type PublicHomeReader } from '../common/academy-public-home';
import { resolvePublicHost } from '../common/resolve-public-host';
import { PrismaService } from '../prisma/prisma.service';
import { runAsTenant } from '../tenancy/tenant-context.storage';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import { AcademyHomeService, type AcademyHomeData } from './academy-home.service';

export type AcademyHomeResponse = { enabled: false } | ({ enabled: true } & AcademyHomeData);

/**
 * Página pública de la academia, SIN sesión: la raíz del aula para quien aún no
 * es miembro (ver `AcademyHomeService`).
 *
 * El aula sale SIEMPRE del dominio de la petición (`X-Forwarded-Host` y, si no
 * viene, `Host`), como el resto de la superficie pública. No hay parámetro que
 * elija otra: la ruta no lee query ni body.
 *
 * Con el ajuste del aula apagado («ir directo al acceso») contesta solo
 * `{ enabled: false }`, sin ningún dato más: el web manda al acceso.
 */
@ApiTags('Sitio público')
@Controller('public')
export class AcademyHomeController {
  constructor(
    private readonly tenantResolver: TenantResolverService,
    private readonly prisma: PrismaService,
    private readonly home: AcademyHomeService,
  ) {}

  @Get('academy-home')
  @ApiOperation({
    summary:
      'Página pública de la academia del dominio de la petición: marca, nº de miembros, quien la lleva, próximo directo y opciones de acceso (cursos a la venta, membresía, acceso gratuito). Sin sesión. `{ enabled: false }` si el aula la tiene apagada.',
  })
  @ApiResponse({ status: 404, description: 'El dominio no es de ningún aula activa.' })
  async academyHome(@Req() req: FastifyRequest): Promise<AcademyHomeResponse> {
    const tenant = await this.tenantResolver.resolveByHost(resolvePublicHost(req));
    if (!tenant) {
      throw new NotFoundException({
        message: 'Academia no encontrada para este dominio.',
        code: 'ACADEMY_HOME_NOT_FOUND',
      });
    }
    // RLS: ruta pública sin middleware de tenant. Todo corre bajo el aula
    // resuelta por el dominio.
    return runAsTenant(
      tenant.id,
      async (): Promise<AcademyHomeResponse> => {
        const state = await resolvePublicHome(
          this.prisma as unknown as PublicHomeReader,
          tenant.id,
        );
        if (!state.enabled) return { enabled: false };
        return { enabled: true, ...(await this.home.get(tenant.id)) };
      },
      { traceLabel: 'academy-home' },
    );
  }
}
