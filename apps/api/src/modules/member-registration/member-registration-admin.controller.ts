/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomBytes } from 'node:crypto';
import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MemberSubscriptionMatch, RenewalTemplate } from '@didacta/mod-payment-connections';
import { extractClientContext } from '../../auth/client-context';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import type { SessionClaims } from '../../auth/token.service';
import { resolveWebBaseUrl } from '../../common/resolve-web-base-url';
import { renewalEmailHtml } from '../../common/renewal-email-html';
import { resolveEmailBranding, type BrandingPrisma } from '../../common/branded-email';
import { ModuleRegistryService } from '../module-registry.service';
import { SmtpAdapterService } from '../smtp-adapter.service';
import { TenantSmtpResolverService } from '../tenant-smtp-resolver.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MemberDecisionService } from './member-decision.service';
import { MemberRegistrationService } from './member-registration.service';
import { MemberSubscriptionLookupService } from './member-subscription-lookup.service';

const decisionSchema = z.object({ action: z.enum(['approve', 'reject']) }).strict();
type DecisionDto = z.infer<typeof decisionSchema>;

const createManualSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email(),
    telegramId: z.string().trim().max(40).optional(),
    inGroup: z.enum(['true', 'false', 'unknown']).optional(),
    /** Email al que enviar SOLO la validación al aprobador (no se emaila al solicitante). */
    approverEmail: z.string().trim().email().optional(),
  })
  .strict();
type CreateManualDto = z.infer<typeof createManualSchema>;

/**
 * Re-consulta del lookup. Opcionalmente con un email DISTINTO al de registro, para
 * mapear la suscripción cuando el miembro se registró con un email pero pagó con otro.
 */
const rerunSchema = z.object({ email: z.string().trim().email().optional() }).strict();
type RerunDto = z.infer<typeof rerunSchema>;

/** Email de recordatorio de pago (asunto + cuerpo ya resueltos/editados por el admin). */
const renewalEmailSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(5000),
  })
  .strict();
type RenewalEmailDto = z.infer<typeof renewalEmailSchema>;

const uuidSchema = z.string().uuid();

/**
 * Un `:userId` malformado en la ruta produciría un P2023 de Prisma (columna
 * Uuid) que ningún filtro de dominio captura → 500. Mismo criterio que
 * mod.resources: un id que no es UUID es, simplemente, alguien que no existe.
 */
function ensureUuid(id: string): string {
  if (!uuidSchema.safeParse(id).success) {
    throw new NotFoundException('Solicitante no encontrado.');
  }
  return id;
}

/**
 * Panel ADMIN de solicitudes de inscripción (autenticado, distinto del controller
 * público del flujo). Lista las solicitudes PENDING con el estado de su lookup de
 * suscripción (consultado en TODAS las cuentas de pago conectadas) y permite
 * re-lanzar el lookup (p.ej. tras conectar una cuenta o si dio ERROR).
 */
const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

@ApiTags('Inscripción de miembros · Admin')
@ApiBearerAuth()
@Controller('modules/member-registration/admin')
@UseGuards(JwtAuthGuard)
export class MemberRegistrationAdminController {
  constructor(
    private readonly registration: MemberRegistrationService,
    private readonly lookup: MemberSubscriptionLookupService,
    private readonly decision: MemberDecisionService,
    private readonly registry: ModuleRegistryService,
    private readonly smtp: SmtpAdapterService,
    private readonly smtpResolver: TenantSmtpResolverService,
    private readonly prisma: PrismaService,
  ) {}

