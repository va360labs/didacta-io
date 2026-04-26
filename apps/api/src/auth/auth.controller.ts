import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
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
  ) {}

  @Post('signup')
  @ApiOperation({ summary: 'Registrar un usuario en un tenant existente' })
  async signup(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(signupSchema)) dto: SignupDto,
  ) {
    return this.auth.signup(dto, extractClientContext(req));
  }

  @Post('signin')
  @ApiOperation({ summary: 'Iniciar sesión con email + password' })
  async signin(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(signinSchema)) dto: SigninDto,
  ) {
    return this.auth.signin(dto, extractClientContext(req));
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
    // Fire-and-forget desde el punto de vista del response, pero esperamos
    // a que el email se envíe (mismo timing para ambos casos = anti timing attack).
    await this.passwordReset.requestAndSendEmail(
      dto.tenantSlug,
      dto.email,
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
}
