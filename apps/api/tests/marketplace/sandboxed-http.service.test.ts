import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HTTP_DEFAULTS,
  SandboxedHttpService,
  isHostAllowed,
  isPrivateIp,
} from '../../src/marketplace/sandboxed-http.service';
import { HttpError } from '../../src/marketplace/sandboxed-http.types';
import type { ModuleHttpConfig } from '../../src/marketplace/module-manifest.schema';

/// Tests del SandboxedHttpService (alpha.49 task 3).
///
/// Capas defensivas (en orden, fail-fast):
///   1. URL parse → HTTP_INVALID_URL
///   2. Allowlist host del manifest → HTTP_BLOCKED_HOST
///   3. SSRF guard (DNS lookup + bloqueo privadas) → HTTP_BLOCKED_HOST
///   4. fetch + timeout → HTTP_TIMEOUT
///   5. Body cap streaming → HTTP_BODY_TOO_LARGE
///
/// El rate limiter NO vive aquí (task 4). Estos tests usan tiempo real
/// con timeouts cortos (50-100ms) — no fake timers.

const HTTP_OPEN: ModuleHttpConfig = {
  allowedHosts: ['*'],
  unrestrictedHosts: true,
  rateLimitPerHost: { requestsPerSecond: 5, burst: 10 },
  maxBodyBytes: 10 * 1024 * 1024,
};

const HTTP_RESTRICTED: ModuleHttpConfig = {
  allowedHosts: ['api.zoom.us', '*.cliente.com'],
  rateLimitPerHost: { requestsPerSecond: 5, burst: 10 },
  maxBodyBytes: 1024,
};

let svc: SandboxedHttpService;
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  svc = new SandboxedHttpService();
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers puros (sin red)
// ─────────────────────────────────────────────────────────────────────────────

describe('isHostAllowed', () => {
  it('wildcard "*" matchea cualquier host', () => {
    expect(isHostAllowed('api.zoom.us', ['*'])).toBe(true);
    expect(isHostAllowed('foo.bar.baz', ['*'])).toBe(true);
  });
  it('exacto matchea case-insensitive', () => {
    expect(isHostAllowed('api.zoom.us', ['api.zoom.us'])).toBe(true);
    expect(isHostAllowed('API.ZOOM.US', ['api.zoom.us'])).toBe(true);
    expect(isHostAllowed('other.zoom.us', ['api.zoom.us'])).toBe(false);
  });
  it('"*.dominio.tld" matchea subdominios pero NO el dominio raíz', () => {
    expect(isHostAllowed('foo.cliente.com', ['*.cliente.com'])).toBe(true);
    expect(isHostAllowed('a.b.cliente.com', ['*.cliente.com'])).toBe(true);
    expect(isHostAllowed('cliente.com', ['*.cliente.com'])).toBe(false);
    expect(isHostAllowed('attacker-cliente.com', ['*.cliente.com'])).toBe(false);
  });
  it('lista vacía rechaza todo', () => {
    expect(isHostAllowed('cualquier.cosa', [])).toBe(false);
  });
});

describe('isPrivateIp — IPv4', () => {
  it.each([
    '10.0.0.1',
    '10.255.255.255',
    '127.0.0.1',
    '127.0.0.53',
    '169.254.169.254', // AWS metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '0.0.0.0',
    '100.64.0.1', // CGNAT
    '224.0.0.1', // multicast
    '255.255.255.255',
  ])('bloquea %s', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1', // fuera del /12
    '172.15.255.255', // fuera del /12 por abajo
    '169.255.0.1', // 169.254 es link-local, 169.255 NO
    '99.255.255.255',
  ])('permite %s (público)', (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });
});

