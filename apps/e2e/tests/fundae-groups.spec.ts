import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * E2E del flujo de grupos bonificables Fundae (LMS-81).
 *
 * Cubre:
 *   1. Setup: crear empresa bonificada + acción formativa de soporte.
 *   2. Crear grupo en DRAFT → list lo devuelve → get con costes.
 *   3. PATCH actualiza modalidad y crédito estimado.
 *   4. Crear segundo grupo con el mismo numeroGrupo → 409.
 *   5. Añadir coste DIRECTO → listar costes → eliminar coste.
 *   6. Intentar start → 422 FUNDAE_RLPT_NOTIFICACION_INICIAL_MISSING
 *      (la empresa no tiene RLPT; verifica el guard).
 *   7. Cancelar grupo (DRAFT → CANCELLED).
 *   8. Intentar añadir coste a grupo CANCELLED → 409 FUNDAE_GROUP_CERRADO.
 *   9. Cleanup: borrar empresa (acción no expone DELETE directo en E2E pero
 *      la fila queda huérfana — OK para fixtures de CI).
 *
 * NIF usado: B12345674 (CIF tipo B, los digits 1234567 tras el algoritmo dan
 * control 4 → para tipo B se usa el dígito '4'). Distinto de P1234567D
 * (companies.spec) y P9999999G (rlpt.spec) — UNIQUE (tenant, nif) sobrevive
 * a soft-delete así que cada spec tiene su propio NIF para correr en paralelo.
 */

interface CompanyRes {
  id: string;
  nif: string;
}
interface ActionRes {
  id: string;
  codigoAccion: string;
}
interface GroupRes {
  id: string;
  numeroGrupo: number;
  status: string;
  creditoEstimadoCents: number | null;
  creditoConsumidoCents: number;
  costsByTipo: Record<string, number>;
}
interface CostRes {
  id: string;
  tipo: string;
  amountCents: number;
}
interface ErrRes {
  code?: string;
  message?: string;
}

