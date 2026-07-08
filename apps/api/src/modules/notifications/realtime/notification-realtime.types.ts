/**
 * Tipos y helpers compartidos del subsistema realtime de notificaciones
 * (SSE + Redis pub/sub). Aislados aquí para que publisher, subscriber y
 * controller compartan una única fuente de verdad del nombre de canal.
 */

/**
 * Payload que viaja por Redis pub/sub y se reemite al cliente vía SSE cuando
 * se crea una notificación IN_APP. Minimal a propósito: el cliente usa esto
 * para incrementar el badge / hacer un toast y luego refetch del listado
 * completo vía `GET /me/notifications`.
 */
export interface RealtimeNotificationEvent {
  id: string;
  templateKey: string;
  subject: string | null;
  createdAt: string | Date;
  /**
   * Metadatos de la notificación (las `variables` con las que se renderizó).
   * El cliente los usa para armar el deep-link del toast sin un refetch — p.
   * ej. `{ postId, commentId }` para llevar a "responder". Opcional y pequeño.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Canal Redis para un (tenant, user). Namespaced con prefijo `didacta:rt:notif`
 * para no colisionar con otras keys (rate limit, bullmq) en una instancia Redis
 * compartida. El subscriber hace `PSUBSCRIBE` sobre el patrón y rutea por canal.
 */
export function channelFor(tenantId: string, userId: string): string {
  return `didacta:rt:notif:${tenantId}:${userId}`;
}

/** Patrón para `PSUBSCRIBE` — captura todos los canales de notificaciones RT. */
export const RT_CHANNEL_PATTERN = 'didacta:rt:notif:*';
