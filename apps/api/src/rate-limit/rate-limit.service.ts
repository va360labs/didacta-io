/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * RateLimitService — sexto piloto License SDK.
 *
 * Responsabilidad: dado un (tenantId, isPublic), decidir si la request actual
 * cabe dentro del rate aplicable (community o enterprise según licencia) y
 * devolver un RateLimitDecision con headers ya calculados.
 *
 * Diseño:
 *   - Backend: Redis con clave
 *       `ratelimit:<tenantId>:<bucket>:<minute>`
 *     incrementada con `INCR` + `EXPIRE` (TTL = windowSeconds + 5 de gracia).
 *   - Tier dinámico: cada request consulta `LicenseService.isCapabilityEnabled
 *     (feat:api.rate_limit.elevated)`. Eso significa que un cambio de licencia
 *     en runtime (recarga del SDK) afecta inmediatamente al rate efectivo
 *     SIN reiniciar la API.
 *   - Failsafe: si Redis no está disponible o lanza error, el servicio
 *     PERMITE la request — preferimos servir tráfico a meternos un outage por
 *     un rate limiter caído. El error se loggea (warn) y devolvemos los
 *     headers del límite del tier comunidad para que el cliente sepa qué
 *     escenario hay (mejor que mentir con un X-RateLimit-Limit:Infinity).
 *
 * Decisiones explícitas:
 *   - `tenantId === 'anonymous'` → bucket público. El interceptor pasa
 *     `'anonymous'` cuando el JWT está ausente o falla.
 *   - Sliding window simple (ventana fija de 1 minuto natural). Ver design
 *     note en `rate-limit.types.ts`.
 *   - El service NO conoce HTTP — eso vive en el interceptor. Esto facilita
 *     reusarlo desde GraphQL/WebSocket si llegáramos.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { LicenseService } from '@didacta/license-sdk';
import { Logger as PinoLogger } from 'nestjs-pino';
import {
  DEFAULT_RATE_LIMIT_CONFIG,
  RATE_LIMIT_ELEVATED_CAPABILITY,
  resolveRateLimitConfig,
  type RateLimitBucket,
  type RateLimitConfig,
  type RateLimitDecision,
  type RateLimitTier,
} from './rate-limit.types';

/**
 * Cliente Redis mínimo que el service necesita. Modelamos solo los métodos
 * realmente usados para que los tests puedan mockear sin pull de ioredis.
 *
 * En producción esta interfaz la cumple `IORedis` directamente — los métodos
 * coinciden 1:1.
 */
export interface RateLimitRedisClient {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/** Token DI para inyectar el cliente Redis (o un mock en tests). */
export const RATE_LIMIT_REDIS_TOKEN = 'DIDACTA_RATE_LIMIT_REDIS';

@Injectable()
export class RateLimitService {
  private readonly config: RateLimitConfig;
  private readonly logger: PinoLogger | undefined;

  /**
   * Bandera para que el warning de "Redis caído, fallback open" se emita
   * a lo sumo una vez por minuto y no inunde los logs en una caída larga.
   */
  private lastFailsafeLogAt = 0;

  constructor(
    private readonly license: LicenseService,
    @Optional()
    @Inject(RATE_LIMIT_REDIS_TOKEN)
    private readonly redis: RateLimitRedisClient | null = null,
    @Optional() logger?: PinoLogger,
  ) {
    this.config = resolveRateLimitConfig();
    this.logger = logger;
  }

  /**
   * Devuelve la configuración efectiva. Útil para el endpoint
   * GET /admin/rate-limit/info.
   */
  getConfig(): RateLimitConfig {
    return this.config;
  }

  /**
   * Resuelve el tier actual leyendo la licencia. Pensado para que el
   * controller info pueda reportarlo sin re-implementar la lógica.
   */
  getCurrentTier(): RateLimitTier {
    return this.license.isCapabilityEnabled(RATE_LIMIT_ELEVATED_CAPABILITY)
      ? 'enterprise'
      : 'community';
  }

  /**
   * Registra una request contra el bucket apropiado y devuelve la decisión.
   *
   * Reglas:
   *  - Si `tenantId` es vacío/null/undefined, lo tratamos como `'anonymous'`.
   *  - El bucket lo decide el caller con `isPublic`.
   *  - Si el INCR devuelve un valor > limit, la request se rechaza.
   *  - Failsafe: si Redis lanza o no está inyectado → devolvemos
   *    `{ allowed: true, ... }` con headers del tier comunidad.
   */
  async recordRequest(
    tenantId: string | null | undefined,
    isPublic: boolean,
    now: Date = new Date(),
  ): Promise<RateLimitDecision> {
    const tier: RateLimitTier = this.getCurrentTier();
    const bucket: RateLimitBucket = isPublic ? 'public' : 'authenticated';
    const limit = this.config[tier][bucket];
    const windowSeconds = this.config.windowSeconds;
    const resolvedTenant = tenantId && tenantId.length > 0 ? tenantId : 'anonymous';

    const minute = Math.floor(now.getTime() / (windowSeconds * 1000));
    const key = `ratelimit:${resolvedTenant}:${bucket}:${minute}`;
    const resetAt = new Date((minute + 1) * windowSeconds * 1000);

    // Failsafe: Redis no inyectado o ausente.
    if (!this.redis) {
      this.logFailsafeOnce(now, 'Redis client not configured — rate limiter open.');
      return this.buildAllowAllDecision(tier, bucket, limit, resetAt);
    }

    // Failsafe: Redis lanza (cluster failover, network blip, OOM…).
    let count: number;
    try {
      count = await this.redis.incr(key);
      // Solo seteamos TTL en el primer INCR de la ventana — INCR no extiende
      // TTL si ya existe. Hacerlo cada vez es overhead innecesario pero la
      // diferencia perf es marginal y evita una rama extra; preferimos la
      // claridad.
      await this.redis.expire(key, windowSeconds + 5);
    } catch (err) {
      this.logFailsafeOnce(
        now,
        `Redis error in rate limiter, failing open: ${(err as Error).message}`,
      );
      return this.buildAllowAllDecision(tier, bucket, limit, resetAt);
    }

    if (count > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt,
        retryAfterSeconds,
        tier,
        bucket,
      };
    }

    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt,
      tier,
      bucket,
    };
  }

  /**
   * Construye la decisión "open" usada cuando Redis no responde. Devolvemos
   * los headers del tier comunidad por defecto (más conservador para el
   * cliente — sabe que en condiciones normales el límite sería ese, pero
   * `remaining = limit` indica que nada está consumido en esta ventana).
   */
  private buildAllowAllDecision(
    tier: RateLimitTier,
    bucket: RateLimitBucket,
    limit: number,
    resetAt: Date,
  ): RateLimitDecision {
    return {
      allowed: true,
      limit,
      remaining: limit,
      resetAt,
      tier,
      bucket,
    };
  }

  private logFailsafeOnce(now: Date, message: string): void {
    const t = now.getTime();
    if (t - this.lastFailsafeLogAt < 60_000) return;
    this.lastFailsafeLogAt = t;
    if (this.logger) {
      this.logger.warn(message);
    } else {
      // Fallback silencioso; el wrapper de Nest siempre inyecta logger pero
      // los tests pueden omitirlo.
      // eslint-disable-next-line no-console
      console.warn(`[RateLimitService] ${message}`);
    }
  }
}

/**
 * Re-export de defaults para callers que prefieran no construir el service
 * solo para leer las cifras (ej. tests, snapshots).
 */
export { DEFAULT_RATE_LIMIT_CONFIG };
