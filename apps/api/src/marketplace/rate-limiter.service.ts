/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { Injectable, Logger } from '@nestjs/common';

/**
 * Token bucket rate limiter por `(módulo, host)` para el cliente HTTP
 * saliente de los módulos del marketplace (alpha.49 — task 4).
 *
 * Por qué token bucket vs leaky bucket vs sliding window:
 *  - Token bucket permite RÁFAGAS cortas (burst) sobre el rate medio,
 *    útil para cargar las primeras N páginas de un endpoint en paralelo
 *    sin pausa, y luego pacing constante.
 *  - El módulo solo invoca `await acquire()` antes de cada request. Si
 *    el bucket está vacío, el await queda pendiente hasta que el refill
 *    timer entregue el siguiente token. NO busy-wait.
 *  - El rate limiter NO conoce nada del HTTP — solo entrega tokens. La
 *    composición con `SandboxedHttp` la hace `RateLimitedHttp` (clase
 *    wrapper en este mismo archivo).
 *
 * State es en-memoria, scoped al proceso. Aceptable porque:
 *  1. El marketplace corre en un solo proceso de NestJS (alpha actual).
 *  2. Si en el futuro hay HA con N réplicas, cada una tendrá su propio
 *     bucket — el upstream verá hasta N×rps en agregado. Mitigación
 *     futura: backend Redis con `INCR + EXPIRE` (sliding window).
 *
 * GC: las entradas inactivas se borran después de `IDLE_TTL_MS` para no
 * acumular memoria si un usuario instala/desinstala módulos. El timer de
 * GC corre cada `GC_INTERVAL_MS` y borra entradas no tocadas en el TTL.
 */

const IDLE_TTL_MS = 60 * 60 * 1000; // 1h
const GC_INTERVAL_MS = 10 * 60 * 1000; // 10min
const MAX_429_RETRIES = 3;
const BACKOFF_MIN_MS = 100;
const BACKOFF_MAX_MS = 5_000;

export interface RateLimitConfig {
  requestsPerSecond: number;
  burst: number;
}

