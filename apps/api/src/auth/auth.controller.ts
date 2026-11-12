/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Optional,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { SubscriptionGateService } from '../tenancy/subscription-gate.service';
import { runAsTenant } from '../tenancy/tenant-context.storage';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import { AuthService } from './auth.service';
import { extractClientContext } from './client-context';
import {
  forgotPasswordSchema,
  refreshSchema,
  resetPasswordSchema,
  signinSchema,
  signupSchema,
  type ForgotPasswordDto,
  type RefreshDto,
  type ResetPasswordDto,
  type SigninDto,
  type SignupDto,
} from './dto';
import { PasswordResetService } from './password-reset.service';
import { SigninContextService } from './signin-context.service';
import { ZodValidationPipe } from './zod-validation.pipe';
import { resolvePublicHost } from '../common/resolve-public-host';
import {
  resolveWebBaseUrl,
  resolveWebBaseUrlForAuthRedirect,
} from '../common/resolve-web-base-url';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly passwordReset: PasswordResetService,
    private readonly tenantResolver: TenantResolverService,
    private readonly signinContext: SigninContextService,
    @Optional() private readonly subscriptionGate?: SubscriptionGateService,
  ) {}

  /**
   * Devuelve el tenant resuelto a partir del Host header del request, o null
   * si el host no está mapeado. El frontend lo llama al cargar /signin para
   * decidir si esconde el campo "Organización" (caso normal en producción
   * con dominio configurado) o lo muestra (caso fallback dev / dominio sin
   * configurar).
   *
   * Devuelve además el material del panel de marca de las pantallas de acceso:
   * copy propio del tenant (mod.theming, null si no lo configuró) y dos cifras
   * REALES del tenant (miembros activos, cursos publicados). Cero datos de
   * cartón: si el tenant no tiene copy ni cifras, el web pinta su versión
   * genérica en vez de inventarlas.
   */
  @Get('tenant-context')
  @ApiOperation({
    summary:
      'Resuelve el tenant del request por Host header. Devuelve { tenant: { id, slug, name, logoUrl, headline, subheadline, stats, subscriptionGate } } o { tenant: null }. `subscriptionGate.state` es `LOCKED` si el aula está en pausa y `OPEN` en cualquier otro caso.',
  })
  async tenantContext(@Req() req: FastifyRequest) {
    const hostStr = resolvePublicHost(req);
    const tenant = await this.tenantResolver.resolveByHost(hostStr);
    if (!tenant) return { tenant: null, host: hostStr ?? null };
    // Puerta de suscripción, en su versión PÚBLICA: solo si el aula está en
    // pausa. Que una academia esté en prueba no es asunto de quien la visita
    // (la franja es solo para sus administradores, que la leen de
    // `/me/modules` junto con el enlace de pago).
    const gate = this.subscriptionGate ? await this.subscriptionGate.gateFor(tenant.id) : null;
    const subscriptionGate = { state: gate?.state === 'LOCKED' ? 'LOCKED' : 'OPEN' } as const;
    const webBaseUrl = await this.tenantResolver.resolveTenantWebBaseUrl(tenant.id, req);
    // Logo del tenant (mod.theming) para que las páginas anónimas (signin,
    // registro) muestren la marca del tenant en vez de "Didacta".
    // RLS F2: endpoint público — las lecturas van bajo el ALS del tenant.
    const [logoUrl, branding] = await runAsTenant(
      tenant.id,
      () =>
        Promise.all([
          this.passwordReset.resolveTenantLogoUrl(tenant.id, webBaseUrl),
          this.signinContext.get(tenant.id),
        ]),
      { traceLabel: 'tenant-context' },
    );
    return {
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        logoUrl,
        logoDisplayMode: branding.logoDisplayMode,
        headline: branding.headline,
        subheadline: branding.subheadline,
        brandHue: branding.brandHue,
        brandSaturation: branding.brandSaturation,
        stats: branding.stats,
        membershipPageActive: branding.membershipPageActive,
        subscriptionGate,
      },
      host: hostStr ?? null,
    };
  }

  @Post('signup')
  @ApiOperation({ summary: 'Registrar un usuario en un tenant' })
  async signup(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(signupSchema)) dto: SignupDto,
  ) {
    const resolvedTenantId = await this.resolveTenantIdFromHost(req);
    return this.auth.signup(dto, extractClientContext(req), resolvedTenantId);
  }

  @Post('signin')
  @ApiOperation({ summary: 'Iniciar sesión con email + password' })
  async signin(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(signinSchema)) dto: SigninDto,
  ) {
    const resolvedTenantId = await this.resolveTenantIdFromHost(req);
    return this.auth.signin(dto, extractClientContext(req), resolvedTenantId);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Renovar access token con un refresh token' })
  async refresh(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(refreshSchema)) dto: RefreshDto,
  ) {
    // El contexto va aquí para que la sesión registre desde dónde se renovó:
    // si el refresh abre una sesión nueva (token viejo sin `sid`), sin esto
    // la fila saldría sin IP ni dispositivo.
    const tokens = await this.auth.refresh(dto.refreshToken, extractClientContext(req));
    return { tokens };
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Solicitar email de reset de contraseña. Responde 200 siempre — no revela si el email existe (anti user enumeration).',
  })
  async forgotPassword(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(forgotPasswordSchema)) dto: ForgotPasswordDto,
  ) {
    const resolvedTenantId = await this.resolveTenantIdFromHost(req);
    await this.passwordReset.requestAndSendEmail(
      { email: dto.email, tenantSlug: dto.tenantSlug, resolvedTenantId },
      // La base del enlace se decide cuando ya se sabe en qué aula está la
      // cuenta, y con ella. Ver `resetLinkBase`.
      (accountTenantId) => this.resetLinkBase(accountTenantId, resolvedTenantId, req),
      extractClientContext(req),
    );
    return {
      ok: true,
      message:
        'Si el email existe en esta organización, te enviamos un enlace para restablecer tu contraseña. Revisa tu bandeja de entrada y la carpeta de spam.',
    };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirmar reset con el token recibido por email + nueva contraseña.' })
  async resetPassword(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(resetPasswordSchema)) dto: ResetPasswordDto,
  ) {
    await this.passwordReset.reset(dto.token, dto.newPassword, extractClientContext(req));
    return { ok: true, message: 'Tu contraseña fue actualizada. Ya puedes iniciar sesión.' };
  }

  // -------------------- helpers --------------------

  /**
   * Adónde apunta el enlace de «restablecer contraseña». Lleva un token que
   * abre la cuenta, así que la cabecera `Host` —que la pone quien llama— no
   * puede decidirlo.
   *
   * Antes se calculaba con el tenant del dominio de la petición, antes de
   * saber en qué aula estaba la cuenta. Con un dominio que no era de ningún
   * aula la cuenta se resolvía igual (por el `tenantSlug` del cuerpo o por el
   * correo) pero la base salía sin tenant: `WEB_PUBLIC_URL` y, sin ella, el
   * propio `Host`. Un enlace con el token de la víctima, en su buzón,
   * apuntando al dominio de un tercero.
   *
   * Orden:
   *  1. El dominio primario VERIFICADO del aula de la cuenta (sale de nuestra
   *     base, no de la petición).
   *  2. Si la petición llegó por un dominio verificado de ESA MISMA aula, lo de
   *     siempre: `WEB_PUBLIC_URL` y, si no, ese dominio (está en nuestra base).
   *  3. Si no, la variante endurecida: `WEB_PUBLIC_URL`, o el `Host` solo si
   *     está en `WEB_PUBLIC_ALLOWED_HOSTS`. Nunca un `Host` cualquiera.
   */
  private async resetLinkBase(
    accountTenantId: string,
    hostTenantId: string | undefined,
    req: FastifyRequest,
  ): Promise<string> {
    const primary = await this.tenantResolver.resolvePrimaryDomain(accountTenantId);
    if (primary || hostTenantId === accountTenantId) return resolveWebBaseUrl(req, primary);

    const base = resolveWebBaseUrlForAuthRedirect(req, null);
    if (!process.env['WEB_PUBLIC_URL']?.trim()) {
      this.logger.warn(
        `forgot-password: la petición llegó por un dominio que no es del aula ${accountTenantId}, que no tiene dominio primario ` +
          `verificado, y WEB_PUBLIC_URL no está definida. El enlace se ha enviado con base ${base}; el Host de la petición ` +
          `NO se usa para un enlace con token salvo que esté en WEB_PUBLIC_ALLOWED_HOSTS. Define WEB_PUBLIC_URL.`,
      );
    }
    return base;
  }

  private async resolveTenantIdFromHost(req: FastifyRequest): Promise<string | undefined> {
    const hostStr = resolvePublicHost(req);
    const tenant = await this.tenantResolver.resolveByHost(hostStr);
    return tenant?.id;
  }
}
