/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  RATE_LIMIT_REDIS_TOKEN,
  type RateLimitRedisClient,
} from '../rate-limit/rate-limit.service';

/**
 * Límite de llamadas a herramientas POR CLAVE de agente.
 *
 * El limitador global (`RateLimitInterceptor`) ya cuenta peticiones por aula,
 * pero un agente en bucle se comería el cupo de TODA el aula y dejaría a sus
 * alumnos en 429. Este va aparte, por clave, y solo cuenta `tools/call`:
 *
 *   - por minuto: frena un bucle (por defecto 60);
 *   - por hora: pone techo a una tanda larga (por defecto 600).
 *
 * Con Redis (lo normal en producción) el contador es compartido entre réplicas
 * de la API. Sin Redis NO falla abierto como el global: cuenta en memoria del
 * proceso, que es peor que compartido pero mejor que nada para algo que escribe
 * en el aula.
 */
export interface AgentRateDecision {
  allowed: boolean;
  /** Segundos hasta que se libera el cubo que ha saltado. */
  retryAfterSeconds: number;
  limit: number;
  window: 'minute' | 'hour';
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

@Injectable()
export class AgentRateLimiter {
  private readonly memory = new Map<string, { count: number; expiresAt: number }>();
  readonly perMinute = envInt('AGENT_TOOL_CALLS_PER_MIN', 60);
  readonly perHour = envInt('AGENT_TOOL_CALLS_PER_HOUR', 600);

  constructor(
    @Optional()
    @Inject(RATE_LIMIT_REDIS_TOKEN)
    private readonly redis: RateLimitRedisClient | null = null,
  ) {}

  async hit(apiKeyId: string, now: number = Date.now()): Promise<AgentRateDecision> {
    const windows: Array<{ window: 'minute' | 'hour'; seconds: number; limit: number }> = [
      { window: 'minute', seconds: 60, limit: this.perMinute },
      { window: 'hour', seconds: 3600, limit: this.perHour },
    ];
    for (const w of windows) {
      const slot = Math.floor(now / (w.seconds * 1000));
      const key = `agent-rl:${apiKeyId}:${w.window}:${slot}`;
      const count = await this.incr(key, w.seconds, now);
      if (count > w.limit) {
        const resetAt = (slot + 1) * w.seconds * 1000;
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
          limit: w.limit,
          window: w.window,
        };
      }
    }
    return { allowed: true, retryAfterSeconds: 0, limit: this.perMinute, window: 'minute' };
  }

  private async incr(key: string, ttlSeconds: number, now: number): Promise<number> {
    if (this.redis) {
      try {
        const n = await this.redis.incr(key);
        if (n === 1) await this.redis.expire(key, ttlSeconds + 5);
        return n;
      } catch {
        // Redis caído: seguimos contando en memoria, no abrimos la puerta.
      }
    }
    const entry = this.memory.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.memory.set(key, { count: 1, expiresAt: now + ttlSeconds * 1000 });
      this.gc(now);
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  /** Que el mapa en memoria no crezca sin fin con claves de ventanas pasadas. */
  private gc(now: number): void {
    if (this.memory.size < 1000) return;
    for (const [k, v] of this.memory) if (v.expiresAt <= now) this.memory.delete(k);
  }
}