interface BucketState {
  tokens: number;
  lastRefill: number; // ms epoch
  lastUsed: number; // ms epoch — para GC
  /// Cooldown hasta este timestamp (ms epoch). Si > now, drainamos el
  /// bucket completo (no entregamos tokens hasta que pase). Lo setea
  /// `applyRetryAfter()` cuando el upstream responde 429.
  cooldownUntil: number;
}

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly buckets = new Map<string, BucketState>();
  private gcTimer?: NodeJS.Timeout;

  constructor() {
    this.gcTimer = setInterval(() => this.gc(), GC_INTERVAL_MS);
    this.gcTimer.unref();
  }

  /// Test/teardown helper. Detiene el timer de GC y vacía el state.
  /// NestJS lifecycle puede cerrarlo automáticamente; los tests lo llaman
  /// explícitamente.
  reset(): void {
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.gcTimer = undefined;
    this.buckets.clear();
  }

  /// Adquiere un token para `(moduleName, host)`. Si el bucket está vacío
  /// o en cooldown, espera hasta que haya disponibilidad. NUNCA falla por
  /// rate limit — solo bloquea. El timeout/cancelación lo gestiona el
  /// caller (vía AbortSignal en el wrapper HTTP).
  async acquire(moduleName: string, host: string, cfg: RateLimitConfig): Promise<void> {
    const key = bucketKey(moduleName, host);
    while (true) {
      const now = Date.now();
      const bucket = this.getOrCreate(key, cfg, now);
      bucket.lastUsed = now;

      // Cooldown post-429: drenamos a 0 hasta que pase el TTL.
      if (bucket.cooldownUntil > now) {
        const waitMs = bucket.cooldownUntil - now;
        await sleep(waitMs);
        continue;
      }

      // Refill: tokens acumulados desde el último refill, capeado a burst.
      const elapsedSec = (now - bucket.lastRefill) / 1000;
      if (elapsedSec > 0) {
        const refilled = elapsedSec * cfg.requestsPerSecond;
        bucket.tokens = Math.min(cfg.burst, bucket.tokens + refilled);
        bucket.lastRefill = now;
      }

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }

      // Bucket vacío: calculamos cuánto falta para el siguiente token y
      // dormimos exactamente ese tiempo. Min 5ms para evitar busy spin.
      const tokensNeeded = 1 - bucket.tokens;
      const waitMs = Math.max(5, Math.ceil((tokensNeeded / cfg.requestsPerSecond) * 1000));
      await sleep(waitMs);
    }
  }

  /// Aplicar Retry-After del upstream (segundos enteros o fecha HTTP).
  /// Drainamos el bucket y seteamos cooldown hasta el TS indicado.
  /// Llamar después de recibir 429 — `RateLimitedHttp` lo hace.
  applyRetryAfter(moduleName: string, host: string, retryAfterRaw: string | null): void {
    if (!retryAfterRaw) return;
    const key = bucketKey(moduleName, host);
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    const ms = parseRetryAfter(retryAfterRaw);
    if (ms <= 0) return;
    const cooldownUntil = Date.now() + ms;
    if (cooldownUntil > bucket.cooldownUntil) bucket.cooldownUntil = cooldownUntil;
    bucket.tokens = 0;
    this.logger.warn(
      `[mod:${moduleName}] upstream ${host} pidió Retry-After (${ms}ms) — bucket drenado.`,
    );
  }

  /// Telemetría: snapshot del estado para tests/debug. NO usar para
  /// decisiones de runtime — el state cambia por debajo.
  snapshot(): Array<{
    key: string;
    tokens: number;
    cooldownMsLeft: number;
    lastUsedMsAgo: number;
  }> {
    const now = Date.now();
    return Array.from(this.buckets.entries()).map(([key, b]) => ({
      key,
      tokens: b.tokens,
      cooldownMsLeft: Math.max(0, b.cooldownUntil - now),
      lastUsedMsAgo: now - b.lastUsed,
    }));
  }

  private getOrCreate(key: string, cfg: RateLimitConfig, now: number): BucketState {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: cfg.burst, lastRefill: now, lastUsed: now, cooldownUntil: 0 };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private gc(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.lastUsed > IDLE_TTL_MS) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.logger.debug?.(`GC: removidos ${removed} bucket(s) inactivos.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wrapper que compone RateLimiter + SandboxedHttp + retry/backoff en 429
// ─────────────────────────────────────────────────────────────────────────────

import {
  HttpError,
  type HttpRequestOptions,
  type HttpResponse,
  type SandboxedHttp,
} from './sandboxed-http.types';

export class RateLimitedHttp implements SandboxedHttp {
  constructor(
    private readonly inner: SandboxedHttp,
    private readonly rateLimiter: RateLimiterService,
    private readonly moduleName: string,
    private readonly cfg: RateLimitConfig,
  ) {}

  get(url: string, opts?: HttpRequestOptions): Promise<HttpResponse> {
    return this.send('get', url, opts);
  }
  post(url: string, opts?: HttpRequestOptions): Promise<HttpResponse> {
    return this.send('post', url, opts);
  }

  private async send(
    method: 'get' | 'post',
    url: string,
    opts?: HttpRequestOptions,
  ): Promise<HttpResponse> {
    const host = extractHost(url);
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await this.rateLimiter.acquire(this.moduleName, host, this.cfg);
      const resp = await this.inner[method](url, opts);
      if (resp.status !== 429) return resp;

      // 429 — aplicar Retry-After + backoff exponencial con jitter.
      this.rateLimiter.applyRetryAfter(this.moduleName, host, resp.headers['retry-after'] ?? null);
      attempt += 1;
      if (attempt > MAX_429_RETRIES) {
        throw new HttpError(
          'HTTP_RATE_LIMITED',
          `Upstream ${host} respondió 429 ${MAX_429_RETRIES} veces consecutivas — agotados los retries.`,
        );
      }
      // Si el upstream NO mandó Retry-After, hacemos backoff exponencial
      // con jitter (decorrelated) entre BACKOFF_MIN y BACKOFF_MAX.
      const hasRetryAfter = !!resp.headers['retry-after'];
      if (!hasRetryAfter) {
        const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (attempt - 1));
        const jittered = Math.floor(Math.random() * base);
        await sleep(jittered);
      }
      // Si el upstream mandó Retry-After, applyRetryAfter ya seteó el
      // cooldown — el siguiente acquire() bloqueará el tiempo necesario.
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers puros (exportados para tests)
// ─────────────────────────────────────────────────────────────────────────────

export function bucketKey(moduleName: string, host: string): string {
  return `${moduleName}::${host.toLowerCase()}`;
}

/// Parser de Retry-After: acepta segundos enteros o fecha HTTP. Devuelve
/// ms. Negativo o NaN → 0 (no aplicar cooldown).
export function parseRetryAfter(raw: string): number {
  const trimmed = raw.trim();
  // Caso entero (segundos)
  const asInt = Number(trimmed);
  if (Number.isFinite(asInt)) {
    return Math.max(0, asInt) * 1000;
  }
  // Caso fecha HTTP
  const ts = Date.parse(trimmed);
  if (Number.isFinite(ts)) {
    return Math.max(0, ts - Date.now());
  }
  return 0;
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // Si la URL es inválida, devolvemos un placeholder — el inner.send()
    // va a fallar con HTTP_INVALID_URL antes de que el rate limiter
    // afecte algo real. Usamos un key estable para no fragmentar el state.
    return '__invalid__';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
