import { Inject, Injectable, Optional } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { channelFor, type RealtimeNotificationEvent } from './notification-realtime.types';

/**
 * Cliente Redis mínimo que el publisher necesita. Modelamos solo `publish`
 * para que los tests puedan mockear sin pull de ioredis. En producción esta
 * interfaz la cumple `IORedis` directamente.
 */
export interface RealtimePublisherRedis {
  publish(channel: string, message: string): Promise<number>;
}

/** Token DI para inyectar el cliente Redis publisher (o null en test/local). */
export const RT_PUBLISHER_REDIS_TOKEN = 'DIDACTA_RT_PUBLISHER_REDIS';

/**
 * Publica eventos realtime de notificaciones en Redis pub/sub. El
 * `NotificationStreamService` (que mantiene un subscriber dedicado en cada
 * instancia de la API) los recibe y reemite por SSE a los clientes conectados
 * de ese (tenant, user). Usar pub/sub permite que un evento creado en la
 * instancia A llegue a un cliente conectado a la instancia B (multi-réplica).
 *
 * FAILSAFE total: si no hay Redis (`null`) o `publish` lanza, logueamos un warn
 * rate-limited y retornamos. NUNCA propagamos el error al caller — la creación
 * de la notificación en BD ya ocurrió y es la fuente de verdad; el realtime es
 * best-effort (el cliente puede refetch o lo verá al recargar).
 */
@Injectable()
export class NotificationRealtimePublisher {
  private lastWarnAt = 0;

  constructor(
    @Optional()
    @Inject(RT_PUBLISHER_REDIS_TOKEN)
    private readonly redis: RealtimePublisherRedis | null = null,
    @Optional() private readonly logger?: PinoLogger,
  ) {}

  async publishInApp(
    tenantId: string,
    userId: string,
    event: RealtimeNotificationEvent,
  ): Promise<void> {
    if (!this.redis) {
      // Sin Redis (dev/test sin REDIS_URL) el realtime simplemente no opera.
      // No logueamos cada vez para no inundar; es un estado esperado en local.
      return;
    }

    const channel = channelFor(tenantId, userId);
    try {
      const payload = JSON.stringify({
        id: event.id,
        templateKey: event.templateKey,
        subject: event.subject,
        createdAt:
          event.createdAt instanceof Date ? event.createdAt.toISOString() : event.createdAt,
        ...(event.metadata ? { metadata: event.metadata } : {}),
      });
      await this.redis.publish(channel, payload);
    } catch (err) {
      this.warnOnce(`realtime publish falló (best-effort): ${(err as Error).message}`);
    }
  }

  private warnOnce(message: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt < 60_000) return;
    this.lastWarnAt = now;
    if (this.logger) {
      this.logger.warn(message);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[NotificationRealtimePublisher] ${message}`);
    }
  }
}
