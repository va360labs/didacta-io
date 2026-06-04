import { Controller, Get, HttpStatus, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WpSsoTokenError } from '@didacta/mod-wp-sso';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../auth/decorators';
import { resolveWebBaseUrl } from '../../common/resolve-web-base-url';
import { WpSsoService } from './wp-sso.service';

/**
 * Endpoint público de SSO desde WordPress. Llega como GET desde el navegador
 * del usuario (clic en el enlace que genera el plugin de WP), así que respondemos
 * con redirect 302 — igual que OIDC/SAML:
 *   - OK    → ${WEB}/auth/callback?accessToken=...&refreshToken=...
 *   - Error → ${WEB}/auth/error?reason=<code>
 *
 * Montado bajo el prefijo global /api/v1 → /api/v1/modules/wp-sso/*
 * (coincide con apiNamespace del manifest de mod.wp-sso).
 */
@ApiTags('Modules · WP-SSO')
@Controller('modules/wp-sso')
export class WpSsoController {
  constructor(private readonly wpSso: WpSsoService) {}

  @Get('status')
  @Public()
  @ApiOperation({
    summary: 'Indica si WP-SSO está configurado en esta instancia (sin exponer secretos).',
  })
  status() {
    return { configured: this.wpSso.isConfigured() };
  }

  @Get('callback')
  @Public()
  @ApiOperation({
    summary:
      'Callback SSO: recibe el token firmado por WordPress (?token=), lo verifica, resuelve/crea el usuario y redirige al frontend con la sesión.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect a /auth/callback (OK) o /auth/error (fallo).',
  })
  async callback(
    @Query('token') token: string | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: false }) res: FastifyReply,
  ): Promise<void> {
    const base = resolveWebBaseUrl(req);
    try {
      const result = await this.wpSso.exchange(token ?? '');
      const url = new URL(`${base}/auth/callback`);
      url.searchParams.set('accessToken', result.tokens.accessToken);
      url.searchParams.set('refreshToken', result.tokens.refreshToken);
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
