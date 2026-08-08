/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  BadRequestException,
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
import {
  otpRequestSchema,
  otpVerifySchema,
  registerSchema,
  signTicket,
  telegramAuthSchema,
  verifyTicket,
  type EffectiveRegistrationPolicy,
  type OtpRequestDto,
  type OtpVerifyDto,
  type RegisterDto,
  type TelegramAuthDto,
  type TelegramMembership,
  type TelegramTicketClaims,
  type VerificationTokenClaims,
} from '@didacta/mod-member-registration';
import { extractClientContext } from '../../auth/client-context';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { runAsTenant, runSanctionedGlobalAccess } from '../../tenancy/tenant-context.storage';
import { TenantResolverService } from '../../tenancy/tenant-resolver.service';
import { EmailVerificationService } from './email-verification.service';
import { MemberDecisionService } from './member-decision.service';
import { MemberRegistrationSettingsService } from './member-registration-settings.service';
import { MemberRegistrationService } from './member-registration.service';
import { TelegramService } from './telegram.service';

// ============================================================================
// Controller PÚBLICO del flujo de inscripción de miembros con VERIFICADORES
// COMPONIBLES por tenant (telegram y/u OTP por email, o registro libre) +
// validación manual. SIN guards: igual que AuthController, las rutas son
// anónimas, el tenant se resuelve por Host (resolveByHost) y se pasa EXPLÍCITO
// a los services. Los pasos del flujo se encadenan con tickets firmados (HMAC
// con AUTH_SECRET) en vez de estado en BD. Qué verificadores se exigen lo
// decide la política del tenant (MemberRegistrationSettingsService).
//
// F3 (migración coordinada): estas rutas bajo /modules/member-registration son
// las ÚNICAS del flujo — las legacy /inscripcion/* se retiraron del producto.
// ============================================================================

@ApiTags('Inscripción de miembros')
@Controller('modules/member-registration')
export class MemberRegistrationPublicController {
  constructor(
    private readonly telegram: TelegramService,
    private readonly emailVerification: EmailVerificationService,
    private readonly registration: MemberRegistrationService,
    private readonly decision: MemberDecisionService,
    private readonly settings: MemberRegistrationSettingsService,
    private readonly tenantResolver: TenantResolverService,
  ) {}

  /**
   * Secreto de firma de tickets. Compartido con `signed-ticket` del paquete.
   * Si falta, el flujo no puede operar de forma segura → se lanza en el método
   * que lo use (no en el constructor, para no tumbar el arranque del módulo en
   * entornos donde estas rutas no se ejercitan).
   */
  private requireAuthSecret(): string {
    const secret = process.env['AUTH_SECRET']?.trim();
    if (!secret) {
      throw new ServiceUnavailableException({
        message: 'El flujo de inscripción no está configurado (falta AUTH_SECRET).',
        code: 'MEMBER_REG_NOT_CONFIGURED',
      });
    }
    return secret;
  }

  /**
   * Política efectiva del tenant. `configured` (habilitado Y operativo) es la
   * condición de disponibilidad de TODO el flujo — fail-closed si un
   * verificador exigido no puede ejercitarse (p.ej. telegram sin bot).
   */
  private async requirePolicy(tenantId: string): Promise<EffectiveRegistrationPolicy> {
    const policy = await this.settings.resolveEffectivePolicy(tenantId);
    if (!policy.enabled || !policy.operational) {
      throw new ServiceUnavailableException({
        message: 'La inscripción no está disponible en esta comunidad.',
        code: 'MEMBER_REG_UNAVAILABLE',
      });
    }
    return policy;
  }

  @Get('config')
  @ApiOperation({
    summary:
      'Configuración pública del flujo para este tenant: si está disponible, qué verificadores exige (pasos del wizard) y el bot del Login Widget si aplica.',
  })
  async config(@Req() req: FastifyRequest) {
    const tenantId = await this.resolveTenantId(req);
    // RLS F2: rutas anónimas sin middleware de tenant — tras resolver por Host,
    // el cuerpo corre bajo el ALS del tenant (la extensión escopa cada query).
    return runAsTenant(tenantId, async () => {
      const policy = await this.settings.resolveEffectivePolicy(tenantId);
      return {
        configured: policy.enabled && policy.operational,
        verifiers: policy.verifiers,
        botUsername: policy.botUsername,
      };
    });
  }

