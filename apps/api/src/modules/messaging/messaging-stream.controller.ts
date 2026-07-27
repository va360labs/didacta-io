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
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import {
  TokenService,
  type SessionClaims,
  type StreamTicketClaims,
} from '../../auth/token.service';
import { MessagingStreamService } from './messaging-stream.service';

/**
 * SSE de mensajería en tiempo real. Mismo flujo que el de notificaciones:
 *  1. `POST /modules/messaging/stream-ticket` (Bearer) → `{ ticket }` (60s).
 *  2. `EventSource('/api/v1/modules/messaging/stream?ticket=…')` — EventSource
 *     no permite headers custom, por eso el ticket va por query.
 */
@ApiTags('Modules · Messaging (realtime)')
@Controller('modules/messaging')
export class MessagingStreamController {
  constructor(
    private readonly streamService: MessagingStreamService,
    private readonly tokens: TokenService,
  ) {}

  // Sin JwtAuthGuard: EventSource no manda Authorization; autentica el ticket.
  // X-Accel-Buffering como DECORADOR (setearlo tras el writeHead de @Sse
  // crashea con ERR_HTTP_HEADERS_SENT — bug histórico de alpha.79).
  @Sse('stream')
  @Header('X-Accel-Buffering', 'no')
  @ApiOperation({
    summary:
      'Stream SSE de mensajería. Autentica con ?ticket=<jwt sse>. Eventos JSON con discriminador `kind` (message.created | ping).',
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

  @Post('stream-ticket')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Emite un ticket SSE de vida corta para abrir el stream de mensajería.',
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
