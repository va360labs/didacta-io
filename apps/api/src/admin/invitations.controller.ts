import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractClientContext } from '../auth/client-context';
import { resolveWebBaseUrl } from '../common/resolve-web-base-url';
import { CurrentUser } from '../auth/decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { SessionClaims } from '../auth/token.service';
import { ZodValidationPipe } from '../auth/zod-validation.pipe';
import { InvitationsService } from './invitations.service';

const listQuerySchema = z.object({
  filtro: z.enum(['invitados', 'activados', 'sin-enviar', 'sin-acceso']).optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
type ListQueryDto = z.infer<typeof listQuerySchema>;

const batchSchema = z
  .object({
    /** Cuántas invitaciones enviar en este lote. */
    size: z.number().int().min(1).max(200).optional(),
    /** Destinatarios exactos (para priorizar). Sin esto, los más antiguos. */
    emails: z.array(z.string().email().max(200)).max(200).optional(),
    /** Pausa entre correos, en milisegundos. */
    pauseMs: z.number().int().min(0).max(5000).optional(),
  })
  .strict();
type BatchDto = z.infer<typeof batchSchema>;

const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin']);

function requireAdmin(user: SessionClaims | undefined): SessionClaims {
  if (!user) throw new UnauthorizedException();
  if (!user.roles.some((r) => ADMIN_ROLES.has(r))) {
    throw new ForbiddenException('Esta acción requiere rol de administrador.');
  }
  return user;
}

/**
 * Panel de seguimiento de las invitaciones al aula: quién la ha recibido, quién
 * ha entrado y a quién le falta, más el envío por lotes.
 *
 * El envío masivo se hace por lotes A PROPÓSITO: mandar cientos de correos de
 * golpe desde el SMTP del tenant es la vía rápida a que el dominio quede
 * marcado como spam, y eso arrastraría también a los correos transaccionales
 * (contraseñas, certificados).
 */
@ApiTags('Admin · Invitaciones')
@ApiBearerAuth()
@Controller('admin/invitations')
@UseGuards(JwtAuthGuard)
export class InvitationsController {
  constructor(private readonly service: InvitationsService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Contadores: invitados, activados tras la invitación, sin invitar.' })
  async summary(@CurrentUser() user: SessionClaims | undefined) {
    const u = requireAdmin(user);
    return this.service.summary(u.tenantId);
  }

  @Get()
  @ApiOperation({
    summary:
      'Listado de invitaciones con su estado (filtros: invitados | activados | sin-enviar | sin-acceso).',
  })
  async list(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQueryDto,
  ) {
    const u = requireAdmin(user);
    return this.service.list(u.tenantId, query);
  }

  @Post('send-batch')
  @ApiOperation({
    summary:
      'Arranca el envío de la invitación al siguiente lote de pendientes que aún no la han ' +
      'recibido y responde al instante: el envío sigue en segundo plano (~1 s por correo) y su ' +
      'progreso se consulta en `GET /summary` → `envio`. Idempotente entre lotes: nadie la ' +
      'recibe dos veces. Si ya hay un lote en curso responde `yaEnCurso: true` sin arrancar otro.',
  })
  async sendBatch(
    @CurrentUser() user: SessionClaims | undefined,
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(batchSchema)) dto: BatchDto,
  ) {
    const u = requireAdmin(user);
    return this.service.startBatch(
      u.tenantId,
      u.sub,
      resolveWebBaseUrl(req),
      extractClientContext(req),
      dto,
    );
  }
}
