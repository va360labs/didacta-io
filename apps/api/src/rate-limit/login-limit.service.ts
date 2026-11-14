/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Contadores del limitador del acceso (ver `login-limit.types.ts`).
 *
 * El intento se cuenta ANTES de llamar al handler y, si sale bien, se
 * descuenta. Contar después dejaría pasar una ráfaga en paralelo entera (todas
 * las peticiones verían el contador a cero); contando antes, la petición que
 * pasa del tope se corta aunque las anteriores aún no hayan terminado.
 *
 * Failsafe igual que el cupo general: sin Redis, o si Redis falla, se deja
 * pasar. Preferimos servir el login a tirarlo por un limitador caído.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { RATE_LIMIT_REDIS_TOKEN } from './rate-limit.service';
import {
  resolveLoginLimitConfig,
  type LoginLimitConfig,
  type LoginLimitPolicy,
} from './login-limit.types';

/** Lo que el limitador necesita de Redis (IORedis lo cumple tal cual). */
export interface LoginLimitRedisClient {
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  del(key: string): Promise<number>;
}

/** Claves de un intento: la de la IP y la de la cuenta (las dos opcionales). */
export interface LoginAttemptKeys {
  ip: string | null;
  account: string | null;
}

export type LoginLimitCheck =
  | { allowed: true; counted: { ip: boolean; account: boolean } }
  | { allowed: false; retryAfterSeconds: number };

@Injectable()
export class LoginLimitService {
  private readonly config: LoginLimitConfig;
  private lastFailsafeLogAt = 0;

  constructor(
    @Optional()
    @Inject(RATE_LIMIT_REDIS_TOKEN)
    private readonly redis: LoginLimitRedisClient | null = null,
    @Optional() private readonly logger?: PinoLogger,
  ) {
    this.config = resolveLoginLimitConfig();
  }

  getConfig(): LoginLimitConfig {
    return this.config;
  }

  /**
   * Cuenta el intento y dice si cabe. Primero la IP: si está agotada no se
   * toca la cuenta (un atacante sin cupo no puede seguir sumando fallos a la
   * víctima). El 429 lleva la espera de la clave que lo corta.
   */
  async begin(keys: LoginAttemptKeys, now: number = Date.now()): Promise<LoginLimitCheck> {
    if (!this.redis) {
      this.failsafe(now, 'Redis client not configured — login limiter open.');
      return { allowed: true, counted: { ip: false, account: false } };
    }
    try {
      const counted = { ip: false, account: false };
      if (keys.ip) {
        const wait = await this.hit(
          `loginlimit:ip:${keys.ip}`,
          this.config.ipMax,
          this.config.ipWindowSeconds,
        );
        if (wait !== null) return { allowed: false, retryAfterSeconds: wait };
        counted.ip = true;
      }
      if (keys.account) {
        const wait = await this.hit(
          `loginlimit:acct:${keys.account}`,
          this.config.accountMax,
          this.config.accountWindowSeconds,
        );
        if (wait !== null) return { allowed: false, retryAfterSeconds: wait };
        counted.account = true;
      }
      return { allowed: true, counted };
    } catch (err) {
      this.failsafe(now, `Redis error in login limiter, failing open: ${(err as Error).message}`);
      return { allowed: true, counted: { ip: false, account: false } };
    }
  }

  /**
   * El intento salió bien (o falló el servidor, que no es culpa de quien
   * entra): se descuenta lo que `begin` sumó, según la política. Con
   * `countOn: 'always'` no se descuenta nada.
   */
  async settle(
    keys: LoginAttemptKeys,
    counted: { ip: boolean; account: boolean },
    policy: LoginLimitPolicy,
    outcome: 'success' | 'server-error',
  ): Promise<void> {
    if (!this.redis || policy.countOn === 'always') return;
    try {
      if (counted.ip && keys.ip) await this.redis.decr(`loginlimit:ip:${keys.ip}`);
      if (counted.account && keys.account) {
        const key = `loginlimit:acct:${keys.account}`;
        if (outcome === 'success' && policy.resetAccountOnSuccess) await this.redis.del(key);
        else await this.redis.decr(key);
      }
    } catch {
      // Un descuento perdido solo adelanta el bloqueo un intento: no se rompe nada.
    }
  }

  /** INCR con la ventana anclada al primero. `null` si cabe; si no, la espera. */
  private async hit(key: string, max: number, windowSeconds: number): Promise<number | null> {
    const redis = this.redis!;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds);
    if (count <= max) return null;
    let ttl = await redis.ttl(key);
    if (ttl < 0) {
      // Clave sin caducidad (se cayó el proceso entre el INCR y el EXPIRE):
      // sin esto sería un bloqueo para siempre.
      await redis.expire(key, windowSeconds);
      ttl = windowSeconds;
    }
    return Math.max(1, ttl);
  }

  private failsafe(now: number, message: string): void {
    if (now - this.lastFailsafeLogAt < 60_000) return;
    this.lastFailsafeLogAt = now;
    if (this.logger) this.logger.warn(message);
    else console.warn(`[LoginLimitService] ${message}`);
  }
}
