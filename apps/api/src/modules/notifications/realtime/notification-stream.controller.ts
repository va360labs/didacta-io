import {
  Controller,
  Header,
  Post,
  Query,
  Sse,
  UnauthorizedException,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
  // Headers anti-buffering declarados con @Header (Nest los aplica ANTES de que
  // `@Sse` haga writeHead → evita ERR_HTTP_HEADERS_SENT). `@Sse` ya setea
  // Content-Type: text/event-stream, Cache-Control: no-cache y Connection:
  // keep-alive en su SseStream; aquí solo añadimos X-Accel-Buffering (que Nest
  // no setea) para que NGINX/proxies no bufferen el stream. Traefik no bufferea
  // SSE por defecto, pero el header es inocuo y cubre despliegues con NGINX.
  //
  // alpha.80: fix del bug introducido en alpha.79, donde estos headers se
  // seteaban con reply.raw.setHeader() DESPUÉS del flush de @Sse → el stream
  // abría pero crasheaba con "Cannot set headers after they are sent".
  @Sse('stream')
  @Header('X-Accel-Buffering', 'no')
  @ApiOperation({
    summary:
      'Stream SSE de notificaciones en tiempo real. Autentica con ?ticket=<jwt sse>. Eventos: type=notification|ping.',
  })
  async stream(@Query('ticket') ticket: string | undefined): Promise<Observable<MessageEvent>> {
    if (!ticket) throw new UnauthorizedException('Falta el ticket de stream');

    let claims: StreamTicketClaims;
    try {
      claims = await this.tokens.verifyStreamTicket(ticket);
    } catch {
      throw new UnauthorizedException('Ticket de stream inválido o expirado');
    }

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