  @Post('telegram/verify')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Verificador `telegram`: valida la firma del Telegram Login Widget, comprueba si el usuario está en el grupo y devuelve un ticket de corta vida.',
  })
  async telegramVerify(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(telegramAuthSchema)) dto: TelegramAuthDto,
  ) {
    const secret = this.requireAuthSecret();
    const tenantId = await this.resolveTenantId(req);
    return runAsTenant(tenantId, async () => {
      const policy = await this.requirePolicy(tenantId);
      if (!policy.verifiers.includes('telegram')) {
        throw new ServiceUnavailableException({
          message: 'Esta comunidad no verifica por Telegram su inscripción.',
          code: 'MEMBER_REG_TELEGRAM_NOT_ENABLED',
        });
      }
      // Operativo garantizado por requirePolicy → la config del bot existe.
      const telegramConfig = await this.settings.resolveTelegram(tenantId);
      if (!telegramConfig) {
        throw new ServiceUnavailableException({
          message: 'El acceso por Telegram no está configurado.',
          code: 'MEMBER_REG_TELEGRAM_NOT_CONFIGURED',
        });
      }

      if (!this.telegram.verifyLoginHash(telegramConfig, dto)) {
        throw new UnauthorizedException({
          message: 'Firma de Telegram inválida.',
          code: 'MEMBER_REG_TELEGRAM_SIGNATURE_INVALID',
        });
      }

      const inGroup = await this.telegram.getChatMember(telegramConfig, dto.id);
      const ticket = signTicket({ telegramId: dto.id, inGroup, purpose: 'telegram' }, secret, 900);
      return { ok: true, inGroup, ticket };
    });
  }

  @Post('otp/request')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Verificador `otp` (a): solicita un código al email indicado. Exige el ticket de Telegram solo si la política del tenant incluye ese verificador.',
  })
  async otpRequest(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(otpRequestSchema)) dto: OtpRequestDto,
  ) {
    const secret = this.requireAuthSecret();
    const tenantId = await this.resolveTenantId(req);
    return runAsTenant(tenantId, async () => {
      const policy = await this.requirePolicy(tenantId);
      if (!policy.verifiers.includes('otp')) {
        throw new ServiceUnavailableException({
          message: 'Esta comunidad no verifica por email su inscripción.',
          code: 'MEMBER_REG_OTP_NOT_ENABLED',
        });
      }
      this.requireTelegramClaims(policy, secret, dto.ticket);

      const expiresInSeconds = await this.emailVerification.requestCode(
        tenantId,
        dto.email,
        extractClientContext(req),
      );
      return { ok: true, expiresInSeconds };
    });
  }

  @Post('otp/verify')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Verificador `otp` (b): verifica el código y devuelve un verificationToken que autoriza el registro.',
  })
  async otpVerify(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(otpVerifySchema)) dto: OtpVerifyDto,
  ) {
    const secret = this.requireAuthSecret();
    const tenantId = await this.resolveTenantId(req);
    return runAsTenant(tenantId, async () => {
      const policy = await this.requirePolicy(tenantId);
      if (!policy.verifiers.includes('otp')) {
        throw new ServiceUnavailableException({
          message: 'Esta comunidad no verifica por email su inscripción.',
          code: 'MEMBER_REG_OTP_NOT_ENABLED',
        });
      }
      const telegramClaims = this.requireTelegramClaims(policy, secret, dto.ticket);

      const ok = await this.emailVerification.verifyCode(
        tenantId,
        dto.email,
        dto.code,
        extractClientContext(req),
      );
      if (!ok) {
        throw new UnauthorizedException({
          message: 'Código inválido o expirado.',
          code: 'MEMBER_REG_OTP_INVALID',
        });
      }

      const verificationToken = signTicket(
        {
          telegramId: telegramClaims?.telegramId ?? null,
          inGroup: telegramClaims?.inGroup ?? 'unknown',
          email: dto.email,
          purpose: 'member-register',
        },
        secret,
        1800,
      );
      return { ok: true, verificationToken };
    });
  }

  @Post('register')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Paso final: crea la inscripción (usuario PENDING) con la evidencia que exige la política del tenant y dispara el email de validación manual al aprobador.',
  })
  async register(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto,
  ) {
    const secret = this.requireAuthSecret();
    const tenantId = await this.resolveTenantId(req);
    return runAsTenant(tenantId, async () => {
      const policy = await this.requirePolicy(tenantId);

      // Evidencia según la política: cada verificador exigido debe venir probado.
      let email: string;
      let telegramId: string | null = null;
      let inGroup: TelegramMembership = 'unknown';

      if (policy.verifiers.includes('otp')) {
        // El verificationToken del OTP es la evidencia final (arrastra la de
        // Telegram si ese verificador también estaba exigido).
        if (!dto.verificationToken) {
          throw new UnauthorizedException({
            message: 'Token de verificación inválido o expirado.',
            code: 'MEMBER_REG_VERIFICATION_TOKEN_INVALID',
          });
        }
        const claims = verifyTicket<VerificationTokenClaims>(dto.verificationToken, secret);
        if (!claims || claims.purpose !== 'member-register') {
          throw new UnauthorizedException({
            message: 'Token de verificación inválido o expirado.',
            code: 'MEMBER_REG_VERIFICATION_TOKEN_INVALID',
          });
        }
        if (policy.verifiers.includes('telegram') && !claims.telegramId) {
          throw new UnauthorizedException({
            message: 'Falta la verificación de Telegram.',
            code: 'MEMBER_REG_TELEGRAM_VERIFICATION_MISSING',
          });
        }
        email = claims.email;
        telegramId = claims.telegramId ?? null;
        inGroup = claims.inGroup ?? 'unknown';
      } else if (policy.verifiers.includes('telegram')) {
        // Solo Telegram: el ticket del widget es la evidencia; el email viene
        // del formulario (sin verificar — la aprobación manual sigue delante).
        const claims = dto.ticket ? verifyTicket<TelegramTicketClaims>(dto.ticket, secret) : null;
        if (!claims || claims.purpose !== 'telegram') {
          throw new UnauthorizedException({
            message: 'Ticket de Telegram inválido o expirado.',
            code: 'MEMBER_REG_TELEGRAM_TICKET_INVALID',
          });
        }
        email = this.requireEmail(dto);
        telegramId = claims.telegramId;
        inGroup = claims.inGroup;
      } else {
        // Registro libre: sin verificadores; el gate es la aprobación manual.
        email = this.requireEmail(dto);
      }

      // Base del API para los enlaces de decisión (aprobar/rechazar) del email,
      // que apuntan de vuelta a este controller (`GET .../decision`).
      const apiBase = await this.resolveApiBaseUrl(tenantId, req);
      await this.registration.createPending(
        tenantId,
        {
          name: dto.name,
          email,
          password: dto.password,
          bio: dto.bio,
          telegramId,
          inGroup,
        },
        apiBase,
        extractClientContext(req),
      );
      return { ok: true, status: 'PENDING' };
    });
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
    // El token de decisión es OPACO (aleatorio, solo su hash vive en BD — no es
    // un ticket HMAC con claims): el tenant se conoce recién tras el lookup
    // interno del service, así que la llamada va sancionada completa.
    const result = await runSanctionedGlobalAccess(() =>
      this.decision.decide(token, extractClientContext(req)),
    );
    // `decide()` devuelve el tenantId de la fila (null solo si el token no
    // existe) — con eso, la base prefiere el dominio primario del tenant
    // sobre el Host de este request.
    const web = (await this.tenantResolver.resolveTenantWebBaseUrl(result.tenantId, req)).replace(
      /\/$/,
      '',
    );
    void res.status(302).redirect(`${web}/inscripcion-miembros/decision?outcome=${result.outcome}`);
  }

  // -------------------- helpers --------------------

  /**
   * Si la política exige `telegram`, valida el ticket del widget y devuelve sus
   * claims; si no lo exige, devuelve null e ignora cualquier ticket recibido
   * (el desacople OTP↔Telegram vive exactamente aquí).
   */
  private requireTelegramClaims(
    policy: EffectiveRegistrationPolicy,
    secret: string,
    ticket: string | undefined,
  ): TelegramTicketClaims | null {
    if (!policy.verifiers.includes('telegram')) return null;
    const claims = ticket ? verifyTicket<TelegramTicketClaims>(ticket, secret) : null;
    if (!claims || claims.purpose !== 'telegram') {
      throw new UnauthorizedException({
        message: 'Ticket de Telegram inválido o expirado.',
        code: 'MEMBER_REG_TELEGRAM_TICKET_INVALID',
      });
    }
    return claims;
  }

  /** Email del formulario (solo en políticas sin OTP, donde no viene probado). */
  private requireEmail(dto: RegisterDto): string {
    const email = dto.email?.trim().toLowerCase();
    if (!email) {
      throw new BadRequestException({
        message: 'Falta el email de la solicitud.',
        code: 'MEMBER_REG_EMAIL_MISSING',
      });
    }
    return email;
  }

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
      throw new NotFoundException({
        message: 'Comunidad no encontrada para este dominio.',
        code: 'MEMBER_REG_TENANT_NOT_FOUND',
      });
    }
    return tenant.id;
  }

  /**
   * Base pública del API para construir los enlaces de decisión del email.
   * Reusa la misma cascada que `resolveTenantWebBaseUrl` (env → dominio
   * primario del tenant → X-Forwarded-* → host del request): en el setup de
   * Didacta (Traefik, un host por tenant) la API y el web comparten dominio
   * bajo el prefijo `/api/v1`.
   */
  private async resolveApiBaseUrl(tenantId: string, req: FastifyRequest): Promise<string> {
    return this.tenantResolver.resolveTenantWebBaseUrl(tenantId, req);
  }
}
