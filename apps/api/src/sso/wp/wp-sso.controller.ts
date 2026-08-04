/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Controller, Get, HttpStatus, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WpSsoTokenError } from '@didacta/mod-wp-sso';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../auth/decorators';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { WpSsoService } from './wp-sso.service';
import { WpSsoConfigService } from './wp-sso-config.service';

/**
 * Endpoints públicos de SSO desde WordPress, POR TENANT (el slug va en la ruta).
 * Llega como GET desde el navegador (clic o auto-bounce), así que respondemos con
 * redirect 302 — igual que OIDC/SAML:
 *   - OK    → ${WEB}/auth/callback?accessToken=...&refreshToken=...
 *   - Error → ${WEB}/auth/error?reason=<code>
 *
 * Montado bajo el prefijo global /api/v1 → /api/v1/modules/wp-sso/:tenantSlug/*
 * (coincide con apiNamespace del manifest de mod.wp-sso). La config NO viene de
 * env: WpSsoConfigService la lee cifrada de BD por tenant.
 */
@ApiTags('Modules · WP-SSO')
@Controller('modules/wp-sso')
export class WpSsoController {
  constructor(
    private readonly wpSso: WpSsoService,
    private readonly config: WpSsoConfigService,
    private readonly tenantResolver: TenantResolverService,
  ) {}

  @Get(':tenantSlug/status')
  @Public()
  @ApiOperation({
    summary:
      'Config pública de WP-SSO del tenant (sin secretos): { configured, autoRedirect, wordpressUrl }. ' +
      'La consume el signin para el auto-bounce transparente.',
  })
  status(@Param('tenantSlug') tenantSlug: string) {
    return this.config.getPublicStatus(tenantSlug);
  }

  @Get(':tenantSlug/callback')
  @Public()
  @ApiOperation({
    summary:
      'Callback SSO del tenant: recibe el token firmado por WordPress (?token=), lo verifica con la config del tenant, resuelve/crea el usuario y redirige al frontend con la sesión.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect a /auth/callback (OK) o /auth/error (fallo).',
  })
  async callback(
    @Param('tenantSlug') tenantSlug: string,
    @Query('token') token: string | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: false }) res: FastifyReply,
  ): Promise<void> {
    // Base endurecida: para un redirect que porta tokens NO confiamos en el
    // header Host (open-redirect con exfiltración); solo WEB_PUBLIC_URL, el
    // dominio primario verificado del tenant, o un host de la allowlist. Se
    // resuelve el tenant por slug ANTES (lookup barato, de solo lectura) para
    // poder usar su dominio incluso si el intercambio del token falla.
    const resolvedTenant = await this.tenantResolver.resolveBySlug(tenantSlug);
    const base = await this.tenantResolver.resolveTenantWebBaseUrlForAuthRedirect(
      resolvedTenant?.id ?? null,
      req,
    );
    try {
      const result = await this.wpSso.exchange(tenantSlug, token ?? '');
      // El handler del frontend (oidc-callback-handler) EXIGE el set completo:
      // sin userId/email/tenantId/tenantSlug aborta a /auth/error?reason=missing_tokens.
      // Replicamos lo que emite el callback OIDC (oidc.controller.ts).
      const url = new URL(`${base}/auth/callback`);
      url.searchParams.set('accessToken', result.tokens.accessToken);
      url.searchParams.set('refreshToken', result.tokens.refreshToken);
      url.searchParams.set('userId', result.user.id);
      url.searchParams.set('email', result.user.email);
      if (result.user.name) url.searchParams.set('name', result.user.name);
      url.searchParams.set('tenantId', result.user.tenantId);
      url.searchParams.set('tenantSlug', result.user.tenantSlug);
      url.searchParams.set('roles', result.user.roles.join(','));
      // WordPress ya autenticó al usuario; el cliente refleja mfaEnabled=true para
      // no proponer setup de MFA local (mismo criterio que OIDC/SAML).
      url.searchParams.set('mfaEnabled', 'true');
      void res.status(HttpStatus.FOUND).redirect(url.toString());
    } catch (e) {
      const reason =
        e instanceof WpSsoTokenError
          ? e.code
          : e instanceof Error && e.message.includes('no está activa')
            ? 'user_inactive'
            : e instanceof Error && e.message.includes('No tienes cuenta')
              ? 'user_not_provisioned'
              : 'wp_sso_failed';
      const url = new URL(`${base}/auth/error`);
      url.searchParams.set('reason', reason);
      void res.status(HttpStatus.FOUND).redirect(url.toString());
    }
  }
}
