import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * E2E del endpoint de "Comunicación de inicio de grupo" Fundae (LMS-83).
 *
 * Cubre:
 *   1. Setup: empresa + acción + grupo + 1 participante (admin como user).
 *   2. GET /admin/fundae/groups/:id/start-xml → 200 con
 *      Content-Type application/xml.
 *   3. El XML contiene el código de acción, número de grupo, NIF empresa
 *      y el bloque <participantesIniciales total="1">.
 *   4. 404 sobre groupId inexistente.
 *
 * NIF empresa: V12345674 (CIF tipo V con checksum válido, no usado en otros specs).
 */

interface IdRes {
  id: string;
}
interface ErrRes {
  code?: string;
  message?: string;
}

async function jsonApi<T>(
  path: string,
  init: { method?: string; body?: unknown; bearer: string },
): Promise<{ status: number; body: T | ErrRes }> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${init.bearer}`,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T | ErrRes) : ({} as T);
  return { status: res.status, body };
}

function decodeJwtSub(jwt: string): string {
  const [, payload] = jwt.split('.');
  if (!payload) throw new Error('JWT inválido');
  const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  return String(parsed.sub);
}

test.describe('Fundae · XML inicio de grupo (LMS-83)', () => {
  test('genera XML válido con datos hidratados de DB', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const stamp = Date.now();
    const adminUserId = decodeJwtSub(bearer);

    // Cleanup defensivo: si un run anterior dejó la empresa V12345674
    // viva por un fallo previo al cleanup-end, la borramos antes de
    // empezar para que el create no choque con UNIQUE NIF + tenant.
    const existing = await jsonApi<Array<IdRes>>(
      '/api/v1/admin/fundae/companies?search=V12345674&includeDeleted=true',
      { bearer },
    );
    if (Array.isArray(existing.body)) {
      for (const c of existing.body as Array<IdRes>) {
        await jsonApi(`/api/v1/admin/fundae/companies/${c.id}`, { method: 'DELETE', bearer });
      }
    }

    // Setup: empresa + acción + grupo
    const company = await jsonApi<IdRes>('/api/v1/admin/fundae/companies', {
      method: 'POST',
      bearer,
      body: {
        nif: 'V12345674',
        razonSocial: `Empresa XML ${stamp}`,
        cccPrincipal: '28010099999',
        plantilla: 25,
        creditoTotalCents: 100_000_00,
      },
    });
    expect(company.status).toBeLessThan(300);
    const companyId = (company.body as IdRes).id;

    const action = await jsonApi<IdRes & { codigoAccion: string }>(
      '/api/v1/modules/fundae/actions',
      {
        method: 'POST',
        bearer,
        body: {
          codigoAccion: `XML-${stamp}`,
          nombre: 'Acción XML inicio E2E',
          modalidad: 'PRESENCIAL',
          horasFormacion: 16,
          fechaInicio: '2026-09-01',
          fechaFin: '2026-09-15',
        },
      },
    );
    expect(action.status).toBeLessThan(300);
    const actionId = (action.body as IdRes).id;
    const codigoAccion = (action.body as { codigoAccion: string }).codigoAccion;

    const group = await jsonApi<IdRes & { numeroGrupo: number }>('/api/v1/admin/fundae/groups', {
      method: 'POST',
      bearer,
      body: {
        actionId,
        companyId,
        modalidad: 'PRESENCIAL',
        fechaInicioPrevista: '2026-09-01T08:00:00.000Z',
        fechaFinPrevista: '2026-09-15T18:00:00.000Z',
      },
    });
    expect(group.status).toBeLessThan(300);
    const groupId = (group.body as IdRes).id;
    const numeroGrupo = (group.body as { numeroGrupo: number }).numeroGrupo;

    // Matriculo al admin como participante (acción sin courseId → no valida).
    const enroll = await jsonApi<IdRes>(`/api/v1/admin/fundae/groups/${groupId}/participants`, {
      method: 'POST',
      bearer,
      body: { userId: adminUserId, nifAlumno: '12345678Z' },
    });
    expect(enroll.status).toBeLessThan(300);

    // ─── XML inicio ────────────────────────────────────────────────────

    const xmlRes = await fetch(`${API_URL}/api/v1/admin/fundae/groups/${groupId}/start-xml`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(xmlRes.status, 'XML download → 200').toBe(200);
    const ct = xmlRes.headers.get('content-type') ?? '';
    expect(ct).toContain('application/xml');
    const xml = await xmlRes.text();

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<comunicacionInicioGrupo');
    expect(xml).toContain(`<codigoAccion>${codigoAccion}</codigoAccion>`);
    expect(xml).toContain(`<numeroGrupo>${numeroGrupo}</numeroGrupo>`);
    expect(xml).toContain('<nif>V12345674</nif>');
    expect(xml).toContain('<plantilla>25</plantilla>');
    expect(xml).toContain('<participantesIniciales total="1">');
    expect(xml).toContain('<nif>12345678Z</nif>');

    // ─── 404 sobre groupId inexistente ─────────────────────────────────

    const notFound = await fetch(
      `${API_URL}/api/v1/admin/fundae/groups/00000000-0000-0000-0000-000000000000/start-xml`,
      { headers: { Authorization: `Bearer ${bearer}` } },
    );
    if (notFound.status !== 404) {
      // Diagnóstico para futuros fallos: si NestJS devuelve otro status,
      // saber el body ayuda a entender (puede ser 401 si MFA no propaga,
      // 422 si validación, 500 si excepción no mapeada).
      const diag = await notFound.text();
      throw new Error(
        `Esperado 404 al consultar grupo inexistente, got ${notFound.status}: ${diag}`,
      );
    }
    expect(notFound.status).toBe(404);

    // Cleanup empresa
    await jsonApi(`/api/v1/admin/fundae/companies/${companyId}`, { method: 'DELETE', bearer });
  });
});
