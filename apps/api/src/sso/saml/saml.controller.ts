/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * SamlController — endpoints PÚBLICOS del 9º piloto License SDK
 * (`feat:sso.saml`). NO van gateados por capability porque:
 *
 *   - El navegador del usuario los consume directo durante el flow SAML.
 *   - La protección efectiva está en `service.startFlow()`: si el tenant no
 *     tiene config SAML habilitada → 404. La capability se exige a nivel ADMIN
 *     (en /admin/sso/saml/config con @RequiresCapability), no en los endpoints
 *     públicos del flow.
 *
 * URLs (bajo prefijo global /api/v1):
 *   GET  /api/v1/auth/saml/:tenantSlug/status    → { enabled: boolean }.
 *   GET  /api/v1/auth/saml/:tenantSlug/login     → 302 al IdP.
 *   POST /api/v1/auth/saml/:tenantSlug/acs       → 302 al frontend con tokens.
 *   GET  /api/v1/auth/saml/:tenantSlug/metadata  → SP metadata XML.
 *
 * Comportamiento del ACS (igual que OIDC callback):
 *   - Si todo OK → redirect 302 a `${WEB_PUBLIC_URL}/auth/callback?accessToken=...`.
 *   - Si error → redirect 302 a `${WEB_PUBLIC_URL}/auth/error?reason=...`.
 *     Razones: state_invalid, idp_error, user_not_provisioned, email_not_allowed,
 *     internal.
 *
 * El ACS recibe `Content-Type: application/x-www-form-urlencoded` con campos
 * `SAMLResponse` (b64) y `RelayState`. El parser está registrado en main.ts.
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Res,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { SamlService } from './saml.service';

const DEFAULT_WEB_BASE = 'http://localhost:3000';

function webBaseUrl(): string {
  const v = process.env['WEB_PUBLIC_URL'] ?? process.env['NEXTAUTH_URL'] ?? DEFAULT_WEB_BASE;
  return v.replace(/\/+$/, '');
}

@ApiTags('Auth · SAML')
@Controller('auth/saml')
export class SamlController {
  private readonly logger = new Logger(SamlController.name);

  constructor(private readonly saml: SamlService) {}

  @Get(':tenantSlug/status')
  @ApiOperation({
    summary:
      'Devuelve `{ enabled: boolean }` — si el tenant tiene SSO SAML habilitado. ' +
      'Lo usa el form de signin para decidir si mostrar el botón.',
  })
  @ApiResponse({ status: 200 })
  async status(@Param('tenantSlug') tenantSlug: string): Promise<{ enabled: boolean }> {
    const enabled = await this.saml.isEnabledForTenantSlug(tenantSlug);
    return { enabled };
  }

  @Get(':tenantSlug/login')
  @ApiOperation({
    summary:
      'Inicia el flow SAML: genera AuthnRequest + RelayState, redirige al IdP. ' +
      'Si el tenant no existe / no está habilitado → 404.',
  })
  @ApiResponse({ status: 302, description: 'Redirect al SSO endpoint del IdP.' })
  @ApiResponse({ status: 404, description: 'Tenant no encontrado o sin config SAML habilitada.' })
  @ApiResponse({ status: 503, description: 'Generación del AuthnRequest falló.' })
  async login(
    @Param('tenantSlug') tenantSlug: string,
    @Res({ passthrough: false }) res: FastifyReply,
  ): Promise<void> {
    const flow = await this.saml.startFlow(tenantSlug);
    res.status(HttpStatus.FOUND).redirect(flow.authorizationUrl);
  }

  @Post(':tenantSlug/acs')
  @HttpCode(HttpStatus.FOUND)
  @ApiOperation({
    summary:
      'Assertion Consumer Service. Recibe SAMLResponse + RelayState (POST ' +
      'application/x-www-form-urlencoded), valida firma y attributes, autoriza ' +
      'email, upserta user si auto-provision, emite tokens internos y redirige ' +
      'al frontend con accessToken/refreshToken en query string.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect a /auth/callback (success) o /auth/error (failure).',
  })
  async acs(
    @Param('tenantSlug') _tenantSlug: string,
    @Body() body: { SAMLResponse?: string; RelayState?: string },
    @Res({ passthrough: false }) res: FastifyReply,
  ): Promise<void> {
    const base = webBaseUrl();
    try {
      const result = await this.saml.handleAcs({
        samlResponse: body?.SAMLResponse,
        relayState: body?.RelayState,
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
      url.searchParams.set('mfaEnabled', 'true');
      res.status(HttpStatus.FOUND).redirect(url.toString());
      return;
    } catch (err: unknown) {
      const reason = mapErrorToReason(err);
      this.logger.warn(`SAML ACS rechazado: ${reason}`);
      const url = new URL(`${base}/auth/error`);
      url.searchParams.set('reason', reason);
      res.status(HttpStatus.FOUND).redirect(url.toString());
      return;
    }
  }

  @Get(':tenantSlug/metadata')
  @ApiOperation({
    summary:
      'Devuelve el SP metadata XML del tenant. Algunos IdPs (Azure AD, Okta) ' +
      'permiten importar metadata por URL en lugar de configurar EntityID + ' +
      'ACS URL a mano.',
  })
  @ApiResponse({
    status: 200,
    description: 'Application/xml con metadata SAML 2.0.',
  })
  async metadata(
    @Param('tenantSlug') tenantSlug: string,
    @Res({ passthrough: false }) res: FastifyReply,
  ): Promise<void> {
    const xml = await this.saml.getSpMetadataXml(tenantSlug);
    res
      .header('Content-Type', 'application/xml; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(xml);
  }
}

function mapErrorToReason(err: unknown): string {
  if (err instanceof BadRequestException) return 'bad_request';
  if (err instanceof UnauthorizedException) {
    const body = (err.getResponse() as { message?: string }).message ?? '';
    if (body.includes('RelayState desconocido')) return 'state_invalid';
    if (body.includes('RelayState expirado')) return 'state_expired';
    if (body.includes('Issuer del SAMLResponse')) return 'issuer_mismatch';
    if (body.includes('SAMLResponse inválido')) return 'idp_error';
    if (body.includes('email no pertenece') || body.includes('email')) return 'email_not_allowed';
    if (body.includes('No tenés cuenta')) return 'user_not_provisioned';
    if (body.includes('config SAML')) return 'config_changed';
    if (body.includes('cuenta no está activa')) return 'user_inactive';
    return 'unauthorized';
  }
  if (err instanceof ForbiddenException) return 'forbidden';
  if (err instanceof NotFoundException) return 'tenant_not_configured';
  if (err instanceof ServiceUnavailableException) return 'idp_unreachable';
  if (err instanceof HttpException) return 'http_error';
  return 'internal';
}
