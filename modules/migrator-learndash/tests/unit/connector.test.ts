import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ApplicationPasswordAuth,
  AuthFailedError,
  RateLimitExceededError,
  RestConnector,
  TokenBucket,
  paginate,
  defaultRetry,
} from '../../src/connector/index.js';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe('ApplicationPasswordAuth', () => {
  it('produce header Basic con base64 correcto', () => {
    const auth = new ApplicationPasswordAuth('admin', 'app pass word');
    const header = auth.headers().Authorization;
    expect(header).toMatch(/^Basic /);
    const decoded = Buffer.from(header!.replace('Basic ', ''), 'base64').toString('utf8');
    expect(decoded).toBe('admin:app pass word');
  });

  it('rechaza credenciales vacías', () => {
    expect(() => new ApplicationPasswordAuth('', 'x')).toThrow(/username/);
    expect(() => new ApplicationPasswordAuth('x', '')).toThrow(/appPassword/);
  });
});

describe('TokenBucket', () => {
  it('permite N llamadas inmediatas hasta capacity', async () => {
    const bucket = new TokenBucket(100, 5);
    const t0 = Date.now();
    for (let i = 0; i < 5; i += 1) await bucket.acquire();
    expect(Date.now() - t0).toBeLessThan(50);
  });
});

describe('RestConnector — request', () => {
  beforeEach(() => vi.useRealTimers());

  it('hace GET y devuelve JSON', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const c = new RestConnector({
      baseUrl: 'https://example.test',
      auth: new ApplicationPasswordAuth('u', 'p'.repeat(8)),
      logger: noopLogger,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const res = await c.request<unknown[]>('GET', '/wp-json/');
    expect(res).toEqual([{ id: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('mappea 401 a AuthFailedError', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('{"code":"unauthorized"}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const c = new RestConnector({
      baseUrl: 'https://example.test',
      auth: new ApplicationPasswordAuth('u', 'p'.repeat(8)),
      logger: noopLogger,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(c.request('GET', '/wp-json/wp/v2/users')).rejects.toBeInstanceOf(AuthFailedError);
  });

  it('reintenta 429 respetando Retry-After', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('{}', {
          status: 429,
          headers: { 'retry-after': '0', 'content-type': 'application/json' },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const c = new RestConnector({
      baseUrl: 'https://example.test',
      auth: new ApplicationPasswordAuth('u', 'p'.repeat(8)),
      logger: noopLogger,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const res = await c.request<{ ok: boolean }>('GET', '/wp-json/');
    expect(res).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('AbortSignal del caller cancela', async () => {
    const fetchMock = vi.fn(async (_url, opts: RequestInit) => {
      // Simular cuelgue largo
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 5_000);
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
      return new Response('{}', { status: 200 });
    });
    const c = new RestConnector({
      baseUrl: 'https://example.test',
      auth: new ApplicationPasswordAuth('u', 'p'.repeat(8)),
      logger: noopLogger,
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeoutMs: 1_000,
    });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    await expect(c.request('GET', '/wp-json/', { signal: ctrl.signal })).rejects.toThrow();
  });
});

describe('paginate', () => {
  it('itera 3 páginas según X-WP-Total', async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = new URL(url as string);
      const page = Number(u.searchParams.get('page') ?? '1');
      const items =
        page === 1
          ? Array.from({ length: 100 }, (_v, i) => ({ id: i + 1 }))
          : page === 2
            ? Array.from({ length: 100 }, (_v, i) => ({ id: 100 + i + 1 }))
            : Array.from({ length: 50 }, (_v, i) => ({ id: 200 + i + 1 }));
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'X-WP-Total': '250',
          'X-WP-TotalPages': '3',
        },
      });
    });
    const c = new RestConnector({
      baseUrl: 'https://example.test',
      auth: new ApplicationPasswordAuth('u', 'p'.repeat(8)),
      logger: noopLogger,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const batches: number[] = [];
    let total: number | undefined;
    for await (const b of paginate<{ id: number }>(c, '/wp-json/wp/v2/users', {
      strategy: 'page-number',
      perPage: 100,
    })) {
      batches.push(b.items.length);
      total = b.total;
      if (b.done) break;
    }
    expect(batches).toEqual([100, 100, 50]);
    expect(total).toBe(250);
  });
});

describe('defaultRetry', () => {
  it('reintenta 5xx hasta 5 intentos', () => {
    const resp = new Response(null, { status: 503 });
    expect(defaultRetry.shouldRetry(0, undefined, resp)).toBe(true);
    expect(defaultRetry.shouldRetry(4, undefined, resp)).toBe(true);
    expect(defaultRetry.shouldRetry(5, undefined, resp)).toBe(false);
  });
  it('NO reintenta 4xx (excepto 429)', () => {
    expect(defaultRetry.shouldRetry(0, undefined, new Response(null, { status: 401 }))).toBe(false);
    expect(defaultRetry.shouldRetry(0, undefined, new Response(null, { status: 429 }))).toBe(true);
  });
});
