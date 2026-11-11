/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

/**
 * Tope de vídeos DISTINTOS que una cuenta puede empezar a ver, por hora y por
 * día. Un alumno no abre decenas de vídeos distintos en una hora; un script
 * que recorre el catálogo para descargarlo sí. Repetir un vídeo ya abierto no
 * cuenta: los saltos de capítulo y las recargas vuelven a pedir la URL.
 *
 * Los límites los pone cada tenant (ver `VideoProtectionConfigService`); este
 * servicio solo lleva la cuenta.
 */
export interface VideoPlayLimits {
  perHour: number;
  perDay: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Cuentas con historial en memoria antes de purgar (solo en el modo sin Redis). */
const MEMORY_MAX_ACCOUNTS = 20_000;

export type VideoPlayWindow = 'hour' | 'day';

export type VideoPlayDecision =
  | { allowed: true }
  | { allowed: false; window: VideoPlayWindow; limit: number; retryAfterSeconds: number };

/**
 * Lo mínimo de ioredis que usa el limitador (para mockearlo sin la librería).
 * Cada cuenta es un ZSET: miembro = guid, score = primera vez que lo abrió.
 */
export interface VideoPlayRedisClient {
  zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number>;
  zscore(key: string, member: string): Promise<string | null>;
  zcard(key: string): Promise<number>;
  zcount(key: string, min: string | number, max: string | number): Promise<number>;
  zrangebyscore(
    key: string,
    min: string | number,
    max: string | number,
    withScores: 'WITHSCORES',
    limit: 'LIMIT',
    offset: number,
    count: number,
  ): Promise<string[]>;
  zadd(key: string, nx: 'NX', score: number, member: string): Promise<number | string | null>;
  expire(key: string, seconds: number): Promise<number>;
}

/** Token DI del cliente Redis (null en test/local sin REDIS_URL). */
export const VIDEO_PLAY_REDIS_TOKEN = 'DIDACTA_VIDEO_PLAY_REDIS';

function retryAfter(oldestMs: number, windowMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((oldestMs + windowMs - nowMs) / 1000));
}

/**
 * Decide si cabe un vídeo más. Va en Redis (sobrevive a los despliegues y lo
 * comparten todas las réplicas). Si Redis no está o falla, cae a un mapa en
 * memoria del proceso: preferimos un tope que se reinicia al desplegar —y que
 * con varias réplicas cuenta por réplica— antes que dejar la puerta abierta.
 *
 * La clave lleva el tenant: dos academias del mismo servidor nunca comparten
 * contador, aunque un usuario tuviese el mismo id en ambas.
 */
@Injectable()
export class VideoPlayLimiter {
  private readonly logger = new Logger(VideoPlayLimiter.name);
  private readonly memory = new Map<string, Map<string, number>>();

  constructor(
    @Optional()
    @Inject(VIDEO_PLAY_REDIS_TOKEN)
    private readonly redis: VideoPlayRedisClient | null = null,
  ) {}

  async check(
    tenantId: string,
    userId: string,
    guid: string,
    limits: VideoPlayLimits,
    nowMs: number = Date.now(),
  ): Promise<VideoPlayDecision> {
    const key = `video-plays:${tenantId}:${userId}`;
    if (this.redis) {
      try {
        return await this.checkRedis(this.redis, key, guid, limits, nowMs);
      } catch (err) {
        this.logger.warn(
          `Redis no disponible para el tope de vídeos; uso memoria: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return this.checkMemory(key, guid, limits, nowMs);
  }

  private async checkRedis(
    redis: VideoPlayRedisClient,
    key: string,
    guid: string,
    limits: VideoPlayLimits,
    nowMs: number,
  ): Promise<VideoPlayDecision> {
    await redis.zremrangebyscore(key, '-inf', nowMs - DAY_MS);
    if ((await redis.zscore(key, guid)) !== null) return { allowed: true };

    const hourCount = await redis.zcount(key, `(${nowMs - HOUR_MS}`, '+inf');
    if (hourCount >= limits.perHour) {
      const [, oldest] = await redis.zrangebyscore(
        key,
        `(${nowMs - HOUR_MS}`,
        '+inf',
        'WITHSCORES',
        'LIMIT',
        0,
        1,
      );
      return {
        allowed: false,
        window: 'hour',
        limit: limits.perHour,
        retryAfterSeconds: retryAfter(Number(oldest ?? nowMs), HOUR_MS, nowMs),
      };
    }
    const dayCount = await redis.zcard(key);
    if (dayCount >= limits.perDay) {
      const [, oldest] = await redis.zrangebyscore(
        key,
        '-inf',
        '+inf',
        'WITHSCORES',
        'LIMIT',
        0,
        1,
      );
      return {
        allowed: false,
        window: 'day',
        limit: limits.perDay,
        retryAfterSeconds: retryAfter(Number(oldest ?? nowMs), DAY_MS, nowMs),
      };
    }
    await redis.zadd(key, 'NX', nowMs, guid);
    await redis.expire(key, Math.ceil(DAY_MS / 1000) + 60);
    return { allowed: true };
  }

  private checkMemory(
    key: string,
    guid: string,
    limits: VideoPlayLimits,
    nowMs: number,
  ): VideoPlayDecision {
    let plays = this.memory.get(key);
    if (!plays) {
      if (this.memory.size >= MEMORY_MAX_ACCOUNTS) this.pruneMemory(nowMs);
      plays = new Map();
      this.memory.set(key, plays);
    }
    for (const [g, at] of plays) {
      if (at <= nowMs - DAY_MS) plays.delete(g);
    }
    if (plays.has(guid)) return { allowed: true };

    const times = [...plays.values()].sort((a, b) => a - b);
    const lastHour = times.filter((at) => at > nowMs - HOUR_MS);
    if (lastHour.length >= limits.perHour) {
      return {
        allowed: false,
        window: 'hour',
        limit: limits.perHour,
        retryAfterSeconds: retryAfter(lastHour[0] ?? nowMs, HOUR_MS, nowMs),
      };
    }
    if (times.length >= limits.perDay) {
      return {
        allowed: false,
        window: 'day',
        limit: limits.perDay,
        retryAfterSeconds: retryAfter(times[0] ?? nowMs, DAY_MS, nowMs),
      };
    }
    plays.set(guid, nowMs);
    return { allowed: true };
  }

  /** Suelta las cuentas sin reproducciones en las últimas 24 h. */
  private pruneMemory(nowMs: number): void {
    for (const [key, plays] of this.memory) {
      let alive = false;
      for (const at of plays.values()) {
        if (at > nowMs - DAY_MS) {
          alive = true;
          break;
        }
      }
      if (!alive) this.memory.delete(key);
    }
    // Si aun así no cabe, se empieza de cero: es el modo degradado, y un mapa
    // sin límite en un proceso de larga vida es peor que perder la cuenta.
    if (this.memory.size >= MEMORY_MAX_ACCOUNTS) this.memory.clear();
  }
}
