import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * E2E del flujo de matriculaciones nominales en grupo bonificable Fundae
 * (LMS-82).
 *
 * Cubre:
 *   1. Setup: empresa + acción SIN courseId (para que el service no exija
 *      validación de matriculación contra catálogo) + grupo en DRAFT.
 *   2. Enroll de un userId arbitrario (admin que dispara el bootstrap) →
 *      list lo devuelve con ENROLLED.
 *   3. Enroll del mismo userId duplicado → 409.
 *   4. bulk-enroll con grupo sin curso → 422 FUNDAE_GROUP_SIN_CURSO.
 *   5. Remove del participante → soft delete (sale de list por defecto).
 *   6. List con includeRemoved=true → vuelve a aparecer en REMOVED.
 *   7. Re-enroll del mismo user → status pasa a ENROLLED de nuevo (sin
 *      duplicar fila por la UNIQUE).
 *   8. Cancel del grupo → enroll en grupo cerrado → 409 FUNDAE_GROUP_CERRADO.
 *
 * NIF empresa: A12345674 (CIF tipo A — sociedad anónima — checksum válido).
 */

interface CompanyRes {
  id: string;
}
interface ActionRes {
  id: string;
}
interface GroupRes {
  id: string;
  status: string;
}
interface ParticipantRes {
  id: string;
  userId: string;
  status: string;
  nifAlumno: string | null;
}
interface BulkRes {
  enrolled: number;
  skipped: number;
  total: number;
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

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const [, payload] = jwt.split('.');
  if (!payload) throw new Error('JWT inválido');
  const buf = Buffer.from(payload, 'base64');
  return JSON.parse(buf.toString('utf8'));
}

test.describe('Fundae · Participantes de grupo bonificable (LMS-82)', () => {
  test('enroll/list/duplicado/remove/re-enroll/grupo cerrado', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const stamp = Date.now();

    // El admin actor lo usamos también como userId del participante —
    // es un user válido del tenant aunque no tenga course enrollment.
    const claims = decodeJwtPayload(bearer);
    const adminUserId = String(claims.sub);

    // ─── Setup: empresa + acción SIN curso + grupo ─────────────────────

    const companyRes = await api<CompanyRes>('/api/v1/admin/fundae/companies', {
      method: 'POST',
      bearer,
      body: { nif: 'A12345674', razonSocial: `Empresa Participantes ${stamp}` },
    });
    expect(companyRes.status, 'crear empresa').toBeLessThan(300);
    const companyId = (companyRes.body as CompanyRes).id;

    const actionRes = await api<ActionRes>('/api/v1/modules/fundae/actions', {
      method: 'POST',
      bearer,
      body: {
        codigoAccion: `PRT-${stamp}`,
        nombre: `Acción participantes ${stamp}`,
        modalidad: 'PRESENCIAL',
        horasFormacion: 10,
        fechaInicio: '2026-09-01',
        fechaFin: '2026-09-30',
        // courseId omitido a propósito — el service permite enrollment sin validar.
      },
    });
    expect(actionRes.status, 'crear acción').toBeLessThan(300);
    const actionId = (actionRes.body as ActionRes).id;

    const groupRes = await api<GroupRes>('/api/v1/admin/fundae/groups', {
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
    expect(groupRes.status, 'crear grupo').toBeLessThan(300);
    const groupId = (groupRes.body as GroupRes).id;

    // ─── 2. Enroll del admin como participante ─────────────────────────

    const enrollRes = await api<ParticipantRes>(
      `/api/v1/admin/fundae/groups/${groupId}/participants`,
      {
        method: 'POST',
        bearer,
        body: { userId: adminUserId, notas: 'Test E2E' },
      },
    );
    expect(enrollRes.status, 'enroll → 200').toBeLessThan(300);
    const participantId = (enrollRes.body as ParticipantRes).id;
    expect((enrollRes.body as ParticipantRes).status).toBe('ENROLLED');

    const listRes = await api<ParticipantRes[]>(
      `/api/v1/admin/fundae/groups/${groupId}/participants`,
      { bearer },
    );
    expect(listRes.status).toBe(200);
    expect((listRes.body as ParticipantRes[]).length).toBe(1);

    // ─── 3. Enroll duplicado → 409 ──────────────────────────────────────

    const dupRes = await api<ErrRes>(`/api/v1/admin/fundae/groups/${groupId}/participants`, {
      method: 'POST',
      bearer,
      body: { userId: adminUserId },
    });
    expect(dupRes.status).toBe(409);
    expect((dupRes.body as ErrRes).code).toBe('FUNDAE_GROUP_PARTICIPANT_DUPLICADO');

    // ─── 4. Bulk enroll en grupo sin curso → 422 ────────────────────────

    const bulkRes = await api<ErrRes>(
      `/api/v1/admin/fundae/groups/${groupId}/participants/bulk-enroll`,
      { method: 'POST', bearer, body: {} },
    );
    expect(bulkRes.status).toBe(422);
    expect((bulkRes.body as ErrRes).code).toBe('FUNDAE_GROUP_SIN_CURSO');

    // ─── 5. Remove (soft) ──────────────────────────────────────────────

    const removeRes = await api<{ removed: true }>(
      `/api/v1/admin/fundae/groups/${groupId}/participants/${participantId}`,
      { method: 'DELETE', bearer },
    );
    expect(removeRes.status).toBe(200);

    const listAfterRm = await api<ParticipantRes[]>(
      `/api/v1/admin/fundae/groups/${groupId}/participants`,
      { bearer },
    );
    expect((listAfterRm.body as ParticipantRes[]).length).toBe(0);

    // ─── 6. includeRemoved=true ────────────────────────────────────────

    const listInc = await api<ParticipantRes[]>(
      `/api/v1/admin/fundae/groups/${groupId}/participants?includeRemoved=true`,
      { bearer },
    );
    const removed = (listInc.body as ParticipantRes[]).find((p) => p.id === participantId);
    expect(removed?.status).toBe('REMOVED');

    // ─── 7. Re-enroll → reactiva la fila REMOVED ───────────────────────

    const reEnrollRes = await api<ParticipantRes>(
      `/api/v1/admin/fundae/groups/${groupId}/participants`,
      { method: 'POST', bearer, body: { userId: adminUserId } },
    );
    expect(reEnrollRes.status).toBeLessThan(300);
    expect((reEnrollRes.body as ParticipantRes).id).toBe(participantId);
    expect((reEnrollRes.body as ParticipantRes).status).toBe('ENROLLED');

    // ─── 8. Cancel grupo → enroll → 409 GROUP_CERRADO ─────────────────

    const cancelRes = await api<GroupRes>(`/api/v1/admin/fundae/groups/${groupId}/cancel`, {
      method: 'POST',
      bearer,
    });
    expect(cancelRes.status).toBeLessThan(300);

    const enrollOnCancelled = await api<ErrRes>(
      `/api/v1/admin/fundae/groups/${groupId}/participants`,
      {
        method: 'POST',
        bearer,
        body: { userId: '00000000-0000-0000-0000-000000000099' },
      },
    );
    expect(enrollOnCancelled.status).toBe(409);
    expect((enrollOnCancelled.body as ErrRes).code).toBe('FUNDAE_GROUP_CERRADO');

    // ─── Cleanup empresa (idempotente) ──────────────────────────────────

    await api(`/api/v1/admin/fundae/companies/${companyId}`, { method: 'DELETE', bearer });
  });
});
