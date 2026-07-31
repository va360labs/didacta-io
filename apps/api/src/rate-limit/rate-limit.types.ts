/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tipos y defaults del sexto piloto License SDK — gate
 * `feat:api.rate_limit.elevated`.
 *
 * Modelo:
 *   - Plan Community: rate "fair" — `community.authenticated` y
 *     `community.public`. Los endpoints autenticados se identifican por
 *     `tenantId` extraído del JWT; los públicos (sin token) se cuentan
 *     todos contra un único bucket especial `'anonymous'`.
 *   - Plan Enterprise (capability `feat:api.rate_limit.elevated`): mismas
 *     dimensiones pero con multiplicadores ~10x.
 *
 * Configurable vía env (todas opcionales — si no están seteadas se usan
 * los defaults del piloto):
 *   - RATE_LIMIT_COMMUNITY_AUTH_PER_MIN
 *   - RATE_LIMIT_COMMUNITY_PUBLIC_PER_MIN
 *   - RATE_LIMIT_ENTERPRISE_AUTH_PER_MIN
 *   - RATE_LIMIT_ENTERPRISE_PUBLIC_PER_MIN
 *   - RATE_LIMIT_WINDOW_SECONDS  (default 60 — sliding window simple por
 *     minuto natural; ver design notes en rate-limit.service.ts)
 *
 * NOTA — sliding window simple vs token bucket:
 *   El piloto usa una ventana fija de 1 minuto natural (clave Redis con
 *   sufijo `<minute>`, INCR + EXPIRE). Esto es suficiente para detectar
 *   abuso obvio y cumplir el contrato "100 req/min". Tiene el costo
 *   conocido de permitir hasta 2x el rate en el cambio de minuto
 *   (29s58:60req + 30s00:60req → 120 req en 31s). Aceptable para Community
 *   donde el límite es defensivo, no SLA-bound. Para iteraciones futuras
 *   evaluar token bucket con redis-cell o sorted-set sliding-window real.
 */

import { LICENSE_CAPABILITIES, type LicenseCapability } from '@didacta/license-sdk';

/** Tier efectivo del request — comunidad o enterprise. */
export type RateLimitTier = 'community' | 'enterprise';

/** Tipo de bucket — separa autenticados de públicos. */
export type RateLimitBucket = 'authenticated' | 'public';

/**
 * Resultado de evaluar una request contra el rate limiter.
 *
 * - `allowed`: si la request debe procesarse (true) o rechazarse con 429 (false).
 * - `limit`: número máximo de requests permitidas en la ventana actual para
 *   el tier efectivo + bucket.
 * - `remaining`: requests restantes en la ventana actual (clamp a 0).
 * - `resetAt`: instante en que la ventana actual termina (sirve al header
 *   `X-RateLimit-Reset`).
 * - `retryAfterSeconds`: solo presente si `allowed === false` — segundos
 *   hasta que el cliente puede reintentar (header `Retry-After`).
 * - `tier`: tier resuelto al momento de la decisión, expuesto para logs.
 * - `bucket`: bucket usado.
 */
export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds?: number;
  tier: RateLimitTier;
  bucket: RateLimitBucket;
}

/** Configuración de límites efectiva en runtime. */
export interface RateLimitConfig {
  community: {
    authenticated: number;
    public: number;
  };
  enterprise: {
    authenticated: number;
    public: number;
  };
  /** Tamaño de la ventana en segundos. Default 60 (1 minuto). */
  windowSeconds: number;
}

/** Defaults del piloto (LMS — sexto pilote License SDK). */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  community: {
    authenticated: 100,
    public: 30,
  },
  enterprise: {
    authenticated: 1000,
    public: 300,
  },
  windowSeconds: 60,
};

/**
 * Capability EE asociada a este piloto. Re-exportada acá para que callers
 * (controllers, tests) no tengan que importar dos sitios distintos.
 */
export const RATE_LIMIT_ELEVATED_CAPABILITY: LicenseCapability =
  LICENSE_CAPABILITIES.API_RATE_LIMIT_ELEVATED;

/**
 * Lee un entero positivo de env. Si está vacío, no es número, o es <=0
 * devuelve `fallback`. No loggea — el aviso solo se emite la primera vez
 * que el service arranca.
 */
export function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Resuelve la configuración efectiva mezclando defaults del piloto con
 * overrides de env. Pensado para llamarse al construir el service o desde
 * tests para producir un config determinista.
 */
export function resolveRateLimitConfig(): RateLimitConfig {
  return {
    community: {
      authenticated: readPositiveIntEnv(
        'RATE_LIMIT_COMMUNITY_AUTH_PER_MIN',
        DEFAULT_RATE_LIMIT_CONFIG.community.authenticated,
      ),
      public: readPositiveIntEnv(
        'RATE_LIMIT_COMMUNITY_PUBLIC_PER_MIN',
        DEFAULT_RATE_LIMIT_CONFIG.community.public,
      ),
    },
    enterprise: {
      authenticated: readPositiveIntEnv(
        'RATE_LIMIT_ENTERPRISE_AUTH_PER_MIN',
        DEFAULT_RATE_LIMIT_CONFIG.enterprise.authenticated,
      ),
      public: readPositiveIntEnv(
        'RATE_LIMIT_ENTERPRISE_PUBLIC_PER_MIN',
        DEFAULT_RATE_LIMIT_CONFIG.enterprise.public,
      ),
    },
    windowSeconds: readPositiveIntEnv(
      'RATE_LIMIT_WINDOW_SECONDS',
      DEFAULT_RATE_LIMIT_CONFIG.windowSeconds,
    ),
  };
}
