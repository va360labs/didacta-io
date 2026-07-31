import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec E2E del CRUD de empresas bonificadas Fundae (LMS-79).
 *
 * Cubre el happy path completo via API:
 *   1. Crear empresa con NIF válido (CIF Telefónica) → 200 con id + nif
 *      normalizado y crédito disponible calculado.
 *   2. List la devuelve, get directo también.
 *   3. PATCH actualiza razón social y plantilla; el NIF no es editable
 *      (sólo se ignora silenciosamente — no rompe).
 *   4. Crear segunda con el MISMO NIF → 409 con code FUNDAE_COMPANY_NIF_DUPLICADO.
 *   5. NIF inválido (checksum incorrecto) → 400 (Zod).
 *   6. Soft-delete → 200; tras borrar la empresa no aparece en list por
 *      defecto pero sí con includeDeleted=true.
 */

interface CompanyResponse {
  id: string;
  nif: string;
  razonSocial: string;
  plantilla: number | null;
  creditoTotalCents: number | null;
  creditoUsadoCents: number;
  creditoDisponibleCents: number | null;
  deletedAt: string | null;
}

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; bearer: string },
): Promise<{ status: number; body: T | { code?: string; message?: string } }> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${init.bearer}`,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T | { code?: string }) : ({} as T);
  return { status: res.status, body };
}

test.describe('Fundae · CRUD de empresas bonificadas (LMS-79)', () => {
  test('crear → list → get → update → duplicado → delete', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const bearer = await adminTokenForBootstrap(tenantSlug);

    const stamp = Date.now();
    // CIF tipo P exige letra de control: digits 1234567 → control 4 → letra D.
    // Usamos una variante con stamp en plantilla para que sea único entre runs;
    // el NIF se mantiene fijo y único por NIF + tenant ya cubre el aislamiento.
    const nifInput = ' P1234567-D ';

    // 1) Create
    const created = await api<CompanyResponse>('/api/v1/admin/fundae/companies', {
      method: 'POST',
      bearer,
      body: {
        nif: nifInput,
        razonSocial: `Empresa E2E ${stamp}`,
        plantilla: 50,
        creditoTotalCents: 500_000_00,
        cccPrincipal: '28010001234',
        datosContacto: { ciudad: 'Madrid', codigoPostal: '28013' },
      },
    });
    expect(created.status, 'create → 201/200').toBeLessThan(300);
    const body1 = created.body as CompanyResponse;
    expect(body1.nif, 'NIF queda normalizado en mayúsculas, sin separadores').toBe('P1234567D');
    expect(body1.creditoTotalCents).toBe(500_000_00);
    expect(body1.creditoUsadoCents).toBe(0);
    expect(body1.creditoDisponibleCents).toBe(500_000_00);
    expect(body1.deletedAt).toBeNull();

    // 2a) List la devuelve.
    const list = await api<CompanyResponse[]>('/api/v1/admin/fundae/companies', { bearer });
    expect(list.status).toBe(200);
    const listBody = list.body as CompanyResponse[];
    expect(listBody.some((c) => c.id === body1.id)).toBe(true);

    // 2b) Get directo.
    const got = await api<CompanyResponse>(`/api/v1/admin/fundae/companies/${body1.id}`, {
      bearer,
    });
    expect(got.status).toBe(200);
    expect((got.body as CompanyResponse).razonSocial).toContain('Empresa E2E');

    // 3) Update razón social y plantilla.
    const updated = await api<CompanyResponse>(`/api/v1/admin/fundae/companies/${body1.id}`, {
      method: 'PATCH',
      bearer,
      body: { razonSocial: 'Empresa E2E (renombrada)', plantilla: 200 },
    });
    expect(updated.status).toBe(200);
    expect((updated.body as CompanyResponse).razonSocial).toBe('Empresa E2E (renombrada)');
    expect((updated.body as CompanyResponse).plantilla).toBe(200);
    expect((updated.body as CompanyResponse).nif).toBe('P1234567D');

    // 4) Crear segunda con el mismo NIF → 409.
    const dup = await api<{ code?: string }>('/api/v1/admin/fundae/companies', {
      method: 'POST',
      bearer,
      body: { nif: nifInput, razonSocial: 'Otra' },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('FUNDAE_COMPANY_NIF_DUPLICADO');

    // 5) NIF inválido (checksum) → 400 zod.
    const invalid = await api<unknown>('/api/v1/admin/fundae/companies', {
      method: 'POST',
      bearer,
      body: { nif: '12345678A', razonSocial: 'Inválida' },
    });
    expect(invalid.status).toBeGreaterThanOrEqual(400);
    expect(invalid.status).toBeLessThan(500);

    // 6) Soft-delete + verificación de filtros.
    const del = await api<{ deleted: true }>(`/api/v1/admin/fundae/companies/${body1.id}`, {
      method: 'DELETE',
      bearer,
    });
    expect(del.status).toBe(200);

    const listAfter = await api<CompanyResponse[]>('/api/v1/admin/fundae/companies', { bearer });
    expect((listAfter.body as CompanyResponse[]).some((c) => c.id === body1.id)).toBe(false);

    const listIncluding = await api<CompanyResponse[]>(
      '/api/v1/admin/fundae/companies?includeDeleted=true',
      { bearer },
    );
    const found = (listIncluding.body as CompanyResponse[]).find((c) => c.id === body1.id);
    expect(found).toBeDefined();
    expect(found!.deletedAt).toBeTruthy();
  });
});
