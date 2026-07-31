/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { MessagingCaller } from '@didacta/mod-messaging';
import { CurrentUser } from '../../auth/decorators';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { SessionClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../auth/zod-validation.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import { ModuleRegistryService } from '../module-registry.service';
import { MessagingPresenceService } from './messaging-presence.service';
import { MessagingRateLimit, MessagingRateLimitGuard } from './messaging-rate-limit.guard';
import { MessagingRealtimePublisher } from './messaging-realtime.publisher';
import { TYPING_TTL_MS } from './messaging-realtime.types';

const openDmSchema = z.object({ userId: z.string().uuid() });
const sendMessageSchema = z.object({ body: z.string().min(1).max(4000) });
const listMessagesQuerySchema = z.object({ cursor: z.string().uuid().optional() });
const membersQuerySchema = z.object({ search: z.string().max(80).optional() });

/**
 * Endpoints REST de mod.messaging (US-M1..M3 del PRD `mensajes`).
 * El service de dominio se obtiene SIEMPRE vía el registry; el realtime se
 * publica aquí (host) con los destinatarios que devuelve el dominio.
 */
@ApiTags('Modules · Messaging')
@ApiBearerAuth()
@Controller('modules/messaging')
// El guard de cupo solo actúa donde hay @MessagingRateLimit(); colgarlo del
// controller entero evita olvidarlo al añadir endpoints con efectos.
@UseGuards(JwtAuthGuard, MessagingRateLimitGuard)
export class MessagingController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
    private readonly realtime: MessagingRealtimePublisher,
    private readonly presence: MessagingPresenceService,
  ) {}

  /**
   * Identidad completa del llamante (displayName resuelto una vez por request).
   * Verifica contra BD que la cuenta siga operativa: un usuario suspendido,
   * desactivado o borrado no conserva la mensajería aunque su JWT siga vivo.
   */
  private async callerOf(user: SessionClaims | undefined): Promise<MessagingCaller> {
    if (!user) throw new UnauthorizedException();
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { name: true, email: true, status: true, deletedAt: true },
    });
    if (!dbUser || dbUser.deletedAt || dbUser.status !== 'ACTIVE') {
      throw new ForbiddenException('Tu cuenta no puede usar la mensajería.');
    }
    return {
      userId: user.sub,
      displayName: dbUser.name ?? dbUser.email ?? null,
      roles: user.roles,
    };
  }

  @Get('conversations')
  @ApiOperation({
    summary:
      'Lista las conversaciones del usuario: salas de espacios, canal de profesores (o bandeja de consultas si es staff) y directos, con no-leídos.',
  })
  async listConversations(@CurrentUser() user: SessionClaims | undefined) {
    const caller = await this.callerOf(user);
    const conversations = await this.registry
      .getMessagingService()
      .listConversations(user!.tenantId, caller);
    return { conversations };
  }

  @Post('dm')
  @ApiOperation({ summary: 'Abre (o crea, idempotente por par) el directo con otro miembro.' })
  async openDm(
    @CurrentUser() user: SessionClaims | undefined,
    @Body(new ZodValidationPipe(openDmSchema)) dto: z.infer<typeof openDmSchema>,
  ) {
    const caller = await this.callerOf(user);
    return this.registry.getMessagingService().openDm(user!.tenantId, caller, dto.userId);
  }

  @Post('spaces/:slug/open')
  @ApiOperation({ summary: 'Abre la sala del espacio (se crea lazy la primera vez).' })
  async openSpace(@CurrentUser() user: SessionClaims | undefined, @Param('slug') slug: string) {
    const caller = await this.callerOf(user);
    return this.registry.getMessagingService().openSpace(user!.tenantId, caller, slug);
  }

  @Post('faculty/open')
  @ApiOperation({ summary: 'Abre el canal de profesores del alumno (auto-provisionado).' })
  async openFaculty(@CurrentUser() user: SessionClaims | undefined) {
    const caller = await this.callerOf(user);
    return this.registry.getMessagingService().openFaculty(user!.tenantId, caller);
  }

  @Get('conversations/:id/messages')
  @ApiOperation({ summary: 'Histórico paginado por cursor (50, del más reciente al más antiguo).' })
  async listMessages(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') conversationId: string,
    @Query(new ZodValidationPipe(listMessagesQuerySchema))
    query: z.infer<typeof listMessagesQuerySchema>,
  ) {
    const caller = await this.callerOf(user);
    return this.registry
      .getMessagingService()
      .listMessages(user!.tenantId, caller, conversationId, query.cursor);
  }

  @Post('conversations/:id/messages')
  // El cupo de 20/min que especificaba el PRD de `mensajes` y que nunca llegó a
  // implementarse (no había throttler en la API). ADR-019 §3.
  @MessagingRateLimit({ bucket: 'send', limit: 20, windowSec: 60 })
  @ApiOperation({ summary: 'Envía un mensaje de texto y lo empuja por SSE a los participantes.' })
  async sendMessage(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') conversationId: string,
    @Body(new ZodValidationPipe(sendMessageSchema)) dto: z.infer<typeof sendMessageSchema>,
  ) {
    const caller = await this.callerOf(user);
    const result = await this.registry
      .getMessagingService()
      .sendMessage(user!.tenantId, caller, conversationId, dto.body);

    // Push realtime a destinatarios + autor (sus otras pestañas). Best-effort:
    // la BD es la fuente de verdad, el cliente dedupea por id.
    await this.realtime.publishToUsers(
      user!.tenantId,
      [...result.recipientUserIds, caller.userId],
      { kind: 'message.created', conversationId, message: result.message },
    );

    return { message: result.message };
  }

  @Post('conversations/:id/typing')
  @HttpCode(HttpStatus.NO_CONTENT)
  // 30/min = el doble de lo que emite el cliente (1 cada 3 s): deja margen a
  // varias conversaciones abiertas sin dejar el endpoint a pelo.
  @MessagingRateLimit({ bucket: 'typing', limit: 30, windowSec: 60 })
  @ApiOperation({
    summary:
      'Señala que el usuario está escribiendo en la conversación. Efímero: publica por SSE y no persiste nada (ADR-019).',
  })
  async typing(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') conversationId: string,
  ): Promise<void> {
    const caller = await this.callerOf(user);
    const recipients = await this.registry
      .getMessagingService()
      .recipientsForTyping(user!.tenantId, caller, conversationId);

    // Sin el autor: nadie necesita verse escribir a sí mismo.
    await this.realtime.publishToUsers(user!.tenantId, recipients, {
      kind: 'typing',
      conversationId,
      userId: caller.userId,
      displayName: caller.displayName,
      ttlMs: TYPING_TTL_MS,
    });
  }

  @Get('presence')
  @ApiOperation({
    summary:
      'Miembros del tenant con el stream de mensajería abierto ahora (presencia efímera, ADR-019).',
  })
  async getPresence(@CurrentUser() user: SessionClaims | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.presence.snapshot(user.tenantId);
  }

  @Post('conversations/:id/read')
  @ApiOperation({ summary: 'Marca la conversación como leída (sella lastReadAt).' })
  async markRead(
    @CurrentUser() user: SessionClaims | undefined,
    @Param('id') conversationId: string,
  ) {
    const caller = await this.callerOf(user);
    await this.registry.getMessagingService().markRead(user!.tenantId, caller, conversationId);
    return { ok: true };
  }

  @Get('members')
  @ApiOperation({
    summary:
      'Busca miembros del tenant para abrir un directo (por nombre o email, máx 20 resultados).',
  })
  async searchMembers(
    @CurrentUser() user: SessionClaims | undefined,
    @Query(new ZodValidationPipe(membersQuerySchema)) query: z.infer<typeof membersQuerySchema>,
  ) {
    if (!user) throw new UnauthorizedException();
    const search = query.search?.trim() ?? '';
    const members = await this.prisma.user.findMany({
      where: {
        tenantId: user.tenantId,
        deletedAt: null,
        // Solo cuentas operativas: PENDING/SUSPENDED/DEACTIVATED no salen en
        // el directorio (mismo criterio que el listado de miembros).
        status: 'ACTIVE',
        id: { not: user.sub },
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: { id: true, name: true, avatarUrl: true },
      orderBy: { name: 'asc' },
      take: 20,
    });
    return { members };
  }
}
