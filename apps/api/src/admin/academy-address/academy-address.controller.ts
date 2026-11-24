/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractClientContext } from '../../auth/client-context';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import {
  AcademyAddressService,
  type AcademyAddressState,
  type AddressAvailability,
  type AddressChangeResult,
} from './academy-address.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

/** Lo que se escribe en el campo: se normaliza y valida en el servicio. */
export const AcademyAddressChangeSchema = z.object({
  label: z.string().min(1).max(100),
});

const AvailabilityQuerySchema = z.object({
  label: z.string().min(1).max(100),
});

function requireAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException({
      message: 'Solo quien administra la academia puede cambiar su dirección.',
      code: 'ACADEMY_ADDRESS_FORBIDDEN',
    });
  }
  return user;
}

/**
 * «Dirección de tu academia»: comprobar y cambiar el subdominio del aula desde
 * sus Ajustes, sin intervención de nadie. Como `AdminAcademyController`, no
 * acepta id: opera siempre sobre el aula del token.
 *
 * Sin `TENANT_SUBDOMAIN_SUFFIX` en la instancia las tres rutas responden 404
 * `ACADEMY_ADDRESS_DISABLED` y la web no enseña nada. La lógica vive en
 * `AcademyAddressService`.
 */
@ApiTags('Admin Academy')
@ApiBearerAuth()
@Controller('admin/tenant-settings/academy/address')
@UseGuards(JwtAuthGuard)
export class AcademyAddressController {
  constructor(private readonly service: AcademyAddressService) {}

  @Get()
  @ApiOperation({
    summary:
      'Dirección de la academia de quien llama: la actual, el sufijo fijo y si se puede cambiar ahora (límite: 3 cambios cada 30 días). 404 si la instancia no lo permite.',
  })
  async get(@CurrentUser() user: SessionClaims | undefined): Promise<AcademyAddressState> {
    const claims = requireAdmin(user);
    return this.service.getState(claims.tenantId);
  }

  @Get('availability')
  @ApiOperation({
    summary:
      '¿Está libre esta dirección? `status`: available | current | invalid | reserved | taken. No dice qué academia la tiene.',
  })
  async availability(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(AvailabilityQuerySchema))
    query: z.infer<typeof AvailabilityQuerySchema>,
  ): Promise<AddressAvailability> {
    const claims = requireAdmin(user);
    return this.service.checkAvailability(claims.tenantId, query.label);
  }

  @Put()
  @ApiOperation({
    summary:
      'Cambia la dirección de la academia. La anterior sigue siendo del aula: sus páginas redirigen a la nueva y `/api/*` sigue respondiendo. Las sesiones no pasan de una dirección a otra: todos vuelven a entrar en la nueva.',
  })
  async change(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(AcademyAddressChangeSchema))
    body: z.infer<typeof AcademyAddressChangeSchema>,
    @Req() req: FastifyRequest,
  ): Promise<AddressChangeResult> {
    const claims = requireAdmin(user);
    return this.service.change(
      claims.tenantId,
      claims.sub ?? null,
      body.label,
      extractClientContext(req),
    );
  }
}
