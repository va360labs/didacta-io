/**
 * Tests del cliente HTTP `adminSmtpApi` + del derivador `deriveSmtpStatus`.
 *
 * Cobertura:
 *  - get / upsert / test → URL, método, header bearer, body.
 *  - upsert mantiene `password` opcional (vacío o ausente del payload).
 *  - test propaga el 400 con el mensaje del MTA como `ApiHttpError`.
 *  - deriveSmtpStatus mapea los 4 estados (verified, unverified, fallback, none).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiHttpError } from './api-client';
import { adminSmtpApi, deriveSmtpStatus, type AdminSmtpDto } from './admin-smtp';

const FAKE_TOKEN = 'fake-bearer-token';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(vi.fn());
  // Mockeamos sessionStorage para que `authStorage.getAccessToken` devuelva
  // un token y no tire 401 en cada test.
  const store = new Map<string, string>();
  store.set('didacta.access_token', FAKE_TOKEN);
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  // Definimos `window` para que `authStorage` no caiga al branch SSR.
  vi.stubGlobal('window', globalThis);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockOk<T>(payload: T): void {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function mock4xx(status: number, body: { message: string; code?: string }): void {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('adminSmtpApi.get', () => {
  it('hace GET /api/v1/admin/tenant-settings/smtp con bearer', async () => {
    const dto: AdminSmtpDto = {
      host: 'smtp.example.com',
      port: 587,
      secure: true,
      username: 'apikey',
      hasPassword: true,
      fromEmail: 'noreply@example.com',
      fromName: 'Didacta',
      verifiedAt: '2026-06-02T10:00:00.000Z',
      verifiedByUserId: 'user-1',
      hasTenantConfig: true,
      hasGlobalFallback: false,
    };
    mockOk(dto);

    const result = await adminSmtpApi.get();
    expect(result).toEqual(dto);

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/admin/tenant-settings/smtp');
    expect(init.method).toBe('GET');
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
  });
});

describe('adminSmtpApi.upsert', () => {
  it('envía PUT con el body exacto y bearer', async () => {
    mockOk({
      host: 'smtp.example.com',
      port: 587,
      secure: true,
      username: 'apikey',
      hasPassword: true,
      fromEmail: 'noreply@example.com',
      fromName: 'Didacta',
      verifiedAt: null,
      verifiedByUserId: null,
      hasTenantConfig: true,
      hasGlobalFallback: false,
    });

    await adminSmtpApi.upsert({
      host: 'smtp.example.com',
      port: 587,
      secure: true,
      username: 'apikey',
      password: 'secret-xyz',
      fromEmail: 'noreply@example.com',
      fromName: 'Didacta',
    });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/admin/tenant-settings/smtp');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: true,
      username: 'apikey',
      password: 'secret-xyz',
      fromEmail: 'noreply@example.com',
      fromName: 'Didacta',
    });
  });

  it('permite omitir password (conservar el actual)', async () => {
    mockOk({
      host: 'smtp.example.com',
      port: 587,
      secure: true,
      username: 'apikey',
      hasPassword: true,
      fromEmail: 'noreply@example.com',
      fromName: null,
      verifiedAt: null,
      verifiedByUserId: null,
      hasTenantConfig: true,
      hasGlobalFallback: false,
    });

    await adminSmtpApi.upsert({
      host: 'smtp.example.com',
      port: 587,
      secure: true,
      username: 'apikey',
      fromEmail: 'noreply@example.com',
    });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const parsed = JSON.parse(init.body as string);
    expect(parsed).not.toHaveProperty('password');
  });
});

describe('adminSmtpApi.test', () => {
  it('envía POST a /smtp/test con toEmail', async () => {
    mockOk({
      ok: true,
      sentTo: 'admin@example.com',
      messageId: 'msg-123',
      verifiedAt: '2026-06-02T10:00:00.000Z',
    });

    await adminSmtpApi.test('admin@example.com');

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain('/api/v1/admin/tenant-settings/smtp/test');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ toEmail: 'admin@example.com' });
  });

  it('propaga 400 del MTA como ApiHttpError con el message', async () => {
    mock4xx(400, { message: 'SMTP falló: connection refused on smtp.example.test:587' });

    const captured = await adminSmtpApi.test('admin@example.com').catch((e) => e);
    expect(captured).toBeInstanceOf(ApiHttpError);
    expect(captured).toMatchObject({
      status: 400,
      message: 'SMTP falló: connection refused on smtp.example.test:587',
    });
  });
});

describe('deriveSmtpStatus', () => {
  const base: AdminSmtpDto = {
    host: null,
    port: null,
    secure: null,
    username: null,
    hasPassword: false,
    fromEmail: null,
    fromName: null,
    verifiedAt: null,
    verifiedByUserId: null,
    hasTenantConfig: false,
    hasGlobalFallback: false,
  };

  it('verified: hasTenantConfig + verifiedAt → "verified"', () => {
    expect(
      deriveSmtpStatus({
        ...base,
        hasTenantConfig: true,
        hasPassword: true,
        verifiedAt: '2026-06-02T10:00:00.000Z',
      }),
    ).toBe('verified');
  });

  it('configured-unverified: hasTenantConfig sin verifiedAt → "configured-unverified"', () => {
    expect(
      deriveSmtpStatus({ ...base, hasTenantConfig: true, hasPassword: true, verifiedAt: null }),
    ).toBe('configured-unverified');
  });

  it('fallback: sin tenant config pero con env globales → "fallback"', () => {
    expect(deriveSmtpStatus({ ...base, hasTenantConfig: false, hasGlobalFallback: true })).toBe(
      'fallback',
    );
  });

  it('none: sin tenant config ni fallback → "none"', () => {
    expect(deriveSmtpStatus({ ...base, hasTenantConfig: false, hasGlobalFallback: false })).toBe(
      'none',
    );
  });
});
