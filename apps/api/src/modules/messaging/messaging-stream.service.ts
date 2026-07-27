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
import { MESSAGING_RT_CHANNEL_PATTERN } from './messaging-realtime.types';

function userKeyOf(tenantId: string, userId: string): string {
  return `${tenantId}:${userId}`;
}

/** Parsea `didacta:rt:msg:<tenantId>:<userId>` → userKey, o null. */
function userKeyFromChannel(channel: string): string | null {
  const prefix = 'didacta:rt:msg:';
  if (!channel.startsWith(prefix)) return null;
  const rest = channel.slice(prefix.length);
  const idx = rest.indexOf(':');
  if (idx < 0) return null;
  const tenantId = rest.slice(0, idx);
  const userId = rest.slice(idx + 1);
  if (!tenantId || !userId) return null;
  return userKeyOf(tenantId, userId);
}

const MAX_STREAMS_PER_USER = 10;
const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Fan-out local de eventos realtime de mensajería a los clientes SSE de ESTA
 * instancia (mismo diseño que NotificationStreamService, con su propio
 * subscriber Redis dedicado sobre `didacta:rt:msg:*`).
 *
 * Los MessageEvent se emiten SIN `type`: Nest serializa `type` como
 * `event: <type>` y el `onmessage` del EventSource del navegador solo se
 * dispara para eventos sin nombre. El discriminador (`kind`) viaja en el JSON.
 */
@Injectable()
export class MessagingStreamService implements OnModuleInit, OnApplicationShutdown {
  private subscriber: Redis | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly streams = new Map<string, Set<Subject<MessageEvent>>>();

  constructor(@Optional() private readonly logger?: PinoLogger) {}

  onModuleInit(): void {
    const url = process.env['REDIS_URL'];
    if (url && process.env['NODE_ENV'] !== 'test') {
      // Cliente dedicado en modo subscriber (no puede ejecutar otros comandos).
      const sub = new IORedis(url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        lazyConnect: false,
      });
      sub.on('error', () => {
        /* swallow — el stream local sigue funcionando */
      });
      sub.psubscribe(MESSAGING_RT_CHANNEL_PATTERN).catch((err: unknown) => {
        this.warn(`PSUBSCRIBE falló: ${(err as Error).message}`);
      });
      sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
        this.dispatchLocal(channel, message);
      });
      this.subscriber = sub;
    }

    this.heartbeat = setInterval(() => {
      this.broadcastHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  register(tenantId: string, userId: string): Observable<MessageEvent> {
    const key = userKeyOf(tenantId, userId);
    let set = this.streams.get(key);
    if (!set) {
      set = new Set();
      this.streams.set(key, set);
    }

    if (set.size >= MAX_STREAMS_PER_USER) {
      // Cerramos el más viejo en vez de rechazar (reconexiones colgadas).
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

  private dispatchLocal(channel: string, rawMessage: string): void {
    const key = userKeyFromChannel(channel);
    if (!key) return;
    const set = this.streams.get(key);
    if (!set || set.size === 0) return;

    let data: unknown;
    try {
      data = JSON.parse(rawMessage);
    } catch {
      this.warn('mensaje realtime con JSON inválido, descartado');
      return;
    }

    // Sin `type`: ver doc de la clase.
    const message: MessageEvent = { data: data as object };
    for (const subject of set) {
      if (!subject.closed) subject.next(message);
    }
  }

  private broadcastHeartbeat(): void {
    // Con Redis CONFIGURADO pero caído, callar el heartbeat es deliberado: el
    // proxy corta la conexión idle, el cliente reconecta y, si persiste,
    // degrada a polling. Un ping alegre aquí enmascararía el blackout de
    // eventos. Sin REDIS_URL (dev), el fan-out local sigue con heartbeat.
    if (this.subscriber && this.subscriber.status !== 'ready') return;
    const ping: MessageEvent = { data: { kind: 'ping', t: Date.now() } };
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
        /* ignore */
      }
      this.subscriber = null;
    }
  }

  private warn(message: string): void {
    if (this.logger) this.logger.warn(message);
    // eslint-disable-next-line no-console
    else console.warn(`[MessagingStreamService] ${message}`);
  }
}
