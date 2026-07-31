/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * OidcAdminController — endpoints admin del 8º piloto License SDK
 * (`feat:sso.oidc`).
 *
 *   GET    /api/v1/admin/sso/oidc/config           → vista config (sin secret).
 *   PUT    /api/v1/admin/sso/oidc/config           → guarda config (cifra secret).
 *   DELETE /api/v1/admin/sso/oidc/config           → desactiva.
 *   POST   /api/v1/admin/sso/oidc/test-discovery   → probe del issuer URL.
 *
 * TODOS los endpoints van con:
 *   - JwtAuthGuard (admin loguea con email+password+MFA).
 *   - @RequiresCapability(SSO_OIDC). Sin licencia → 402 vía LicenseExceptionFilter.
 *   - Restricción a roles super_admin / tenant_admin.
 *
 * El secret nunca cruza la red en GET; sólo entra en PUT (y se cifra antes de
 * persistir). Mismo patrón que SCIM admin token + custom domains.
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { LICENSE_CAPABILITIES, RequiresCapability } from '@didacta/license-sdk';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { extractClientContext } from '../../auth/client-context';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { PrismaAuditLogService } from '../../modules/prisma-audit-log.service';
import { OidcService } from '../../sso/oidc/oidc.service';
import {
  oidcConfigPutSchema,
  oidcTestDiscoverySchema,
  type OidcConfigPutDto,
  type OidcTestDiscoveryDto,
} from '../../sso/oidc/oidc.dto';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

function requireTenantAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException(
      'Solo super_admin y tenant_admin pueden gestionar la configuración SSO.',
    );
  }
  return user;
}

@ApiTags('SSO · OIDC Admin')
@ApiBearerAuth()
@Controller('admin/sso/oidc')
@UseGuards(JwtAuthGuard)
export class OidcAdminController {
  constructor(
    private readonly oidc: OidcService,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  @Get('config')
  @RequiresCapability(LICENSE_CAPABILITIES.SSO_OIDC)
  @ApiOperation({
    summary:
      'Devuelve la config OIDC del tenant (sin clientSecret). Si no hay config ' +
      'aún, devuelve `{ exists: false, redirectUri }` para que el panel pueda ' +
      'mostrar el form vacío con la URL de callback ya rellena.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 402, description: 'Capability `feat:sso.oidc` no licenciada.' })
  @ApiResponse({ status: 403, description: 'Solo super_admin / tenant_admin.' })
  async getConfig(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireTenantAdmin(user);
    const config = await this.oidc.getSafeConfig(u.tenantId);
    if (!config) {
      // Devolvemos un objeto consistente con redirectUri para que el panel
      // muestre el form vacío sabiendo qué URL pegar en el IdP.
      return {
        exists: false,
        redirectUri: this.oidc.__redirectUriForTest,
        capability: LICENSE_CAPABILITIES.SSO_OIDC,
      };
    }
    return { exists: true, config, capability: LICENSE_CAPABILITIES.SSO_OIDC };
  }

  @Put('config')
  @RequiresCapability(LICENSE_CAPABILITIES.SSO_OIDC)
  @ApiOperation({
    summary:
      'Crea o actualiza la config OIDC del tenant. clientSecret es opcional ' +
      'en updates posteriores: sólo enviarlo cuando se quiere rotar.',
  })
  @ApiResponse({ status: 200, description: 'Config guardada — devuelve la vista safe.' })
  @ApiResponse({ status: 400, description: 'DTO inválido.' })
  @ApiResponse({ status: 402 })
  async setConfig(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(oidcConfigPutSchema)) dto: OidcConfigPutDto,
  ) {
    const u = requireTenantAdmin(user);
    const safe = await this.oidc.setConfig(u.tenantId, dto, u.sub);

    // Audit log adicional con el client context (el service ya añadió el
    // entry "config.created/updated"; este registra IP+UA del admin).
    const ctx = extractClientContext(req);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'sso.oidc.admin.config_saved',
      resourceType: 'oidc_config',
      resourceId: u.tenantId,
      metadata: {
        issuer: safe.issuer,
        clientId: safe.clientId,
        rotatedSecret: typeof dto.clientSecret === 'string' && dto.clientSecret.length > 0,
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return { exists: true, config: safe };
  }

  @Delete('config')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(LICENSE_CAPABILITIES.SSO_OIDC)
  @ApiOperation({
    summary:
      'Borra la config OIDC del tenant. Tras esto, /auth/oidc/:slug/start ' +
      'devolverá 404 hasta que se vuelva a configurar.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 402 })
  async deleteConfig(@Req() req: FastifyRequest, @CurrentUser() user: SessionClaims | undefined) {
    const u = requireTenantAdmin(user);
    const result = await this.oidc.deleteConfig(u.tenantId, u.sub);

    if (result.deleted) {
      const ctx = extractClientContext(req);
      await this.auditLog.record({
        tenantId: u.tenantId,
        actorId: u.sub,
        action: 'sso.oidc.admin.config_deleted',
        resourceType: 'oidc_config',
        resourceId: u.tenantId,
        metadata: {},
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });
    }
    return result;
  }

  @Post('test-discovery')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(LICENSE_CAPABILITIES.SSO_OIDC)
  @ApiOperation({
    summary:
      'Hace OIDC Discovery contra el issuer dado y devuelve los endpoints ' +
      'descubiertos (authorization, token, jwks). Útil para validar la URL ' +
      'antes de guardar la config completa.',
  })
  @ApiResponse({ status: 200, description: '{ ok: true, ... } o { ok: false, error }' })
  @ApiResponse({ status: 402 })
  async testDiscovery(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(oidcTestDiscoverySchema)) dto: OidcTestDiscoveryDto,
  ) {
    requireTenantAdmin(user);
    return this.oidc.testDiscovery(dto.issuer);
  }
}