describe('isPrivateIp — IPv6', () => {
  it.each(['::1', '::', 'fc00::1', 'fd12::abcd', 'fe80::1', 'fea0::1', 'ff02::1'])(
    'bloquea %s',
    (ip) => {
      expect(isPrivateIp(ip)).toBe(true);
    },
  );
  it.each(['2001:db8::1', '2606:4700::1111'])('permite %s', (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });
  it('IPv4-mapped en IPv6 reaplica reglas IPv4', () => {
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SandboxedHttpService — defensa estructural (sin red real)
// ─────────────────────────────────────────────────────────────────────────────

describe('SandboxedHttpService — URL parse', () => {
  it('rechaza URL malformada con HTTP_INVALID_URL', async () => {
    const http = svc.build('mod.test', HTTP_OPEN);
    await expect(http.get('no-es-url')).rejects.toMatchObject({
      name: 'HttpError',
      code: 'HTTP_INVALID_URL',
    });
  });
  it('rechaza protocolo no soportado (ftp://)', async () => {
    const http = svc.build('mod.test', HTTP_OPEN);
    await expect(http.get('ftp://files.example.com')).rejects.toMatchObject({
      code: 'HTTP_INVALID_URL',
    });
  });
});

describe('SandboxedHttpService — allowlist host', () => {
  it('bloquea host fuera de la allowlist con HTTP_BLOCKED_HOST', async () => {
    const http = svc.build('mod.test', HTTP_RESTRICTED);
    await expect(http.get('https://malicioso.com/path')).rejects.toMatchObject({
      code: 'HTTP_BLOCKED_HOST',
    });
  });
  it('bloquea subdominio que no matchea el patrón', async () => {
    const http = svc.build('mod.test', HTTP_RESTRICTED);
    await expect(http.get('https://api.cliente.io')).rejects.toMatchObject({
      code: 'HTTP_BLOCKED_HOST',
    });
  });
});

describe('SandboxedHttpService — SSRF guard', () => {
  it('bloquea localhost', async () => {
    const http = svc.build('mod.test', HTTP_OPEN);
    await expect(http.get('http://127.0.0.1/admin')).rejects.toMatchObject({
      code: 'HTTP_BLOCKED_HOST',
    });
  });
  it('bloquea 10.0.0.1', async () => {
    const http = svc.build('mod.test', HTTP_OPEN);
    await expect(http.get('http://10.0.0.1/x')).rejects.toMatchObject({
      code: 'HTTP_BLOCKED_HOST',
    });
  });
  it('bloquea AWS metadata 169.254.169.254', async () => {
    const http = svc.build('mod.test', HTTP_OPEN);
    await expect(http.get('http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject({
      code: 'HTTP_BLOCKED_HOST',
    });
  });
  it('bloquea IPv6 loopback', async () => {
    const http = svc.build('mod.test', HTTP_OPEN);
    await expect(http.get('http://[::1]/x')).rejects.toMatchObject({
      code: 'HTTP_BLOCKED_HOST',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SandboxedHttpService — happy path con fetch mockeado
// ─────────────────────────────────────────────────────────────────────────────

function mockFetchWith(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    return handler(String(input), init);
  }) as unknown as typeof globalThis.fetch;
}

describe('SandboxedHttpService — happy path', () => {
  it('GET pasa allowlist + SSRF y devuelve response normalizado', async () => {
    mockFetchWith(() =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-wp-total': '42' },
      }),
    );
    // Necesitamos un host público real (DNS lookup ocurre). 1.1.1.1 es IP literal pública.
    const http = svc.build('mod.test', HTTP_OPEN);
    const r = await http.get('https://1.1.1.1/probe', { timeoutMs: 1000 });
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"ok":true}');
    expect(r.headers['x-wp-total']).toBe('42');
    expect(r.bytesRead).toBeGreaterThan(0);
  });

  it('inyecta User-Agent del módulo (no se puede sobreescribir)', async () => {
    let capturedHeaders: Record<string, string> = {};
    mockFetchWith((_url, init) => {
      capturedHeaders = init.headers as Record<string, string>;
      return new Response('ok', { status: 200 });
    });
    const http = svc.build('mod.migrator-learndash', HTTP_OPEN);
    await http.get('https://1.1.1.1/x', {
      headers: { 'User-Agent': 'attacker-controlled', Authorization: 'Basic abc' },
    });
    expect(capturedHeaders['User-Agent']).toBe('Didacta-Module/mod.migrator-learndash');
    expect(capturedHeaders['Authorization']).toBe('Basic abc'); // headers legítimos sí pasan
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Body cap
// ─────────────────────────────────────────────────────────────────────────────

describe('SandboxedHttpService — body cap', () => {
  it('rechaza con HTTP_BODY_TOO_LARGE si Content-Length supera el cap del manifest', async () => {
    mockFetchWith(
      () =>
        new Response('x', {
          status: 200,
          headers: { 'content-length': String(2 * 1024) },
        }),
    );
    // HTTP_RESTRICTED tiene maxBodyBytes: 1024
    const http = svc.build('mod.test', HTTP_RESTRICTED);
    await expect(http.get('https://api.zoom.us/x')).rejects.toMatchObject({
      code: 'HTTP_BODY_TOO_LARGE',
    });
  });

  it('rechaza durante el stream si supera el cap (sin Content-Length)', async () => {
    // Stream de 2 KB sin declarar Content-Length, cap del request = 1 KB.
    mockFetchWith(() => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(800));
          controller.enqueue(new Uint8Array(800));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });
    const http = svc.build('mod.test', HTTP_OPEN);
    await expect(
      http.get('https://1.1.1.1/x', { maxBodyBytes: 1024 }),
    ).rejects.toMatchObject({ code: 'HTTP_BODY_TOO_LARGE' });
  });

  it('clamp del cap del request al cap del manifest (no permite superar)', async () => {
    mockFetchWith(
      () =>
        new Response('x', {
          status: 200,
          headers: { 'content-length': String(2 * 1024) },
        }),
    );
    const http = svc.build('mod.test', HTTP_RESTRICTED);
    // El handler pide maxBodyBytes 1MB, pero el manifest cap es 1024 → debe clampar a 1024 → 2KB declarado supera → rechaza.
    await expect(
      http.get('https://api.zoom.us/x', { maxBodyBytes: 1_000_000 }),
    ).rejects.toMatchObject({ code: 'HTTP_BODY_TOO_LARGE' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Timeout
// ─────────────────────────────────────────────────────────────────────────────

describe('SandboxedHttpService — timeout', () => {
  it('aborta con HTTP_TIMEOUT si la respuesta tarda más que timeoutMs', async () => {
    mockFetchWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const reason = (init.signal as { reason?: unknown }).reason;
            const err = new Error('The operation was aborted');
            (err as unknown as { name: string }).name = 'AbortError';
            (err as unknown as { reason?: unknown }).reason = reason;
            reject(err);
          });
        }),
    );
    const http = svc.build('mod.test', HTTP_OPEN);
    await expect(
      http.get('https://1.1.1.1/slow', { timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: 'HTTP_TIMEOUT' });
  });

  it('clampa timeoutMs al cap del core (60s)', async () => {
    mockFetchWith(() => new Response('ok', { status: 200 }));
    const http = svc.build('mod.test', HTTP_OPEN);
    // Ejecutamos pidiendo timeout absurdo — debe completar normal sin esperar 1h.
    const r = await http.get('https://1.1.1.1/x', { timeoutMs: 60 * 60 * 1000 });
    expect(r.status).toBe(200);
    // Verificación indirecta: la const expone el cap → checkearlo aquí mismo.
    expect(HTTP_DEFAULTS.MAX_TIMEOUT_MS).toBe(60_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cancelación (caller signal + parent signal)
// ─────────────────────────────────────────────────────────────────────────────

describe('SandboxedHttpService — cancelación', () => {
  it('aborta con HTTP_ABORTED si el caller signal se dispara (cancel del job)', async () => {
    mockFetchWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const reason = (init.signal as { reason?: unknown }).reason;
            const err = new Error('aborted');
            (err as unknown as { name: string }).name = 'AbortError';
            (err as unknown as { reason?: unknown }).reason = reason;
            reject(err);
          });
        }),
    );
    const http = svc.build('mod.test', HTTP_OPEN);
    const ctrl = new AbortController();
    const promise = http.get('https://1.1.1.1/x', { signal: ctrl.signal, timeoutMs: 5000 });
    setTimeout(() => ctrl.abort(), 20);
    await expect(promise).rejects.toMatchObject({ code: 'HTTP_ABORTED' });
  });

  it('aborta con HTTP_ABORTED si el parent signal se dispara (cliente cerró conexión)', async () => {
    mockFetchWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            (err as unknown as { name: string }).name = 'AbortError';
            reject(err);
          });
        }),
    );
    const parent = new AbortController();
    const http = svc.build('mod.test', HTTP_OPEN, parent.signal);
    const promise = http.get('https://1.1.1.1/x', { timeoutMs: 5000 });
    setTimeout(() => parent.abort(), 20);
    await expect(promise).rejects.toMatchObject({ code: 'HTTP_ABORTED' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HttpError ergonomics
// ─────────────────────────────────────────────────────────────────────────────

describe('HttpError', () => {
  it('expone code + message + cause', () => {
    const err = new HttpError('HTTP_TIMEOUT', 'mensaje', { original: true });
    expect(err.name).toBe('HttpError');
    expect(err.code).toBe('HTTP_TIMEOUT');
    expect(err.message).toBe('mensaje');
    expect(err.cause).toEqual({ original: true });
  });
});
