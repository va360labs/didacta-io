import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * E2E del flujo de notificaciones RLPT (LMS-80).
 *
 * Cubre:
 *   1. Crear empresa bonificada de soporte (LMS-79).
 *   2. Subir NOTIFICACION_INICIAL (PDF base64) → 200 con hash + plazo +15d.
 *   3. List la devuelve con la metadata correcta.
 *   4. Subir ACUSE_RECIBO con observaciones.
 *   5. Soft-delete idempotente.
 *   6. Limpieza: borrar la empresa para no acumular fixtures entre runs.
 */

interface CompanyResponse {
  id: string;
  nif: string;
}

interface RlptResponse {
  id: string;
  tipo: string;
  fechaNotificacionAt: string;
  plazoVencimientoAt: string;
  evidenceHash: string;
  evidenceSize: number;
  observaciones: string | null;
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

test.describe('Fundae · Notificaciones RLPT (LMS-80)', () => {
  test('upload NOTIFICACION_INICIAL → list → upload ACUSE_RECIBO → delete', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const stamp = Date.now();

    // CIF tipo P válido distinto del que usa fundae-companies.spec.ts
    // para que ambos tests puedan correr en el mismo CI run sin chocar
    // por la UNIQUE (tenant, nif) que sobrevive al soft-delete.
    // Algoritmo CIF: P + 9999999 → suma 63 → control 7 → letra G.
    const NIF = 'P9999999G';
    const create = await api<CompanyResponse>('/api/v1/admin/fundae/companies', {
      method: 'POST',
      bearer,
      body: { nif: NIF, razonSocial: `Empresa RLPT ${stamp}` },
    });
    expect(create.status, 'create empresa OK').toBeLessThan(300);
    const companyId = (create.body as CompanyResponse).id;

    const pdfBase64 = Buffer.from(`PDF dummy ${stamp}`).toString('base64');
    const fechaIso = '2026-04-01T08:00:00.000Z';

    // 1) Notificación inicial
    const inicial = await api<RlptResponse>(
      `/api/v1/admin/fundae/companies/${companyId}/rlpt-notices`,
      {
        method: 'POST',
        bearer,
        body: {
          tipo: 'NOTIFICACION_INICIAL',
          fechaNotificacionAt: fechaIso,
          data: pdfBase64,
          contentType: 'application/pdf',
          filename: 'rlpt-inicial.pdf',
        },
      },
    );
    expect(inicial.status, 'subir notificación inicial').toBe(201);
    const inicialBody = inicial.body as RlptResponse;
    expect(inicialBody.tipo).toBe('NOTIFICACION_INICIAL');
    expect(inicialBody.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    // Plazo +15 días naturales sobre la fechaNotif.
    const expectedPlazo = new Date(fechaIso);
    expectedPlazo.setDate(expectedPlazo.getDate() + 15);
    expect(new Date(inicialBody.plazoVencimientoAt).toISOString()).toBe(
      expectedPlazo.toISOString(),
    );

    // 2) List devuelve la notificación.
    const list = await api<RlptResponse[]>(
      `/api/v1/admin/fundae/companies/${companyId}/rlpt-notices`,
      { bearer },
    );
    expect(list.status).toBe(200);
    expect((list.body as RlptResponse[]).some((n) => n.id === inicialBody.id)).toBe(true);

    // 3) Acuse de recibo con observaciones.
    const acuse = await api<RlptResponse>(
      `/api/v1/admin/fundae/companies/${companyId}/rlpt-notices`,
      {
        method: 'POST',
        bearer,
        body: {
          tipo: 'ACUSE_RECIBO',
          fechaNotificacionAt: '2026-04-02T10:00:00.000Z',
          data: pdfBase64,
          contentType: 'application/pdf',
          observaciones: 'Acuse firmado por la RLPT.',
        },
      },
    );
    expect(acuse.status).toBe(201);
    expect((acuse.body as RlptResponse).observaciones).toBe('Acuse firmado por la RLPT.');

    // 4) List ahora tiene 2 ordenadas por fecha desc.
    const list2 = await api<RlptResponse[]>(
      `/api/v1/admin/fundae/companies/${companyId}/rlpt-notices`,
      { bearer },
    );
    const list2Body = list2.body as RlptResponse[];
    expect(list2Body.length).toBeGreaterThanOrEqual(2);
    expect(list2Body[0]!.tipo).toBe('ACUSE_RECIBO');

    // 5) Soft-delete idempotente del acuse.
    const del1 = await api<{ deleted: true }>(
      `/api/v1/admin/fundae/companies/${companyId}/rlpt-notices/${(acuse.body as RlptResponse).id}`,
      { method: 'DELETE', bearer },
    );
    expect(del1.status).toBe(200);
    const del2 = await api<{ deleted: true }>(
      `/api/v1/admin/fundae/companies/${companyId}/rlpt-notices/${(acuse.body as RlptResponse).id}`,
      { method: 'DELETE', bearer },
    );
    expect(del2.status).toBe(200);

    // 6) Limpieza de la empresa.
    await api(`/api/v1/admin/fundae/companies/${companyId}`, {
      method: 'DELETE',
      bearer,
    });
  });
});
