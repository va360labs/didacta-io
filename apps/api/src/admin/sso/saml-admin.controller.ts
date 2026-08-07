/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * SamlAdminController — endpoints admin del 9º piloto License SDK
 * (`feat:sso.saml`).
 *
 *   GET    /api/v1/admin/sso/saml/config            → vista config + SP URLs.
 *   PUT    /api/v1/admin/sso/saml/config            → guarda config.
 *   DELETE /api/v1/admin/sso/saml/config            → desactiva.
 *   POST   /api/v1/admin/sso/saml/test-connection   → valida cert + URL.
 *
 * TODOS los endpoints van con:
 *   - JwtAuthGuard.
 *   - @RequiresCapability(SSO_SAML). Sin licencia → 402 vía LicenseExceptionFilter.
 *   - Restricción a roles super_admin / tenant_admin.
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
import { PrismaService } from '../../prisma/prisma.service';
import { SamlService } from '../../sso/saml/saml.service';
import {
  samlConfigPutSchema,
  samlTestConnectionSchema,
  type SamlConfigPutDto,
  type SamlTestConnectionDto,
} from '../../sso/saml/saml.dto';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

function requireTenantAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException({
      message: 'Solo super_admin y tenant_admin pueden gestionar la configuración SSO.',
      code: 'ADMIN_SSO_CONFIG_FORBIDDEN',
    });
  }
  return user;
}

@ApiTags('SSO · SAML Admin')
@ApiBearerAuth()
@Controller('admin/sso/saml')
@UseGuards(JwtAuthGuard)
export class SamlAdminController {
  constructor(
    private readonly saml: SamlService,
    private readonly auditLog: PrismaAuditLogService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('config')
  @RequiresCapability(LICENSE_CAPABILITIES.SSO_SAML)
  @ApiOperation({
    summary:
      'Devuelve la config SAML del tenant + las SP URLs (entityId, ACS, metadata) ' +
      'que el admin debe pegar en el panel del IdP. Si no hay config, devuelve ' +
      '`{ exists: false, sp: { ... } }`.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 402, description: 'Capability `feat:sso.saml` no licenciada.' })
  @ApiResponse({ status: 403, description: 'Solo super_admin / tenant_admin.' })
  async getConfig(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireTenantAdmin(user);
    const tenant = await this.prisma.tenant.findUnique({ where: { id: u.tenantId } });
    if (!tenant) throw new UnauthorizedException();

    const config = await this.saml.getSafeConfig(u.tenantId, tenant.slug);
    if (!config) {
      return {
        exists: false,
        sp: {
          entityId: this.saml.spEntityIdForTenant(tenant.slug),
          acsUrl: this.saml.spAcsUrlForTenant(tenant.slug),
          metadataUrl: this.saml.spMetadataUrlForTenant(tenant.slug),
        },
        capability: LICENSE_CAPABILITIES.SSO_SAML,
      };
    }
    return { exists: true, config, capability: LICENSE_CAPABILITIES.SSO_SAML };
  }

  @Put('config')
  @RequiresCapability(LICENSE_CAPABILITIES.SSO_SAML)
  @ApiOperation({
    summary:
      'Crea o actualiza la config SAML del tenant. El cert IdP es público, así ' +
      'que se envía completo en cada PUT (no hay rotación parcial como con OIDC ' +
      'clientSecret).',
  })
  @ApiResponse({ status: 200, description: 'Config guardada — devuelve la vista safe.' })
  @ApiResponse({ status: 400, description: 'DTO inválido.' })
  @ApiResponse({ status: 402 })
  async setConfig(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(samlConfigPutSchema)) dto: SamlConfigPutDto,
  ) {
    const u = requireTenantAdmin(user);
    const tenant = await this.prisma.tenant.findUnique({ where: { id: u.tenantId } });
    if (!tenant) throw new UnauthorizedException();

    const safe = await this.saml.setConfig(u.tenantId, tenant.slug, dto, u.sub);

    const ctx = extractClientContext(req);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'sso.saml.admin.config_saved',
      resourceType: 'saml_config',
      resourceId: u.tenantId,
      metadata: {
        idpEntityId: safe.idpEntityId,
        idpSsoUrl: safe.idpSsoUrl,
        enabled: safe.enabled,
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return { exists: true, config: safe };
  }

  @Delete('config')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(LICENSE_CAPABILITIES.SSO_SAML)
  @ApiOperation({
    summary:
      'Borra la config SAML del tenant. Tras esto, /auth/saml/:slug/login ' +
      'devolverá 404 hasta que se vuelva a configurar.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 402 })
  async deleteConfig(@Req() req: FastifyRequest, @CurrentUser() user: SessionClaims | undefined) {
    const u = requireTenantAdmin(user);
    const result = await this.saml.deleteConfig(u.tenantId, u.sub);

    if (result.deleted) {
      const ctx = extractClientContext(req);
      await this.auditLog.record({
        tenantId: u.tenantId,
        actorId: u.sub,
        action: 'sso.saml.admin.config_deleted',
        resourceType: 'saml_config',
        resourceId: u.tenantId,
        metadata: {},
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });
    }
    return result;
  }

  @Post('test-connection')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(LICENSE_CAPABILITIES.SSO_SAML)
  @ApiOperation({
    summary:
      'Valida formato del cert PEM (X.509) y URL del IdP. NO hace una llamada ' +
      'real al IdP (SAML no tiene discovery), sólo confirma que los datos son ' +
      'usables antes de guardar la config.',
  })
  @ApiResponse({ status: 200, description: '{ ok: true, ... } o { ok: false, error }' })
  @ApiResponse({ status: 402 })
  async testConnection(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(samlTestConnectionSchema)) dto: SamlTestConnectionDto,
  ) {
    requireTenantAdmin(user);
    return this.saml.testConnection(dto.idpCertificate, dto.idpSsoUrl);
  }
}