  private requireAdmin(user: SessionClaims | undefined): SessionClaims {
    if (!user) throw new UnauthorizedException();
    if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
      throw new ForbiddenException(
        'Solo administradores pueden ver las solicitudes de inscripción.',
      );
    }
    return user;
  }

  @Get('requests')
  @ApiOperation({
    summary: 'Lista las solicitudes de inscripción PENDING + su lookup de suscripción.',
  })
  async listRequests(@CurrentUser() rawUser: SessionClaims | undefined) {
    const user = this.requireAdmin(rawUser);
    const requests = await this.registration.listPendingRequests(user.tenantId);
    return { requests };
  }

  @Post('requests')
  @ApiOperation({
    summary:
      'Crea una solicitud de inscripción MANUAL (sin OTP): corre el lookup de suscripción en ' +
      'todas las cuentas conectadas y envía el email de validación SOLO al aprobador indicado ' +
      '(NO se emaila al solicitante). Para alta manual/onboarding y pruebas.',
  })
  async createManual(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Body(new ZodValidationPipe(createManualSchema)) dto: CreateManualDto,
    @Req() req: FastifyRequest,
  ) {
    const user = this.requireAdmin(rawUser);
    const ctx = extractClientContext(req);
    const webBaseUrl = resolveWebBaseUrl(req);
    const input = {
      name: dto.name,
      email: dto.email,
      // Contraseña aleatoria: el alta manual no la usa (el miembro queda PENDING
      // y, al aprobarse, entra por reset/SSO). Solo cumple el contrato del flujo.
      password: randomBytes(24).toString('base64url'),
      // Sin Telegram en el alta manual el perfil queda sin telegramId (antes
      // se usaba el sentinel 'manual'; los verificadores componibles lo hacen
      // innecesario y ensuciaba los datos).
      telegramId: dto.telegramId ?? null,
      inGroup: dto.inGroup ?? ('unknown' as const),
    };
    // skipAutoNotify: notificamos NOSOTROS de forma síncrona con el override del
    // aprobador (para devolver el resultado y dirigir el email a quien se indique).
    const { userId, created } = await this.registration.createPending(
      user.tenantId,
      input,
      webBaseUrl,
      ctx,
      { skipAutoNotify: true },
    );
    const { matches, failures, purchases } = await this.registration.lookupThenNotify(
      user.tenantId,
      userId,
      input,
      webBaseUrl,
      ctx,
      dto.approverEmail,
    );
    return {
      userId,
      created,
      matchCount: matches.length,
      matches,
      failures,
      purchaseCount: purchases.length,
      purchases,
      approverEmail: dto.approverEmail ?? null,
    };
  }

  @Post('requests/:userId/rerun')
  @ApiOperation({
    summary:
      'Re-lanza el lookup de suscripción del solicitante. Con `email` en el body, consulta ' +
      'por ese email (para mapear una suscripción registrada con otro email) y lo persiste.',
  })
  async rerun(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(rerunSchema)) body: RerunDto,
  ) {
    const user = this.requireAdmin(rawUser);
    ensureUuid(userId);
    const account = await this.registration.getUserEmail(user.tenantId, userId);
    if (!account) throw new NotFoundException('Solicitante no encontrado.');
    // Prioridad: email mapeado ahora → el que ya se usó antes (persiste el mapeo) → el de registro.
    const existing = await this.lookup.getForUser(user.tenantId, userId);
    const emailToUse = body.email ?? existing?.email ?? account;
    const result = await this.lookup.runAndStore(user.tenantId, userId, emailToUse);
    return { matches: result.matches, failures: result.failures, email: emailToUse };
  }

  @Post('requests/:userId/decision')
  @ApiOperation({
    summary:
      'Aprueba o rechaza una solicitud desde el panel (sin necesidad del link del email). ' +
      'Aprobar pone al usuario ACTIVE, asigna el grupo por defecto y le envía la bienvenida. ' +
      'La asignación de tier se hace aparte con PUT /modules/payment-connections/user-tiers/:userId.',
  })
  async decideRequest(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(decisionSchema)) dto: DecisionDto,
    @Req() req: FastifyRequest,
  ) {
    const user = this.requireAdmin(rawUser);
    ensureUuid(userId);
    const ctx = extractClientContext(req);
    const action = dto.action === 'approve' ? 'APPROVE' : 'REJECT';
    const result = await this.decision.decideByAdmin(user.tenantId, userId, action, ctx);
    if (result.outcome === 'invalid') {
      throw new NotFoundException('Solicitante no encontrado.');
    }
    return { outcome: result.outcome };
  }

  @Get('requests/:userId/renewal-context')
  @ApiOperation({
    summary:
      'Prepara el envío de un email a una solicitud: resuelve la plantilla del tenant y, ' +
      'si se pasa `subscriptionId` (suscripción detectada), el enlace de renovación de Stripe. ' +
      'Sin `subscriptionId` sirve para escribir a quien NO tiene suscripción detectada.',
  })
  async renewalContext(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Param('userId') userId: string,
    @Query('subscriptionId') subscriptionId: string | undefined,
  ): Promise<{ template: RenewalTemplate; renewalUrl: string | null }> {
    const user = this.requireAdmin(rawUser);
    ensureUuid(userId);
    const svc = this.registry.getPaymentConnectionsService();
    // Sin suscripción (subscriptionId ausente): no hay enlace de renovación, pero el
    // email sigue siendo enviable (el admin escribe el cuerpo, p.ej. con el link de pago).
    let renewalUrl: string | null = null;
    if (subscriptionId) {
      const match = await this.findLookupMatch(user.tenantId, userId, subscriptionId);
      // connectionId puede faltar en lookups antiguos (persistidos antes de incluirlo).
      renewalUrl = match.connectionId
        ? await svc.resolveRenewalUrlByRef(
            user.tenantId,
            match.connectionId,
            match.provider,
            match.subscriptionId,
          )
        : null;
    }
    const template = await svc.getRenewalTemplate(user.tenantId);
    return { template, renewalUrl };
  }

  @Post('requests/:userId/renewal-email')
  @ApiOperation({
    summary:
      'Envía el email de recordatorio de pago al email de la solicitud, vía el SMTP ' +
      'del tenant (asunto/cuerpo ya editados por el admin). No modifica la suscripción.',
  })
  async sendRenewalEmail(
    @CurrentUser() rawUser: SessionClaims | undefined,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(renewalEmailSchema)) dto: RenewalEmailDto,
  ): Promise<{ ok: boolean; to: string }> {
    const user = this.requireAdmin(rawUser);
    ensureUuid(userId);
    const to = (await this.registration.getUserEmail(user.tenantId, userId))?.trim();
    if (!to) throw new NotFoundException('Solicitante no encontrado o sin email.');
    const resolved = await this.smtpResolver.resolve(user.tenantId);
    if (!resolved) {
      throw new ConflictException(
        'El tenant no tiene SMTP configurado: no se puede enviar el recordatorio.',
      );
    }
    const branding = await resolveEmailBranding(
      this.prisma as unknown as BrandingPrisma,
      user.tenantId,
      process.env['WEB_PUBLIC_URL']?.trim() ?? '',
    );
    const result = await this.smtp.send(
      resolved.config,
      {
        to,
        subject: dto.subject,
        text: dto.body,
        html: renewalEmailHtml(dto.body, branding, dto.subject),
      },
      branding.tenantName,
    );
    if (!result.ok) {
      throw new ConflictException(`No se pudo enviar el email: ${result.error ?? 'error SMTP'}`);
    }
    return { ok: true, to };
  }

  /**
   * Localiza, dentro del lookup persistido de una solicitud, la suscripción detectada
   * con el `subscriptionId` indicado. 404 si la solicitud no tiene lookup o no contiene
   * esa suscripción (evita resolver enlaces de subs ajenas a la solicitud).
   */
  private async findLookupMatch(
    tenantId: string,
    userId: string,
    subscriptionId: string,
  ): Promise<MemberSubscriptionMatch> {
    const row = await this.lookup.getForUser(tenantId, userId);
    const results = (row?.results ?? []) as unknown as MemberSubscriptionMatch[];
    const match = results.find((m) => m.subscriptionId === subscriptionId);
    if (!match) {
      throw new NotFoundException('Suscripción no encontrada en el lookup de la solicitud.');
    }
    return match;
  }
}
