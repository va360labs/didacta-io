import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * E2E del cálculo de finalización Fundae (LMS-84).
 *
 * Cubre:
 *   1. Cleanup defensivo + setup empresa + acción SIN courseId + grupo + 1 participante.
 *   2. POST /admin/fundae/groups/:id/finalize con `preview=true`.
 *      Como la acción no tiene courseId, todos los participantes quedan
 *      EN_CURSO con 0 horas. La fila NO se persiste en preview.
 *   3. POST con `preview=false` → persiste; verificamos que un GET posterior
 *      al participante muestra horasAsistidas y resultado snapshoteados.
 *   4. POST con `umbralOverride=10` y un participante (preview) → confirma
 *      que el override se aplica; en este caso seguirá EN_CURSO porque el
 *      cálculo de progress es 0 (no hay courseId).
 *   5. 404 sobre groupId inexistente.
 *
 * NIF empresa: F12345674 (CIF tipo F — sociedades cooperativas — checksum válido).
 */

interface IdRes {
  id: string;
}
interface CompletionRes {
  groupId: string;
  umbralAplicadoPct: number;
  totalParticipantes: number;
  aptos: number;
  noAptos: number;
  enCurso: number;
  preview: boolean;
  participants: Array<{
    participantId: string;
    horasAsistidas: number;
    progressPercent: number;
    resultado: string;
  }>;
}
interface ParticipantRow {
  id: string;
  horasAsistidas?: number | string | null;
  progressPercent?: number | null;
  resultado?: string | null;
  completedAt?: string | null;
}
interface ErrRes {
  code?: string;
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
  return String(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')).sub);
}

test.describe('Fundae · Cálculo finalización grupo (LMS-84)', () => {
  test('preview vs persistencia + override de umbral + 404', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const stamp = Date.now();
    const adminUserId = decodeJwtSub(bearer);

    // Cleanup defensivo
    const existing = await jsonApi<Array<IdRes>>(
      '/api/v1/admin/fundae/companies?search=F12345674&includeDeleted=true',
      { bearer },
    );
    if (Array.isArray(existing.body)) {
      for (const c of existing.body as Array<IdRes>) {
        await jsonApi(`/api/v1/admin/fundae/companies/${c.id}`, { method: 'DELETE', bearer });
      }
    }

    // Setup
    const company = await jsonApi<IdRes>('/api/v1/admin/fundae/companies', {
      method: 'POST',
      bearer,
      body: { nif: 'F12345674', razonSocial: `Empresa Finalizar ${stamp}` },
    });
    expect(company.status).toBeLessThan(300);
    const companyId = (company.body as IdRes).id;

    const action = await jsonApi<IdRes>('/api/v1/modules/fundae/actions', {
      method: 'POST',
      bearer,
      body: {
        codigoAccion: `FIN-${stamp}`,
        nombre: 'Acción finalización E2E',
        modalidad: 'PRESENCIAL',
        horasFormacion: 20,
        fechaInicio: '2026-09-01',
        fechaFin: '2026-09-30',
      },
    });
    expect(action.status).toBeLessThan(300);
    const actionId = (action.body as IdRes).id;

    const group = await jsonApi<IdRes>('/api/v1/admin/fundae/groups', {
      method: 'POST',
      bearer,
      body: {
        actionId,
        companyId,
        modalidad: 'PRESENCIAL',
        fechaInicioPrevista: '2026-09-01T08:00:00.000Z',
        fechaFinPrevista: '2026-09-30T18:00:00.000Z',
      },
    });
    expect(group.status).toBeLessThan(300);
    const groupId = (group.body as IdRes).id;

    const enroll = await jsonApi<IdRes>(`/api/v1/admin/fundae/groups/${groupId}/participants`, {
      method: 'POST',
      bearer,
      body: { userId: adminUserId, nifAlumno: '12345678Z' },
    });
    expect(enroll.status).toBeLessThan(300);
    const participantId = (enroll.body as IdRes).id;

    // ─── 2. preview=true ────────────────────────────────────────────────

    const preview = await jsonApi<CompletionRes>(
      `/api/v1/admin/fundae/groups/${groupId}/finalize`,
      { method: 'POST', bearer, body: { preview: true } },
    );
    expect(preview.status).toBeLessThan(300);
    const previewBody = preview.body as CompletionRes;
    expect(previewBody.preview).toBe(true);
    expect(previewBody.totalParticipantes).toBe(1);
    expect(previewBody.umbralAplicadoPct).toBe(75);
    // Sin courseId, todos quedan EN_CURSO con 0 horas.
    expect(previewBody.enCurso).toBe(1);
    expect(previewBody.participants[0]!.horasAsistidas).toBe(0);
    expect(previewBody.participants[0]!.progressPercent).toBe(0);
    expect(previewBody.participants[0]!.resultado).toBe('EN_CURSO');

    // Verifico que NO se persistió: el list devuelve resultado=null todavía.
    const listAfterPreview = await jsonApi<ParticipantRow[]>(
      `/api/v1/admin/fundae/groups/${groupId}/participants`,
      { bearer },
    );
    const rowAfterPreview = (listAfterPreview.body as ParticipantRow[]).find(
      (r) => r.id === participantId,
    );
    expect(rowAfterPreview).toBeDefined();
    expect(rowAfterPreview!.resultado ?? null).toBeNull();

    // ─── 3. preview=false → persiste ────────────────────────────────────

    const persisted = await jsonApi<CompletionRes>(
      `/api/v1/admin/fundae/groups/${groupId}/finalize`,
      { method: 'POST', bearer, body: { preview: false } },
    );
    expect(persisted.status).toBeLessThan(300);
    expect((persisted.body as CompletionRes).preview).toBe(false);

    // Verifico que SÍ se persistió.
    const listAfterPersist = await jsonApi<ParticipantRow[]>(
      `/api/v1/admin/fundae/groups/${groupId}/participants`,
      { bearer },
    );
    const rowAfter = (listAfterPersist.body as ParticipantRow[]).find(
      (r) => r.id === participantId,
    );
    expect(rowAfter).toBeDefined();
    expect(rowAfter!.resultado).toBe('EN_CURSO');
    expect(rowAfter!.progressPercent).toBe(0);
    expect(rowAfter!.completedAt).toBeTruthy();

    // ─── 4. umbralOverride ──────────────────────────────────────────────

    const overridden = await jsonApi<CompletionRes>(
      `/api/v1/admin/fundae/groups/${groupId}/finalize`,
      { method: 'POST', bearer, body: { umbralOverride: 10, preview: true } },
    );
    expect(overridden.status).toBeLessThan(300);
    expect((overridden.body as CompletionRes).umbralAplicadoPct).toBe(10);

    // ─── 5. 404 sobre groupId inexistente ──────────────────────────────

    const notFound = await jsonApi<ErrRes>(
      '/api/v1/admin/fundae/groups/00000000-0000-0000-0000-000000000000/finalize',
      { method: 'POST', bearer, body: {} },
    );
    expect(notFound.status).toBe(404);

    // Cleanup
    await jsonApi(`/api/v1/admin/fundae/companies/${companyId}`, { method: 'DELETE', bearer });
  });
});
