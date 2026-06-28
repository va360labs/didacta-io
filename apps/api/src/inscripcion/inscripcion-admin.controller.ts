import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { MemberRegistrationService } from './member-registration.service';
import { MemberSubscriptionLookupService } from './member-subscription-lookup.service';

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
}
