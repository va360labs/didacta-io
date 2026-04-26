import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
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
import { ZodValidationPipe } from './zod-validation.pipe';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly passwordReset: PasswordResetService,
    private readonly tenantResolver: TenantResolverService,
  ) {}

  /**
   * Devuelve el tenant resuelto a partir del Host header del request, o null
   * si el host no está mapeado. El frontend lo llama al cargar /signin para
   * decidir si esconde el campo "Organización" (caso normal en producción
   * con dominio configurado) o lo muestra (caso fallback dev / dominio sin
   * configurar).
   */
  @Get('tenant-context')
  @ApiOperation({
    summary:
      'Resuelve el tenant del request por Host header. Devuelve { tenant: { id, slug, name } } o { tenant: null }.',
  })
  async tenantContext(@Req() req: FastifyRequest) {
    const host = req.headers.host ?? req.headers['x-forwarded-host'];
    const hostStr = Array.isArray(host) ? host[0] : host;
    const tenant = await this.tenantResolver.resolveByHost(hostStr);
    return {
      tenant: tenant ? { id: tenant.id, slug: tenant.slug, name: tenant.name } : null,
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
  async refresh(@Body(new ZodValidationPipe(refreshSchema)) dto: RefreshDto) {
    const tokens = await this.auth.refresh(dto.refreshToken);
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
    const webBaseUrl = process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000';
    const resolvedTenantId = await this.resolveTenantIdFromHost(req);
    await this.passwordReset.requestAndSendEmail(
      { email: dto.email, tenantSlug: dto.tenantSlug, resolvedTenantId },
      webBaseUrl,
      extractClientContext(req),
    );
    return {
      ok: true,
      message:
        'Si el email existe en esta organización, te enviamos un enlace para restablecer tu contraseña. Revisá tu bandeja de entrada y la carpeta de spam.',
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
    return { ok: true, message: 'Tu contraseña fue actualizada. Ya podés iniciar sesión.' };
  }

  // -------------------- helpers --------------------

  private async resolveTenantIdFromHost(req: FastifyRequest): Promise<string | undefined> {
    const host = req.headers.host ?? req.headers['x-forwarded-host'];
    const hostStr = Array.isArray(host) ? host[0] : host;
    const tenant = await this.tenantResolver.resolveByHost(hostStr);
    return tenant?.id;
  }
}
