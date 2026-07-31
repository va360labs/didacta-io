import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RateLimitedHttp,
  RateLimiterService,
  bucketKey,
  parseRetryAfter,
} from '../../src/marketplace/rate-limiter.service';
import type {
  HttpRequestOptions,
  HttpResponse,
  SandboxedHttp,
} from '../../src/marketplace/sandboxed-http.types';

/// Tests del RateLimiterService + RateLimitedHttp wrapper (alpha.49 task 4).
///
/// Token bucket:
///   - acquire() bloquea hasta tener token disponible.
///   - El bucket se rellena a `requestsPerSecond` tokens/seg, capeado a `burst`.
///   - 429 del upstream → drena el bucket por `Retry-After` segundos +
///     backoff exponencial con jitter en los siguientes retries.
///   - Tras MAX_429_RETRIES (3) → HTTP_RATE_LIMITED.
///
/// Usa fake timers para tests determinísticos del bucket. El test del
/// wrapper con 429 corre con tiempo real porque el backoff usa Math.random
/// y Math.random no es controlable con fake timers.

let limiter: RateLimiterService;

beforeEach(() => {
  limiter = new RateLimiterService();
});

afterEach(() => {
  limiter.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers puros
// ─────────────────────────────────────────────────────────────────────────────

describe('bucketKey', () => {
  it('compone la key como "<module>::<host>" con host en lowercase', () => {
    expect(bucketKey('mod.x', 'API.Zoom.US')).toBe('mod.x::api.zoom.us');
  });
});

describe('parseRetryAfter', () => {
  it('segundos enteros → ms', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('  120  ')).toBe(120_000);
  });
  it('cero o negativo → 0', () => {
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('-5')).toBe(0);
  });
  it('fecha HTTP → ms hasta ese instante', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(50_000);
    expect(ms).toBeLessThan(70_000);
  });
  it('garbage → 0', () => {
    expect(parseRetryAfter('lo que sea')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Token bucket — acquire() con fake timers
// ─────────────────────────────────────────────────────────────────────────────

describe('RateLimiterService.acquire — token bucket', () => {
  it('bucket arranca lleno a `burst`, las primeras `burst` reqs no bloquean', async () => {
    vi.useFakeTimers();
    const cfg = { requestsPerSecond: 5, burst: 3 };
    // Tres acquire() inmediatos sin avanzar el tiempo.
    await limiter.acquire('mod.x', 'api.example.com', cfg);
    await limiter.acquire('mod.x', 'api.example.com', cfg);
    await limiter.acquire('mod.x', 'api.example.com', cfg);
    const snap = limiter.snapshot()[0]!;
    expect(snap.tokens).toBeLessThan(1);
  });

  it('cuarta request bloquea hasta el siguiente refill (rps=5 → ~200ms por token)', async () => {
    vi.useFakeTimers();
    const cfg = { requestsPerSecond: 5, burst: 3 };
    // Drena el bucket
    await limiter.acquire('mod.x', 'host.com', cfg);
    await limiter.acquire('mod.x', 'host.com', cfg);
    await limiter.acquire('mod.x', 'host.com', cfg);
    // Cuarta queda pendiente
    const fourth = limiter.acquire('mod.x', 'host.com', cfg);
    let resolved = false;
    fourth.then(() => {
      resolved = true;
    });
    // Antes de avanzar tiempo, NO debe estar resuelta
    await vi.advanceTimersByTimeAsync(50);
    expect(resolved).toBe(false);
    // Avanzamos ~200ms más → debería resolver (5rps = un token cada 200ms)
    await vi.advanceTimersByTimeAsync(250);
    await fourth;
    expect(resolved).toBe(true);
  });

  it('keys distintos (módulo o host) usan buckets independientes', async () => {
    vi.useFakeTimers();
    const cfg = { requestsPerSecond: 1, burst: 1 };
    await limiter.acquire('mod.a', 'host.com', cfg);
    // Otra key — no debe bloquear aunque mod.a haya consumido su token
    await limiter.acquire('mod.b', 'host.com', cfg);
    await limiter.acquire('mod.a', 'other.com', cfg);
    expect(limiter.snapshot()).toHaveLength(3);
  });

  it('host es case-insensitive en la key', async () => {
    vi.useFakeTimers();
    // burst 2 para que ambos acquire pasen sin pacing — el test verifica
    // sólo que la key se normaliza, NO el rate limiting.
    const cfg = { requestsPerSecond: 10, burst: 2 };
    await limiter.acquire('mod.x', 'API.Example.com', cfg);
    await limiter.acquire('mod.x', 'api.example.COM', cfg);
    expect(limiter.snapshot()).toHaveLength(1);
    expect(limiter.snapshot()[0]?.key).toBe('mod.x::api.example.com');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cooldown post-429
// ─────────────────────────────────────────────────────────────────────────────

describe('RateLimiterService.applyRetryAfter', () => {
  it('drena el bucket y bloquea acquire() hasta que pase el cooldown', async () => {
    vi.useFakeTimers();
    const cfg = { requestsPerSecond: 10, burst: 5 };
    await limiter.acquire('mod.x', 'host.com', cfg);
    limiter.applyRetryAfter('mod.x', 'host.com', '2'); // 2s
    const snap = limiter.snapshot()[0]!;
    expect(snap.tokens).toBe(0);
    expect(snap.cooldownMsLeft).toBeGreaterThan(1500);

    const next = limiter.acquire('mod.x', 'host.com', cfg);
    let resolved = false;
    next.then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    await next;
    expect(resolved).toBe(true);
  });

  it('Retry-After no extiende cooldown si el actual es mayor', async () => {
    vi.useFakeTimers();
    const cfg = { requestsPerSecond: 10, burst: 5 };
    await limiter.acquire('mod.x', 'host.com', cfg);
    limiter.applyRetryAfter('mod.x', 'host.com', '10'); // 10s
    const before = limiter.snapshot()[0]!.cooldownMsLeft;
    limiter.applyRetryAfter('mod.x', 'host.com', '2'); // 2s — menor, no extiende
    const after = limiter.snapshot()[0]!.cooldownMsLeft;
    expect(after).toBeGreaterThanOrEqual(before - 50); // tolerancia 50ms
  });

  it('Retry-After con header inválido es no-op', () => {
    const cfg = { requestsPerSecond: 1, burst: 1 };
    void limiter.acquire('mod.x', 'host.com', cfg);
    const tokensBefore = limiter.snapshot()[0]?.tokens ?? 1;
    limiter.applyRetryAfter('mod.x', 'host.com', null);
    limiter.applyRetryAfter('mod.x', 'host.com', 'garbage');
    const tokensAfter = limiter.snapshot()[0]?.tokens ?? 1;
    expect(tokensAfter).toBeCloseTo(tokensBefore, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RateLimitedHttp wrapper
// ─────────────────────────────────────────────────────────────────────────────

function mockInner(handler: (url: string) => Partial<HttpResponse>): SandboxedHttp {
  const wrap = (method: 'GET' | 'POST') => async (url: string, _opts?: HttpRequestOptions) => {
    const r = handler(url);
    return {
      status: r.status ?? 200,
      headers: r.headers ?? {},
      body: r.body ?? '',
      bytesRead: r.bytesRead ?? 0,
    };
  };
  return { get: wrap('GET'), post: wrap('POST') };
}

describe('RateLimitedHttp wrapper', () => {
  it('happy path: invoca el inner una vez con response 200', async () => {
    const inner = mockInner(() => ({ status: 200, body: '{"ok":true}' }));
    const wrapped = new RateLimitedHttp(inner, limiter, 'mod.x', {
      requestsPerSecond: 100,
      burst: 100,
    });
    const r = await wrapped.get('https://api.example.com/x');
    expect(r.status).toBe(200);
  });

  it('429 con Retry-After bajo → reintenta y eventualmente devuelve 200', async () => {
    let calls = 0;
    const inner = mockInner(() => {
      calls += 1;
      if (calls === 1) return { status: 429, headers: { 'retry-after': '0' } };
      return { status: 200, body: 'ok' };
    });
    const wrapped = new RateLimitedHttp(inner, limiter, 'mod.x', {
      requestsPerSecond: 100,
      burst: 100,
    });
    const r = await wrapped.get('https://api.example.com/x');
    expect(r.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('429 persistente → HTTP_RATE_LIMITED tras 3 retries', async () => {
    const inner = mockInner(() => ({ status: 429, headers: { 'retry-after': '0' } }));
    const wrapped = new RateLimitedHttp(inner, limiter, 'mod.x', {
      requestsPerSecond: 100,
      burst: 100,
    });
    await expect(wrapped.get('https://api.example.com/x')).rejects.toMatchObject({
      name: 'HttpError',
      code: 'HTTP_RATE_LIMITED',
    });
  });

  it('429 sin Retry-After hace backoff exponencial con jitter (todos los reintentos resuelven en menos de 30s)', async () => {
    let calls = 0;
    const inner = mockInner(() => {
      calls += 1;
      if (calls < 3) return { status: 429 };
      return { status: 200, body: 'ok' };
    });
    const wrapped = new RateLimitedHttp(inner, limiter, 'mod.x', {
      requestsPerSecond: 100,
      burst: 100,
    });
    const start = Date.now();
    const r = await wrapped.get('https://api.example.com/x');
    const elapsed = Date.now() - start;
    expect(r.status).toBe(200);
    expect(calls).toBe(3);
    // backoff: max 100, 200, 400, 800ms — total bajo 2s.
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);

  it('rate limit pace múltiples requests (rps=2, burst=1, 3 reqs → ~1s)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const inner = mockInner(() => ({ status: 200, body: 'ok' }));
    const wrapped = new RateLimitedHttp(inner, limiter, 'mod.x', {
      requestsPerSecond: 2,
      burst: 1,
    });
    const start = Date.now();
    await Promise.all([
      wrapped.get('https://api.example.com/a'),
      wrapped.get('https://api.example.com/b'),
      wrapped.get('https://api.example.com/c'),
    ]);
    const elapsed = Date.now() - start;
    // Burst 1 → la primera pasa instantáneamente, las otras 2 esperan
    // 500ms cada una = ~1000ms total.
    expect(elapsed).toBeGreaterThanOrEqual(800);
  });

  it('host extraído del URL es usado en la key del bucket', async () => {
    const inner = mockInner(() => ({ status: 200, body: 'ok' }));
    const wrapped = new RateLimitedHttp(inner, limiter, 'mod.x', {
      requestsPerSecond: 100,
      burst: 100,
    });
    await wrapped.get('https://api.cliente.com/x?q=1');
    const snap = limiter.snapshot();
    expect(snap[0]?.key).toBe('mod.x::api.cliente.com');
  });
});
