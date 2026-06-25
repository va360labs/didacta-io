import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { extractClientContext } from '../auth/client-context';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { resolveWebBaseUrl } from '../common/resolve-web-base-url';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';
import {
  otpRequestSchema,
  otpVerifySchema,
  registerSchema,
  telegramAuthSchema,
  type OtpRequestDto,
  type OtpVerifyDto,
  type RegisterDto,
  type TelegramAuthDto,
  type TelegramTicketClaims,
  type VerificationTokenClaims,
} from './inscripcion.dto';
import { EmailVerificationService } from './email-verification.service';
import { MemberDecisionService } from './member-decision.service';
import { MemberRegistrationService } from './member-registration.service';
import { signTicket, verifyTicket } from './signed-ticket';
import { TelegramService } from './telegram.service';

// ============================================================================
// Controller PÚBLICO del flujo de inscripción de miembros (gate Telegram + OTP
// por email + validación manual). SIN guards: igual que AuthController, las
// rutas son anónimas y el tenant se resuelve por Host (resolveByHost) y se pasa
// EXPLÍCITO a los services. Los pasos del flujo se encadenan con tickets
// firmados (HMAC con AUTH_SECRET) en vez de estado en BD.
// ============================================================================

@ApiTags('Inscripción de miembros')
@Controller('inscripcion')
export class InscripcionController {
  constructor(
    private readonly telegram: TelegramService,
    private readonly emailVerification: EmailVerificationService,
    private readonly registration: MemberRegistrationService,
    private readonly decision: MemberDecisionService,
    private readonly tenantResolver: TenantResolverService,
  ) {}

  /**
   * Secreto de firma de tickets. Compartido con `signed-ticket.ts`. Si falta,
   * el flujo no puede operar de forma segura → se lanza en el método que lo use
   * (no en el constructor, para no tumbar el arranque del módulo en entornos
   * donde estas rutas no se ejercitan).
   */
  private requireAuthSecret(): string {
    const secret = process.env['AUTH_SECRET']?.trim();
    if (!secret) {
      throw new ServiceUnavailableException(
        'El flujo de inscripción no está configurado (falta AUTH_SECRET).',
      );
    }
    return secret;
  }

  @Get('config')
  @ApiOperation({
    summary:
      'Estado de configuración del gate de Telegram (si el widget de login está disponible y con qué bot).',
  })
  config() {
    return {
      configured: this.telegram.isConfigured(),
      botUsername: this.telegram.botUsername,
    };
  }