async function api<T>(
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

test.describe('Fundae · Grupos bonificables (LMS-81)', () => {
  test('CRUD grupo + costes + transiciones de estado', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const stamp = Date.now();

    // ─── 1. Setup: empresa + acción formativa ───────────────────────────

    // CIF tipo B con checksum válido (digits 1234567 → control 4 → '4')
    const companyRes = await api<CompanyRes>('/api/v1/admin/fundae/companies', {
      method: 'POST',
      bearer,
      body: {
        nif: 'B12345674',
        razonSocial: `Empresa Grupos E2E ${stamp}`,
        creditoTotalCents: 1_000_000_00,
      },
    });
    expect(companyRes.status, 'crear empresa').toBeLessThan(300);
    const companyId = (companyRes.body as CompanyRes).id;

    const actionRes = await api<ActionRes>('/api/v1/modules/fundae/actions', {
      method: 'POST',
      bearer,
      body: {
        codigoAccion: `GRP-${stamp}`,
        nombre: `Acción grupos E2E ${stamp}`,
        modalidad: 'PRESENCIAL',
        horasFormacion: 40,
        fechaInicio: '2026-09-01',
        fechaFin: '2026-10-31',
      },
    });
    expect(actionRes.status, 'crear acción').toBeLessThan(300);
    const actionId = (actionRes.body as ActionRes).id;

    // ─── 2. Crear grupo en DRAFT ────────────────────────────────────────

    const createRes = await api<GroupRes>('/api/v1/admin/fundae/groups', {
      method: 'POST',
      bearer,
      body: {
        actionId,
        companyId,
        modalidad: 'PRESENCIAL',
        fechaInicioPrevista: '2026-09-01T08:00:00.000Z',
        fechaFinPrevista: '2026-10-31T18:00:00.000Z',
        creditoEstimadoCents: 50_000_00,
        notas: 'Grupo E2E',
      },
    });
    expect(createRes.status, 'crear grupo → 201/200').toBeLessThan(300);
    const g = createRes.body as GroupRes;
    expect(g.status).toBe('DRAFT');
    expect(g.creditoEstimadoCents).toBe(50_000_00);
    expect(g.creditoConsumidoCents).toBe(0);
    const groupId = g.id;
    const numeroGrupo = g.numeroGrupo;

    // 2b. List lo devuelve.
    const listRes = await api<GroupRes[]>('/api/v1/admin/fundae/groups', { bearer });
    expect(listRes.status).toBe(200);
    expect((listRes.body as GroupRes[]).some((x) => x.id === groupId)).toBe(true);

    // 2c. Get directo.
    const getRes = await api<GroupRes>(`/api/v1/admin/fundae/groups/${groupId}`, { bearer });
    expect(getRes.status).toBe(200);
    expect((getRes.body as GroupRes).id).toBe(groupId);

    // ─── 3. PATCH metadatos ─────────────────────────────────────────────

    const patchRes = await api<GroupRes>(`/api/v1/admin/fundae/groups/${groupId}`, {
      method: 'PATCH',
      bearer,
      body: { modalidad: 'MIXTA', creditoEstimadoCents: 60_000_00 },
    });
    expect(patchRes.status).toBe(200);
    expect((patchRes.body as GroupRes).creditoEstimadoCents).toBe(60_000_00);

    // ─── 4. Número de grupo duplicado → 409 ────────────────────────────

    const dupRes = await api<ErrRes>('/api/v1/admin/fundae/groups', {
      method: 'POST',
      bearer,
      body: {
        actionId,
        companyId,
        numeroGrupo,
        modalidad: 'PRESENCIAL',
        fechaInicioPrevista: '2026-09-01T08:00:00.000Z',
        fechaFinPrevista: '2026-10-31T18:00:00.000Z',
      },
    });
    expect(dupRes.status).toBe(409);
    expect((dupRes.body as ErrRes).code).toBe('FUNDAE_GROUP_NUMERO_DUPLICADO');

    // ─── 5. Costes ──────────────────────────────────────────────────────

    const costRes = await api<CostRes>(`/api/v1/admin/fundae/groups/${groupId}/costs`, {
      method: 'POST',
      bearer,
      body: { tipo: 'DIRECTO', concepto: 'Honorarios profesor', amountCents: 15_000_00 },
    });
    expect(costRes.status).toBeLessThan(300);
    const costId = (costRes.body as CostRes).id;

    const costsListRes = await api<CostRes[]>(`/api/v1/admin/fundae/groups/${groupId}/costs`, {
      bearer,
    });
    expect((costsListRes.body as CostRes[]).length).toBeGreaterThanOrEqual(1);
    expect((costsListRes.body as CostRes[]).some((c) => c.id === costId)).toBe(true);

    const delCostRes = await api<{ deleted: true }>(
      `/api/v1/admin/fundae/groups/${groupId}/costs/${costId}`,
      {
        method: 'DELETE',
        bearer,
      },
    );
    expect(delCostRes.status).toBe(200);

    // ─── 6. Start → 422 RLPT guard ──────────────────────────────────────

    const startRes = await api<ErrRes>(`/api/v1/admin/fundae/groups/${groupId}/start`, {
      method: 'POST',
      bearer,
    });
    expect(startRes.status).toBe(422);
    expect((startRes.body as ErrRes).code).toBe('FUNDAE_RLPT_NOTIFICACION_INICIAL_MISSING');

    // ─── 7. Cancelar grupo ───────────────────────────────────────────────

    const cancelRes = await api<GroupRes>(`/api/v1/admin/fundae/groups/${groupId}/cancel`, {
      method: 'POST',
      bearer,
    });
    expect(cancelRes.status).toBeLessThan(300);
    expect((cancelRes.body as GroupRes).status).toBe('CANCELLED');

    // ─── 8. Coste en grupo CANCELLED → 409 ──────────────────────────────

    const costOnCancelled = await api<ErrRes>(`/api/v1/admin/fundae/groups/${groupId}/costs`, {
      method: 'POST',
      bearer,
      body: { tipo: 'DIRECTO', concepto: 'Intento inválido', amountCents: 100 },
    });
    expect(costOnCancelled.status).toBe(409);
    expect((costOnCancelled.body as ErrRes).code).toBe('FUNDAE_GROUP_CERRADO');

    // ─── 9. Cleanup empresa ──────────────────────────────────────────────

    const delCompanyRes = await api<{ deleted: true }>(
      `/api/v1/admin/fundae/companies/${companyId}`,
      {
        method: 'DELETE',
        bearer,
      },
    );
    expect(delCompanyRes.status).toBe(200);
  });
});
