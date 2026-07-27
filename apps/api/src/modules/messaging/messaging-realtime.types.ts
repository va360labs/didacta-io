import type { MessageView } from '@didacta/mod-messaging';

/**
 * Canal Redis pub/sub del realtime de mensajería, uno por (tenant, user) —
 * mismo esquema que notificaciones pero con prefijo propio para no mezclar
 * suscriptores: `didacta:rt:msg:<tenantId>:<userId>`.
 */
export function messagingChannelFor(tenantId: string, userId: string): string {
  return `didacta:rt:msg:${tenantId}:${userId}`;
}

export const MESSAGING_RT_CHANNEL_PATTERN = 'didacta:rt:msg:*';

/**
 * Evento que viaja por el stream SSE. OJO: el `MessageEvent` de Nest se emite
 * SIN campo `type` a propósito — un `type` distinto de "message" se serializa
 * como `event: <type>` y el `onmessage` del EventSource del navegador no se
 * dispara. El discriminador va DENTRO del JSON (`kind`).
 */
export type MessagingRealtimeEvent =
  | {
      kind: 'message.created';
      conversationId: string;
      message: MessageView;
    }
  | {
      kind: 'ping';
      t: number;
    };
