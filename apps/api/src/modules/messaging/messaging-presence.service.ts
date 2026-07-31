/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  Injectable,
  Optional,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import IORedis, { type Redis } from 'ioredis';

/**
 * Presencia efímera del aula (ADR-019).
 *
 * ZSET por tenant (`didacta:presence:<tenantId>`), `member = userId`,
 * `score = epoch ms`. Se escribe SOLO desde el ciclo de vida del stream SSE
 * (alta + cada latido de 25 s) y se considera presente quien tenga score dentro
 * de la ventana. Cero tablas, cero escrituras en Postgres.
 *
 * No hay borrado explícito al desconectar: con varias instancias de API y
 * varias pestañas por usuario, cerrar una conexión no implica ausencia. La
 * caducidad por score hace la lectura idempotente sin coordinación — a cambio
 * de hasta `WINDOW_MS` de latencia al desaparecer.
 *
 * El cliente Redis del `MessagingStreamService` está en modo subscriber y no
 * puede ejecutar otros comandos, por eso esta clase abre el suyo (mismo patrón
 * que `MessagingRealtimePublisher`).
 */

/** Ventana de presencia: tolera dos latidos perdidos (heartbeat = 25 s). */
export const PRESENCE_WINDOW_MS = 60_000;

/** Tope de ids devueltos; `onlineCount` sigue siendo el total real. */
export const PRESENCE_MAX_IDS = 200;

/** TTL de la clave para que un tenant sin actividad no quede residente. */
const PRESENCE_KEY_TTL_SEC = 300;

export interface PresenceSnapshot {
  onlineCount: number;
  onlineUserIds: string[];
}

function presenceKey(tenantId: string): string {
  return `didacta:presence:${tenantId}`;
}

@Injectable()
export class MessagingPresenceService implements OnModuleInit, OnApplicationShutdown {
  private client: Redis | null = null;
  /** Espejo local: fallback sin Redis (dev) y en caídas puntuales. */
  private readonly local = new Map<string, Map<string, number>>();
  private lastWarnAt = 0;

  constructor(@Optional() private readonly logger?: PinoLogger) {}

  onModuleInit(): void {
    const url = process.env['REDIS_URL'];
    if (url && process.env['NODE_ENV'] !== 'test') {
      const client = new IORedis(url, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
        lazyConnect: false,
      });
      client.on('error', () => {
        /* swallow — la presencia degrada al espejo local */
      });
      this.client = client;
    }
  }

  /**
   * Marca al usuario como presente. Fire-and-forget: la presencia jamás debe
   * poder tumbar un latido del stream.
   */
  touch(tenantId: string, userId: string): void {
    const now = Date.now();
    let byUser = this.local.get(tenantId);
    if (!byUser) {
      byUser = new Map();
      this.local.set(tenantId, byUser);
    }
    byUser.set(userId, now);

    if (!this.client || this.client.status !== 'ready') return;
    const key = presenceKey(tenantId);
    void this.client
      .multi()
      .zadd(key, now, userId)
      .expire(key, PRESENCE_KEY_TTL_SEC)
      .exec()
      .catch((err: unknown) => this.warnOnce(err));
  }

  /** Presencia actual del tenant. Nunca lanza: sin señal devuelve 0. */
  async snapshot(tenantId: string): Promise<PresenceSnapshot> {
    const now = Date.now();
    const min = now - PRESENCE_WINDOW_MS;

    if (this.client && this.client.status === 'ready') {
      try {
        const key = presenceKey(tenantId);
        const results = await this.client
          .multi()
          .zremrangebyscore(key, '-inf', min)
          .zcount(key, min, '+inf')
          .zrangebyscore(key, min, '+inf', 'LIMIT', 0, PRESENCE_MAX_IDS)
          .exec();
        // ioredis devuelve [[err, value], …]; un null solo pasa si la conexión
        // se cayó a mitad de la transacción.
        const count = results?.[1]?.[1];
        const ids = results?.[2]?.[1];
        if (typeof count === 'number' && Array.isArray(ids)) {
          return { onlineCount: count, onlineUserIds: ids as string[] };
        }
      } catch (err) {
        this.warnOnce(err);
      }
    }

    return this.localSnapshot(tenantId, min);
  }

  private localSnapshot(tenantId: string, min: number): PresenceSnapshot {
    const byUser = this.local.get(tenantId);
    if (!byUser) return { onlineCount: 0, onlineUserIds: [] };
    const online: string[] = [];
    for (const [userId, at] of byUser) {
      if (at <= min) byUser.delete(userId);
      else online.push(userId);
    }
    if (byUser.size === 0) this.local.delete(tenantId);
    return { onlineCount: online.length, onlineUserIds: online.slice(0, PRESENCE_MAX_IDS) };
  }

  private warnOnce(err: unknown): void {
    const now = Date.now();
    if (now - this.lastWarnAt < 60_000) return;
    this.lastWarnAt = now;
    const message = err instanceof Error ? err.message : String(err);
    if (this.logger) this.logger.warn({ err: message }, 'presencia de mensajería degradada');
    // eslint-disable-next-line no-console
    else console.warn(`[MessagingPresenceService] ${message}`);
  }

  async onApplicationShutdown(): Promise<void> {
    this.local.clear();
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        /* el proceso ya está bajando */
      }
      this.client = null;
    }
  }
}
