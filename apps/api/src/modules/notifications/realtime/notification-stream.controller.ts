import {
  Controller,
  Post,
  Query,
  Req,
  Res,
  Sse,
  UnauthorizedException,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import { CurrentUser } from '../../../auth/decorators';
import { JwtAuthGuard } from '../../../auth/jwt-auth.guard';
import {
  TokenService,
  type SessionClaims,
  type StreamTicketClaims,
} from '../../../auth/token.service';
import { NotificationStreamService } from './notification-stream.service';

/**
 * Endpoints SSE de notificaciones en tiempo real para el alumno.
 *
 * Flujo:
 *  1. El cliente (autenticado con Bearer) llama `POST /me/notifications/stream-ticket`
 *     y recibe `{ ticket }` — un JWT de vida corta (`kind:'sse'`, 60s).
 *  2. Abre `EventSource('/api/v1/me/notifications/stream?ticket=<ticket>')`.
 *     EventSource NO permite custom headers, por eso el ticket va por query.
 *  3. El servidor verifica el ticket y devuelve el Observable de eventos
 *     (`@Sse` serializa cada `MessageEvent` al formato SSE).
 */
@ApiTags('Modules · Notifications (realtime)')
@Controller('me/notifications')
export class NotificationStreamController {
  constructor(
    private readonly streamService: NotificationStreamService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Stream SSE. NO usa `JwtAuthGuard` (EventSource no manda Authorization);
   * autentica con el ticket de query verificado a mano.
   */
  @Sse('stream')
  @ApiOperation({
    summary:
      'Stream SSE de notificaciones en tiempo real. Autentica con ?ticket=<jwt sse>. Eventos: type=notification|ping.',
  })
  async stream(
    @Query('ticket') ticket: string | undefined,
    @Req() _req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Observable<MessageEvent>> {
    if (!ticket) throw new UnauthorizedException('Falta el ticket de stream');

    let claims: StreamTicketClaims;
    try {
      claims = await this.tokens.verifyStreamTicket(ticket);
    } catch {
      throw new UnauthorizedException('Ticket de stream inválido o expirado');
    }

    // Headers anti-buffering: imprescindibles detrás de Traefik/NGINX para que
    // los eventos se entreguen incrementalmente y no se acumulen en un buffer.
    // `@Sse` ya setea Content-Type: text/event-stream; estos los complementan.
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.setHeader('Connection', 'keep-alive');

    return this.streamService.register(claims.tenantId, claims.sub);
  }

  /**
   * Emite un ticket de stream SSE de vida corta. Autenticado con Bearer
   * (access token normal) vía `JwtAuthGuard`.
   */
  @Post('stream-ticket')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Emite un ticket SSE de vida corta para abrir el stream de notificaciones. Requiere Bearer.',
  })
  async issueTicket(@CurrentUser() user: SessionClaims | undefined): Promise<{ ticket: string }> {
    if (!user) throw new UnauthorizedException();
    const ticket = await this.tokens.signStreamTicket({
      sub: user.sub,
      tenantId: user.tenantId,
    });
    return { ticket };
  }
}
