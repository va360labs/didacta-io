/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * OidcController — endpoints PÚBLICOS del 8º piloto License SDK
 * (`feat:sso.oidc`). Estos NO van gateados por capability porque:
 *
 *   - El navegador del usuario los consume directo durante el flow OIDC.
 *   - La protección efectiva está en `service.startFlow()`: si el tenant no
 *     tiene config OIDC habilitada → 404. Si la capability no está licenciada
 *     a nivel tenant, simplemente el admin no puede crear / habilitar la config
 *     (admin gate vive en /admin/sso/oidc/config con @RequiresCapability).
 *
 * URLs (bajo prefijo global /api/v1):
 *   GET /api/v1/auth/oidc/:tenantSlug/start  → 302 al IdP.
 *   GET /api/v1/auth/oidc/callback           → 302 al frontend con tokens.
 *
 * Comportamiento del callback:
 *   - Si todo OK → redirect 302 a `${WEB_PUBLIC_URL}/auth/callback?accessToken=...&refreshToken=...`.
 *     El frontend lee los tokens del query string y los guarda en localStorage
 *     (igual que el flow password-based devuelve tokens en el body).
 *   - Si error → redirect 302 a `${WEB_PUBLIC_URL}/auth/error?reason=...`.
 *     Razones: state_invalid, idp_error, user_not_provisioned, email_not_allowed,
 *     idp_unreachable, internal.
 *
 * Por qué redirect 302 con query params (y no JSON 200):
 *   El callback OIDC SIEMPRE llega como GET desde el navegador del usuario
 *   tras el redirect del IdP — no hay XHR. Devolver JSON 200 dejaría al
 *   usuario en una pantalla con texto crudo. Redirigir al frontend es el
 *   patrón estándar (NextAuth, Auth0, Okta SDK, etc.).
 */

import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
  HttpException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { OidcService } from './oidc.service';

const DEFAULT_WEB_BASE = 'http://localhost:3000';

function webBaseUrl(): string {
  const v = process.env['WEB_PUBLIC_URL'] ?? process.env['NEXTAUTH_URL'] ?? DEFAULT_WEB_BASE;
  return v.replace(/\/+$/, '');
}

@ApiTags('Auth · OIDC')
@Controller('auth/oidc')
export class OidcController {
  private readonly logger = new Logger(OidcController.name);

  constructor(private readonly oidc: OidcService) {}

  /**
   * Endpoint público mínimo para que el form de signin sepa si el tenant tiene
   * SSO habilitado y debe mostrar el botón "Iniciar sesión con SSO". NO expone
   * configuración (issuer / clientId / secret) — sólo `{ enabled: boolean }`.
   *
   * Si el tenant no existe o no tiene config OIDC → `{ enabled: false }` (no
   * 404 — el cliente sólo necesita saber si pintar el botón).
   */
  @Get(':tenantSlug/status')
  @ApiOperation({
    summary:
      'Devuelve `{ enabled: boolean }` — si el tenant tiene SSO OIDC habilitado. ' +
      'No expone configuración. Lo usa el form de signin para decidir si mostrar ' +
      'el botón de SSO.',
  })
  @ApiResponse({ status: 200 })
  async status(@Param('tenantSlug') tenantSlug: string): Promise<{ enabled: boolean }> {
    const enabled = await this.oidc.isEnabledForTenantSlug(tenantSlug);
    return { enabled };
  }

  /**
   * Inicia el flow OIDC para el tenant `:tenantSlug`. Genera state+nonce+PKCE
   * y redirige al usuario a la authorization URL del IdP.
   */
  @Get(':tenantSlug/start')
  @ApiOperation({
    summary:
      'Inicia el flow OIDC: genera state+nonce+PKCE, redirige al IdP. Usa la ' +
      'config OIDC del tenant. Si no existe / no está habilitada → 404.',
  })
  @ApiResponse({ status: 302, description: 'Redirect al authorization endpoint del IdP.' })
  @ApiResponse({ status: 404, description: 'Tenant no encontrado o sin config OIDC habilitada.' })
  @ApiResponse({ status: 503, description: 'IdP no responde al discovery.' })
  async start(
    @Param('tenantSlug') tenantSlug: string,
    @Res({ passthrough: false }) res: FastifyReply,
  ): Promise<void> {
    const flow = await this.oidc.startFlow(tenantSlug);
    res.status(HttpStatus.FOUND).redirect(flow.authorizationUrl);
  }

