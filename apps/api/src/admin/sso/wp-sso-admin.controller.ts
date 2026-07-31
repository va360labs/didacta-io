/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * WpSsoAdminController — gestión de la config WP-SSO del tenant desde el panel
 * (/admin/sso-wordpress). Mismo patrón que OidcAdminController PERO sin gate
 * Enterprise: WP-SSO es Community (sin @RequiresCapability).
 *
 *   GET    /api/v1/admin/sso/wp/config → vista config (sin secreto) + callbackUrl.
 *   PUT    /api/v1/admin/sso/wp/config → guarda config (cifra el secreto).
 *   DELETE /api/v1/admin/sso/wp/config → borra config.
 *
 * Todos con JwtAuthGuard + restricción a super_admin / tenant_admin. El secreto
 * nunca cruza la red en GET; sólo entra en PUT (y se cifra antes de persistir).
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { extractClientContext } from '../../auth/client-context';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { PrismaAuditLogService } from '../../modules/prisma-audit-log.service';
import { WpSsoConfigService } from '../../sso/wp/wp-sso-config.service';
import { wpSsoConfigPutSchema, type WpSsoConfigPutDto } from '../../sso/wp/wp-sso.dto';

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

function requireTenantAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException(
      'Solo super_admin y tenant_admin pueden gestionar la configuración WP-SSO.',
    );
  }
  return user;
}

@ApiTags('SSO · WordPress Admin')
@ApiBearerAuth()
@Controller('admin/sso/wp')
@UseGuards(JwtAuthGuard)
export class WpSsoAdminController {
  constructor(
    private readonly wpConfig: WpSsoConfigService,
    private readonly auditLog: PrismaAuditLogService,
  ) {}

  @Get('config')
  @ApiOperation({
    summary:
      'Devuelve la config WP-SSO del tenant (sin secreto). Si no hay config aún, ' +
      'devuelve `{ exists: false, callbackUrl }` para mostrar el form vacío con la ' +
      'URL de callback ya rellena (la que se pega en wp-config.php).',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 403, description: 'Solo super_admin / tenant_admin.' })
  async getConfig(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireTenantAdmin(user);
    const config = await this.wpConfig.getSafeConfig(u.tenantId);
    if (!config) {
      return { exists: false, callbackUrl: await this.wpConfig.computeCallbackUrl(u.tenantId) };
    }
    return { exists: true, config };
  }

  @Put('config')
  @ApiOperation({
    summary:
      'Crea o actualiza la config WP-SSO del tenant. sharedSecret es opcional en ' +
      'updates: sólo enviarlo cuando se quiere rotar (vacío = preserva el guardado).',
  })
  @ApiResponse({ status: 200, description: 'Config guardada — devuelve la vista safe.' })
  @ApiResponse({ status: 400, description: 'DTO inválido.' })
  async setConfig(
    @Req() req: FastifyRequest,
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(wpSsoConfigPutSchema)) dto: WpSsoConfigPutDto,
  ) {
    const u = requireTenantAdmin(user);
    const safe = await this.wpConfig.setConfig(u.tenantId, dto, u.sub);

    const ctx = extractClientContext(req);
    await this.auditLog.record({
      tenantId: u.tenantId,
      actorId: u.sub,
      action: 'sso.wp.admin.config_saved',
      resourceType: 'wp_sso_config',
      resourceId: u.tenantId,
      metadata: {
        enabled: safe.enabled,
        issuer: safe.issuer || null,
        rotatedSecret: typeof dto.sharedSecret === 'string' && dto.sharedSecret.length > 0,
      },
      ip: ctx.ip ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
    });

    return { exists: true, config: safe };
  }

  @Delete('config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Borra la config WP-SSO del tenant. Tras esto, el SSO deja de ofrecerse.',
  })
  @ApiResponse({ status: 200 })
  async deleteConfig(@Req() req: FastifyRequest, @CurrentUser() user: SessionClaims | undefined) {
    const u = requireTenantAdmin(user);
    const result = await this.wpConfig.deleteConfig(u.tenantId, u.sub);
    if (result.deleted) {
      const ctx = extractClientContext(req);
      await this.auditLog.record({
        tenantId: u.tenantId,
        actorId: u.sub,
        action: 'sso.wp.admin.config_deleted',
        resourceType: 'wp_sso_config',
        resourceId: u.tenantId,
        metadata: {},
        ip: ctx.ip ?? undefined,
        userAgent: ctx.userAgent ?? undefined,
      });
    }
    return result;
  }
}
