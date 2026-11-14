/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Tipos y defaults del sexto piloto License SDK — gate
 * `feat:api.rate_limit.elevated`.
 *
 * Modelo (tres cubos):
 *   - `user` — tráfico con SESIÓN: un cubo por usuario (`tenantId` + `sub`).
 *     Antes no existía y toda el aula compartía UN cubo de 100/min: una clase
 *     de diez alumnos navegando a la vez se lo comía y el aula entera recibía
 *     429.
 *   - `authenticated` — el TOPE POR AULA: suma de todo el tráfico con sesión
 *     del aula, más SCIM y las claves de API (que siguen contando aquí, como
 *     siempre). Red de seguridad contra abusos, no el límite del día a día.
 *   - `public` — tráfico sin identidad, un cubo por IP del visitante.
 *   - Plan Enterprise (capability `feat:api.rate_limit.elevated`): mismas
 *     dimensiones con multiplicadores ~10x, y nunca por debajo del Community.
 *
 * Configurable vía env (todas opcionales; sin ellas, los defaults Community):
 *   - RATE_LIMIT_COMMUNITY_USER_PER_MIN    (por usuario; sin ella = el tope
 *     por aula, así que quien no la pone se queda EXACTAMENTE como estaba)
 *   - RATE_LIMIT_COMMUNITY_AUTH_PER_MIN    (tope por aula)
 *   - RATE_LIMIT_COMMUNITY_PUBLIC_PER_MIN  (por IP, sin sesión)
 *   - RATE_LIMIT_ENTERPRISE_USER_PER_MIN / _AUTH_PER_MIN / _PUBLIC_PER_MIN
 *   - RATE_LIMIT_WINDOW_SECONDS  (default 60 — ventana fija por minuto
 *     natural; ver design notes en rate-limit.service.ts)
 *
 * El acceso (login, alta, restablecer contraseña, MFA) tiene además su propio
 * limitador por IP y por cuenta: ver `login-limit.types.ts`.
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

/**
 * Tipo de bucket: `user` (por usuario con sesión), `authenticated` (tope por
 * aula, y el de SCIM y las claves de API) y `public` (por IP, sin sesión).
 */
export type RateLimitBucket = 'user' | 'authenticated' | 'public';

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
 * - `bucket`: el bucket que manda en la decisión. En el tráfico con sesión es
 *   `user` salvo que lo que se agote sea el tope del aula (`authenticated`).
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
export interface RateLimitTierConfig {
  /** Por usuario con sesión. */
  user: number;
  /** Tope por aula (todo el tráfico con sesión, SCIM y claves de API). */
  authenticated: number;
  /** Por IP, sin sesión. */
  public: number;
}

export interface RateLimitConfig {
  community: RateLimitTierConfig;
  enterprise: RateLimitTierConfig;
  /** Tamaño de la ventana en segundos. Default 60 (1 minuto). */
  windowSeconds: number;
}

/** Defaults del piloto (LMS — sexto pilote License SDK). */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  community: {
    user: 100,
    authenticated: 100,
    public: 30,
  },
  enterprise: {
    user: 1000,
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
 *
 * El tier enterprise NUNCA queda por debajo del community: es el «elevado».
 * Sin este suelo, un operador que sube el community por env (p. ej. a 100.000
 * porque su aula tiene mucho tráfico) y luego activa la licencia se encuentra
 * con que mandan los defaults enterprise (1.000 / 300): pagar el plan le BAJA
 * el límite, y lo nota como 429 en el login y en las imágenes.
 *
 * El suelo se aplica aquí y no al decidir cada petición para que la cifra sea
 * la misma en todas partes: la que se cobra en `RateLimitService` y la que
 * enseña `/admin/rate-limit/info`.
 *
 * Consecuencia: un `RATE_LIMIT_ENTERPRISE_*` puesto a propósito por DEBAJO del
 * community deja de tener efecto (vale el del community).
 */
export function resolveRateLimitConfig(): RateLimitConfig {
  const authenticated = readPositiveIntEnv(
    'RATE_LIMIT_COMMUNITY_AUTH_PER_MIN',
    DEFAULT_RATE_LIMIT_CONFIG.community.authenticated,
  );
  const community: RateLimitTierConfig = {
    // Sin variable, el límite por usuario es el mismo tope del aula: una
    // instalación que no la pone se comporta EXACTAMENTE como antes (el tope
    // del aula es el que manda), incluida la que subió el tope a 100.000.
    user: readPositiveIntEnv('RATE_LIMIT_COMMUNITY_USER_PER_MIN', authenticated),
    authenticated,
    public: readPositiveIntEnv(
      'RATE_LIMIT_COMMUNITY_PUBLIC_PER_MIN',
      DEFAULT_RATE_LIMIT_CONFIG.community.public,
    ),
  };
  return {
    community,
    enterprise: {
      user: Math.max(
        community.user,
        readPositiveIntEnv(
          'RATE_LIMIT_ENTERPRISE_USER_PER_MIN',
          DEFAULT_RATE_LIMIT_CONFIG.enterprise.user,
        ),
      ),
      authenticated: Math.max(
        community.authenticated,
        readPositiveIntEnv(
          'RATE_LIMIT_ENTERPRISE_AUTH_PER_MIN',
          DEFAULT_RATE_LIMIT_CONFIG.enterprise.authenticated,
        ),
      ),
      public: Math.max(
        community.public,
        readPositiveIntEnv(
          'RATE_LIMIT_ENTERPRISE_PUBLIC_PER_MIN',
          DEFAULT_RATE_LIMIT_CONFIG.enterprise.public,
        ),
      ),
    },
    windowSeconds: readPositiveIntEnv(
      'RATE_LIMIT_WINDOW_SECONDS',
      DEFAULT_RATE_LIMIT_CONFIG.windowSeconds,
    ),
  };
}
