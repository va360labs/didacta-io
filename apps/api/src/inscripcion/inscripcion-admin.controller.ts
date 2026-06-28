import { randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractClientContext } from '../auth/client-context';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import type { SessionClaims } from '../auth/token.service';
import { resolveWebBaseUrl } from '../common/resolve-web-base-url';
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
 * Panel ADMIN de solicitudes de inscripción (autenticado, distinto del controller
 * público del flujo). Lista las solicitudes PENDING con el estado de su lookup de
 * suscripción (consultado en TODAS las cuentas de pago conectadas) y permite
 * re-lanzar el lookup (p.ej. tras conectar una cuenta o si dio ERROR).
 */
const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

@ApiTags('Inscripción de miembros · Admin')
@ApiBearerAuth()
@Controller('inscripcion-admin')
@UseGuards(JwtAuthGuard)
export class InscripcionAdminController {
  constructor(
    private readonly registration: MemberRegistrationService,
    private readonly lookup: MemberSubscriptionLookupService,
    private readonly decision: MemberDecisionService,
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
      telegramId: dto.telegramId ?? 'manual',
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
    const { matches, failures } = await this.registration.lookupThenNotify(
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
      approverEmail: dto.approverEmail ?? null,
    };
  }

  @Post('requests/:userId/rerun')
  @ApiOperation({
    summary: 'Re-lanza el lookup de suscripción de un solicitante en todas las cuentas conectadas.',
  })
  async rerun(@CurrentUser() rawUser: SessionClaims | undefined, @Param('userId') userId: string) {
    const user = this.requireAdmin(rawUser);
    const email = await this.registration.getUserEmail(user.tenantId, userId);
    if (!email) throw new NotFoundException('Solicitante no encontrado.');
    const result = await this.lookup.runAndStore(user.tenantId, userId, email);
    return { matches: result.matches, failures: result.failures };
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
    const ctx = extractClientContext(req);
    const action = dto.action === 'approve' ? 'APPROVE' : 'REJECT';
    const result = await this.decision.decideByAdmin(user.tenantId, userId, action, ctx);
    if (result.outcome === 'invalid') {
      throw new NotFoundException('Solicitante no encontrado.');
    }
    return { outcome: result.outcome };
  }
}
