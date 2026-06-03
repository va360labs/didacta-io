/**
 * Tests del cliente HTTP `adminTenantsApi` — cobertura mínima del flow que
 * usa la tarjeta de Identidad del tenant (alpha.78):
 *  - `getOne` envía GET con bearer al path correcto.
 *  - `rename` envía PATCH con body `{ name }` al path correcto.
 *  - El error 400 del backend (validación Zod) se propaga como
 *    `ApiHttpError` con el mensaje preservado.
 *
 * No testeamos `list`/`create`/`setStatus`/`addDomain`/`removeDomain` aquí
 * porque ya tienen cobertura indirecta vía los E2E de tenants
 * (`apps/e2e/tests/admin-tenants-*.spec.ts`); este file foca en lo nuevo.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiHttpError } from './api-client';
import { adminTenantsApi, type TenantListItem } from './admin-tenants';

const FAKE_TOKEN = 'fake-bearer-token';

const SAMPLE_TENANT: TenantListItem = {
  id: 'tenant-id-1',
  slug: 'acme',
  name: 'Acme Corp Training',
  status: 'ACTIVE',
  createdAt: '2026-05-01T10:00:00.000Z',
  domains: [{ hostname: 'acme.didacta.app', isPrimary: true, isVerified: true }],
  userCount: 12,
  courseCount: 3,
};

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe('adminTenantsApi.getOne', () => {
  it('hace GET /api/v1/admin/tenants/:id con bearer y devuelve el DTO', async () => {
    mockOk(SAMPLE_TENANT);

    const result = await adminTenantsApi.getOne(FAKE_TOKEN, SAMPLE_TENANT.id);

    expect(result).toEqual(SAMPLE_TENANT);
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/v1/admin/tenants/${SAMPLE_TENANT.id}`);
    expect(init.method).toBe('GET');
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
  });
});

describe('adminTenantsApi.rename', () => {
  it('hace PATCH /api/v1/admin/tenants/:id con body { name } y bearer', async () => {
    const updated: TenantListItem = { ...SAMPLE_TENANT, name: 'VA360 Academy' };
    mockOk(updated);

    const result = await adminTenantsApi.rename(FAKE_TOKEN, SAMPLE_TENANT.id, 'VA360 Academy');

    expect(result).toEqual(updated);
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/v1/admin/tenants/${SAMPLE_TENANT.id}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'VA360 Academy' });
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('propaga el 400 del backend como ApiHttpError con el mensaje original', async () => {
    mock4xx(400, { message: 'name: String must contain at least 1 character(s)' });

    const captured = await adminTenantsApi.rename(FAKE_TOKEN, SAMPLE_TENANT.id, '').catch((e) => e);
    expect(captured).toBeInstanceOf(ApiHttpError);
    expect(captured).toMatchObject({
      status: 400,
      message: 'name: String must contain at least 1 character(s)',
    });
  });

  it('propaga el 403 cuando el caller no es super_admin', async () => {
    mock4xx(403, { message: 'Esta acción requiere rol super_admin.' });

    const captured = await adminTenantsApi
      .rename(FAKE_TOKEN, SAMPLE_TENANT.id, 'Nuevo nombre')
      .catch((e) => e);
    expect(captured).toBeInstanceOf(ApiHttpError);
    expect(captured).toMatchObject({
      status: 403,
      message: 'Esta acción requiere rol super_admin.',
    });
  });
});
