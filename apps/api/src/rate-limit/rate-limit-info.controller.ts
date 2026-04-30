/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * RateLimitInfoController — endpoint informativo del sexto piloto License SDK.
 *
 *   GET /api/v1/admin/rate-limit/info  →  super_admin / tenant_admin
 *
 * Devuelve la configuración efectiva en runtime: tier activo (community o
 * enterprise según licencia + capability `feat:api.rate_limit.elevated`),
 * límites por bucket y ventana.
 *
 * IMPORTANTE: este endpoint NO va gateado por la capability — es informativo.
 * El frontend lo consume tanto en plan community (para mostrar "estás en el
 * tier free, upgrade a EE para subir el rate") como en EE (para mostrar las
 * cifras reales). El upsell se decide en el frontend con `<EeGate>` solo
 * para el botón "Upgrade", no para el panel completo.
 */

import {
  Controller,
  ForbiddenException,
  Get,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import {
  RATE_LIMIT_ELEVATED_CAPABILITY,
  type RateLimitConfig,
  type RateLimitTier,
} from './rate-limit.types';
import { RateLimitService } from './rate-limit.service';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

function requireTenantAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException(
      'Solo super_admin y tenant_admin pueden consultar la configuración de rate limit.',
    );
  }
  return user;
}

export interface RateLimitInfoResponse {
  tier: RateLimitTier;
  authenticated: { limit: number; windowSeconds: number };
  public: { limit: number; windowSeconds: number };
  capability: string;
  community: RateLimitConfig['community'];
  enterprise: RateLimitConfig['enterprise'];
}

@ApiTags('Admin · Rate Limit')
@ApiBearerAuth()
@Controller('admin/rate-limit')
@UseGuards(JwtAuthGuard)
export class RateLimitInfoController {
  constructor(private readonly rateLimit: RateLimitService) {}

  @Get('info')
  @ApiOperation({
    summary:
      'Devuelve el tier activo (community / enterprise) y las cifras de rate limit ' +
      'efectivas. NO está gateado por la capability — sirve también para mostrar ' +
      'el upsell desde el plan comunidad. La capability EE asociada es ' +
      '`feat:api.rate_limit.elevated`.',
  })
  @ApiResponse({ status: 200, description: 'Configuración de rate limit.' })
  @ApiResponse({ status: 401, description: 'No autenticado.' })
  @ApiResponse({ status: 403, description: 'Solo super_admin / tenant_admin.' })
  info(@CurrentUser() user: SessionClaims | undefined): RateLimitInfoResponse {
    requireTenantAdmin(user);
    const config = this.rateLimit.getConfig();
    const tier = this.rateLimit.getCurrentTier();

    const effective = tier === 'enterprise' ? config.enterprise : config.community;
    return {
      tier,
      authenticated: {
        limit: effective.authenticated,
        windowSeconds: config.windowSeconds,
      },
      public: {
        limit: effective.public,
        windowSeconds: config.windowSeconds,
      },
      capability: RATE_LIMIT_ELEVATED_CAPABILITY,
      community: config.community,
      enterprise: config.enterprise,
    };
  }
}