  /**
   * Recibe el callback del IdP tras el login del usuario. Verifica state +
   * id_token, upserta user si auto-provision habilitado, emite tokens internos
   * y redirige al frontend.
   */
  @Get('callback')
  @ApiOperation({
    summary:
      'Callback OIDC. Verifica state + id_token, autoriza el email, upserta el ' +
      'user si auto-provision habilitado, emite tokens internos y redirige al ' +
      'frontend con accessToken/refreshToken en el query string.',
  })
  @ApiResponse({ status: 302, description: 'Redirect a /auth/callback (success) o /auth/error (failure).' })
  async callback(
    @Query('state') state: string | undefined,
    @Query('code') code: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res({ passthrough: false }) res: FastifyReply,
    @Req() _req: unknown,
  ): Promise<void> {
    const base = webBaseUrl();
    try {
      const result = await this.oidc.handleCallback({
        state,
        code,
        error,
        errorDescription,
      });
      const url = new URL(`${base}/auth/callback`);
      url.searchParams.set('accessToken', result.tokens.accessToken);
      url.searchParams.set('refreshToken', result.tokens.refreshToken);
      url.searchParams.set('expiresIn', String(result.tokens.expiresIn));
      url.searchParams.set('userId', result.user.id);
      url.searchParams.set('email', result.user.email);
      if (result.user.name) url.searchParams.set('name', result.user.name);
      url.searchParams.set('tenantId', result.user.tenantId);
      url.searchParams.set('tenantSlug', result.user.tenantSlug);
      url.searchParams.set('roles', result.user.roles.join(','));
      // SSO ya implica MFA en el IdP; el cliente lo refleja en StoredSession
      // como mfaEnabled=true para que la UI no proponga setup de MFA local.
      url.searchParams.set('mfaEnabled', 'true');
      res.status(HttpStatus.FOUND).redirect(url.toString());
      return;
    } catch (err: unknown) {
      const reason = mapErrorToReason(err);
      this.logger.warn(`OIDC callback rechazado: ${reason}`);
      const url = new URL(`${base}/auth/error`);
      url.searchParams.set('reason', reason);
      res.status(HttpStatus.FOUND).redirect(url.toString());
      return;
    }
  }
}

/**
 * Mapea exceptions del service a códigos cortos consumibles por el frontend.
 * El frontend muestra mensajes user-friendly según `reason`.
 */
function mapErrorToReason(err: unknown): string {
  if (err instanceof BadRequestException) return 'bad_request';
  if (err instanceof UnauthorizedException) {
    const body = (err.getResponse() as { message?: string }).message ?? '';
    if (body.includes('State desconocido')) return 'state_invalid';
    if (body.includes('State expirado')) return 'state_expired';
    if (body.includes('IdP devolvió error')) return 'idp_error';
    if (body.includes('iss del id_token')) return 'iss_mismatch';
    if (body.includes('aud del id_token')) return 'aud_mismatch';
    if (body.includes('nonce del id_token')) return 'nonce_mismatch';
    if (body.includes('email')) return 'email_not_allowed';
    if (body.includes('No tenés cuenta')) return 'user_not_provisioned';
    if (body.includes('config OIDC')) return 'config_changed';
    if (body.includes('cuenta no está activa')) return 'user_inactive';
    return 'unauthorized';
  }
  if (err instanceof NotFoundException) return 'tenant_not_configured';
  if (err instanceof ServiceUnavailableException) return 'idp_unreachable';
  if (err instanceof HttpException) return 'http_error';
  return 'internal';
}
