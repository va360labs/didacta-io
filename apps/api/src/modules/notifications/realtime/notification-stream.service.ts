import {
  Injectable,
  Optional,
  type MessageEvent,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import IORedis, { type Redis } from 'ioredis';
import { Observable, Subject } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { RT_CHANNEL_PATTERN, type RealtimeNotificationEvent } from './notification-realtime.types';

/** Clave local que agrupa los streams de un mismo (tenant, user). */
function userKeyOf(tenantId: string, userId: string): string {
  return `${tenantId}:${userId}`;
}

/** Parsea `didacta:rt:notif:<tenantId>:<userId>` → userKey, o null si no matchea. */
function userKeyFromChannel(channel: string): string | null {
  const prefix = 'didacta:rt:notif:';
  if (!channel.startsWith(prefix)) return null;
  const rest = channel.slice(prefix.length);
  // rest === `<tenantId>:<userId>`; los ids son UUIDs (sin ':'), pero por
  // robustez tomamos el primer split y el resto como userId.
  const idx = rest.indexOf(':');
  if (idx < 0) return null;
  const tenantId = rest.slice(0, idx);
  const userId = rest.slice(idx + 1);
  if (!tenantId || !userId) return null;
  return userKeyOf(tenantId, userId);
}

/** Máximo de streams concurrentes por (tenant, user) — anti-abuso/leak. */
const MAX_STREAMS_PER_USER = 10;
/** Intervalo de heartbeat: comment SSE para evitar timeout del proxy (Traefik). */
const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Mantiene el subscriber Redis dedicado y el fan-out local a los clientes SSE
 * conectados a ESTA instancia. Diseño:
 *
 *  - `onModuleInit`: si hay `REDIS_URL`, crea un subscriber dedicado (un cliente
 *    en modo subscriber no puede ejecutar otros comandos, por eso es propio) y
 *    hace `PSUBSCRIBE didacta:rt:notif:*`. Cada `pmessage` se rutea localmente.
 *  - `register(tenantId, userId)`: devuelve un `Observable<MessageEvent>` que el
 *    `@Sse` del controller serializa al cliente. Crea un Subject, lo registra en
 *    el Map por userKey y lo limpia en `finalize` (cuando el cliente cierra).
 *  - Heartbeat global cada 25s: emite un evento `ping` a todos los Subjects.
 *  - `onApplicationShutdown`: completa todos los Subjects (cierra streams limpio)
 *    y hace `quit()` del subscriber.
 *
 * Sin `REDIS_URL` el service sigue operando como fan-out puramente local: los
 * streams se abren y reciben heartbeats, pero no llegan eventos cross-instancia
 * (en dev no hay publisher tampoco, así que es consistente).
 */
@Injectable()
export class NotificationStreamService implements OnModuleInit, OnApplicationShutdown {
  private subscriber: Redis | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly streams = new Map<string, Set<Subject<MessageEvent>>>();

  constructor(@Optional() private readonly logger?: PinoLogger) {}

  onModuleInit(): void {
    const url = process.env['REDIS_URL'];
    if (url && process.env['NODE_ENV'] !== 'test') {
      // Cliente dedicado en modo subscriber. No mezclamos con publisher ni
      // BullMQ: un cliente suscrito no puede ejecutar otros comandos.
      const sub = new IORedis(url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        lazyConnect: false,
      });
      sub.on('error', () => {
        /* swallow — best-effort; el stream local sigue funcionando */
      });
      sub.psubscribe(RT_CHANNEL_PATTERN).catch((err: unknown) => {
        this.warn(`PSUBSCRIBE falló: ${(err as Error).message}`);
      });
      sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
        this.dispatchLocal(channel, message);
      });
      this.subscriber = sub;
    }

    // Heartbeat: SSE comment-ping para que Traefik/NGINX no corten la conexión
    // idle. Lo emitimos como evento `ping` con timestamp.
    this.heartbeat = setInterval(() => {
      this.broadcastHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    // No mantenemos vivo el event loop solo por el heartbeat.
    this.heartbeat.unref?.();
  }

  /**
   * Registra un nuevo stream SSE para (tenant, user) y devuelve el Observable
   * que el controller expone vía `@Sse`. El cleanup (borrar el Subject del Map)
   * ocurre cuando el cliente cierra la conexión (rxjs `finalize`).
   */
  register(tenantId: string, userId: string): Observable<MessageEvent> {
    const key = userKeyOf(tenantId, userId);
    let set = this.streams.get(key);
    if (!set) {
      set = new Set();
      this.streams.set(key, set);
    }

    if (set.size >= MAX_STREAMS_PER_USER) {
      // Tope alcanzado: cerramos el stream más viejo para hacer sitio en vez
      // de rechazar (evita que un cliente con reconexiones colgadas se quede
      // sin realtime para siempre).
      const oldest = set.values().next().value;
      if (oldest) {
        oldest.complete();
        set.delete(oldest);
      }
    }

    const subject = new Subject<MessageEvent>();
    set.add(subject);

    return subject.asObservable().pipe(
      finalize(() => {
        const current = this.streams.get(key);
        if (current) {
          current.delete(subject);
          if (current.size === 0) this.streams.delete(key);
        }
        if (!subject.closed) subject.complete();
      }),
    );
  }

  /** Rutea un mensaje recibido por Redis a los Subjects locales del userKey. */
  private dispatchLocal(channel: string, rawMessage: string): void {
    const key = userKeyFromChannel(channel);
    if (!key) return;
    const set = this.streams.get(key);
    if (!set || set.size === 0) return;

    let event: RealtimeNotificationEvent;
    try {
      event = JSON.parse(rawMessage) as RealtimeNotificationEvent;
    } catch {
      this.warn('mensaje realtime con JSON inválido, descartado');
      return;
    }

    const message: MessageEvent = { type: 'notification', data: event };
    for (const subject of set) {
      if (!subject.closed) subject.next(message);
    }
  }

  private broadcastHeartbeat(): void {
    const ping: MessageEvent = { type: 'ping', data: { t: Date.now() } };
    for (const set of this.streams.values()) {
      for (const subject of set) {
        if (!subject.closed) subject.next(ping);
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    // Completa todos los Subjects → el `@Sse` cierra cada conexión limpia.
    for (const set of this.streams.values()) {
      for (const subject of set) {
        if (!subject.closed) subject.complete();
      }
    }
    this.streams.clear();

    if (this.subscriber) {
      try {
        await this.subscriber.quit();
      } catch {
        /* ignore — el proceso ya está bajando */
      }
      this.subscriber = null;
    }
  }

  private warn(message: string): void {
    if (this.logger) this.logger.warn(message);
    // eslint-disable-next-line no-console
    else console.warn(`[NotificationStreamService] ${message}`);
  }
}