  @Post('telegram/verify')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Paso 1: verifica la firma del Telegram Login Widget, comprueba si el usuario está en el grupo y devuelve un ticket de corta vida.',
  })
  async telegramVerify(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(telegramAuthSchema)) dto: TelegramAuthDto,
  ) {
    if (!this.telegram.isConfigured()) {
      throw new ServiceUnavailableException('El acceso por Telegram no está configurado.');
    }
    const secret = this.requireAuthSecret();
    // Resolvemos el tenant por Host para validar que el dominio corresponde a
    // una comunidad existente antes de seguir.
    await this.resolveTenantId(req);

    if (!this.telegram.verifyLoginHash(dto)) {
      throw new UnauthorizedException('Firma de Telegram inválida.');
    }

    const inGroup = await this.telegram.getChatMember(dto.id);
    const ticket = signTicket({ telegramId: dto.id, inGroup, purpose: 'telegram' }, secret, 900);
    return { ok: true, inGroup, ticket };
  }

  @Post('otp/request')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Paso 1.5a: solicita un código OTP al email indicado (requiere el ticket de Telegram).',
  })
  async otpRequest(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(otpRequestSchema)) dto: OtpRequestDto,
  ) {
    const secret = this.requireAuthSecret();
    const tenantId = await this.resolveTenantId(req);

    const claims = verifyTicket<TelegramTicketClaims>(dto.ticket, secret);
    if (!claims || claims.purpose !== 'telegram') {
      throw new UnauthorizedException('Ticket de Telegram inválido o expirado.');
    }

    const expiresInSeconds = await this.emailVerification.requestCode(
      tenantId,
      dto.email,
      extractClientContext(req),
    );
    return { ok: true, expiresInSeconds };
  }

  @Post('otp/verify')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Paso 1.5b: verifica el código OTP y devuelve un verificationToken que autoriza el registro.',
  })
  async otpVerify(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(otpVerifySchema)) dto: OtpVerifyDto,
  ) {
    const secret = this.requireAuthSecret();
    const tenantId = await this.resolveTenantId(req);

    const claims = verifyTicket<TelegramTicketClaims>(dto.ticket, secret);
    if (!claims || claims.purpose !== 'telegram') {
      throw new UnauthorizedException('Ticket de Telegram inválido o expirado.');
    }

    const ok = await this.emailVerification.verifyCode(
      tenantId,
      dto.email,
      dto.code,
      extractClientContext(req),
    );
    if (!ok) {
      throw new UnauthorizedException('Código inválido o expirado.');
    }

    const verificationToken = signTicket(
      {
        telegramId: claims.telegramId,
        inGroup: claims.inGroup,
        email: dto.email,
        purpose: 'member-register',
      },
      secret,
      1800,
    );
    return { ok: true, verificationToken };
  }

  @Post('register')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Paso 2: crea la inscripción (usuario PENDING) y dispara el email de validación manual al operador.',
  })
  async register(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto,
  ) {
    const secret = this.requireAuthSecret();
    const tenantId = await this.resolveTenantId(req);

    const claims = verifyTicket<VerificationTokenClaims>(dto.verificationToken, secret);
    if (!claims || claims.purpose !== 'member-register') {
      throw new UnauthorizedException('Token de verificación inválido o expirado.');
    }

    // Base del API para los enlaces de decisión (aprobar/rechazar) del email,
    // que apuntan de vuelta a este controller (`GET /inscripcion/decision`).
    const apiBase = this.resolveApiBaseUrl(req);
    await this.registration.createPending(
      tenantId,
      {
        name: dto.name,
        email: claims.email,
        password: dto.password,
        bio: dto.bio,
        telegramId: claims.telegramId,
        inGroup: claims.inGroup,
      },
      apiBase,
      extractClientContext(req),
    );
    return { ok: true, status: 'PENDING' };
  }

  @Get('decision')
  @ApiOperation({
    summary:
      'Endpoint que abre el operador desde el email (aprobar/rechazar). Procesa el token y redirige al frontend.',
  })
  @ApiResponse({ status: 302, description: 'Redirect a la pantalla de resultado en el frontend.' })
  async decisionEndpoint(
    @Req() req: FastifyRequest,
    @Res({ passthrough: false }) res: FastifyReply,
  ): Promise<void> {
    const token = String((req.query as Record<string, unknown> | undefined)?.['token'] ?? '');
    const result = await this.decision.decide(token, extractClientContext(req));
    const web = (process.env['WEB_PUBLIC_URL']?.trim() || resolveWebBaseUrl(req)).replace(
      /\/$/,
      '',
    );
    void res.status(302).redirect(`${web}/inscripcion-miembros/decision?outcome=${result.outcome}`);
  }

  // -------------------- helpers --------------------

  /**
   * Resuelve el tenant a partir del Host del request. Lanza 404 si el dominio
   * no corresponde a ninguna comunidad. Las rutas son anónimas, así que el
   * tenant se infiere por dominio (igual que AuthController).
   */
  private async resolveTenantId(req: FastifyRequest): Promise<string> {
    const host = req.headers.host ?? req.headers['x-forwarded-host'];
    const hostStr = Array.isArray(host) ? host[0] : host;
    const tenant = await this.tenantResolver.resolveByHost(hostStr);
    if (!tenant) {
      throw new NotFoundException('Comunidad no encontrada para este dominio.');
    }
    return tenant.id;
  }

  /**
   * Base pública del API para construir los enlaces de decisión del email.
   * Reusa la misma cascada que `resolveWebBaseUrl` (env → X-Forwarded-* →
   * host del request): en el setup de Didacta (Traefik, un host por tenant) la
   * API y el web comparten dominio bajo el prefijo `/api/v1`.
   */
  private resolveApiBaseUrl(req: FastifyRequest): string {
    return resolveWebBaseUrl(req);
  }
}
