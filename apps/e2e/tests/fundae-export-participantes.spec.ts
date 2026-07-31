import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, bootstrapScenario } from '../helpers/api';

async function enrollAlumno(args: {
  bearer: string;
  courseId: string;
  userId: string;
}): Promise<void> {
  const res = await fetch(`${API_URL}/api/v1/modules/learning/enrollments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.bearer}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ courseId: args.courseId, userId: args.userId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`enroll alumno failed (${res.status}): ${text}`);
  }
}

/**
 * Spec G5.2: el export XML de Fundae para una acción con curso vinculado
 * debe contener un bloque `<participantes>` con cada matriculación, y
 * cuando un participante tiene `documentId` (DNI/NIE) en su perfil, el
 * tag `<dni>` debe aparecer dentro de su `<participante>`.
 *
 * Flow:
 *   1. Bootstrap escenario (admin con curso publicado, alumno enrolado).
 *   2. Alumno setea `documentId` válido vía PATCH /me/profile.
 *   3. Admin crea acción Fundae vinculada al curso.
 *   4. GET /actions/{id}/export.xml.
 *   5. Verifica `<participantes total="N">`, `<email>` del alumno, y
 *      `<dni>{documentId}</dni>`.
 */

const VALID_DNI = '12345678Z'; // 12345678 % 23 = 14 → Z (válido).

test.describe('mod.fundae · export XML con participantes (G5.2)', () => {
  test('XML incluye <participantes> con DNI cuando el alumno lo declaró', async () => {
    const scenario = await bootstrapScenario();
    const tenantSlug = scenario.tenantSlug;
    const adminToken = await adminTokenForBootstrap(tenantSlug);

    // 1. Alumno setea su DNI.
    const setDni = await fetch(`${API_URL}/api/v1/me/profile`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${scenario.alumno.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ documentId: VALID_DNI }),
    });
    expect(setDni.ok, `PATCH documentId OK (got ${setDni.status})`).toBe(true);
    const profile = (await setDni.json()) as { documentId: string | null };
    expect(profile.documentId).toBe(VALID_DNI);

    // 2. Admin enrola al alumno en el curso (bootstrap no lo hace).
    await enrollAlumno({
      bearer: adminToken,
      courseId: scenario.course.id,
      userId: scenario.alumno.user.id,
    });

    // 3. Admin crea acción Fundae vinculada al curso del bootstrap.
    const stamp = Date.now();
    const codigo = `AF-PART-${stamp}`;
    const createAction = await fetch(`${API_URL}/api/v1/modules/fundae/actions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        codigoAccion: codigo,
        nombre: 'Curso E2E con participantes',
        modalidad: 'TELEFORMACION',
        horasFormacion: 10,
        fechaInicio: '2026-05-01',
        fechaFin: '2026-05-15',
        courseId: scenario.course.id,
      }),
    });
    expect(createAction.ok, `create action OK (got ${createAction.status})`).toBe(true);
    const action = (await createAction.json()) as { id: string };

    // 4. Export XML.
    const xmlRes = await fetch(`${API_URL}/api/v1/modules/fundae/actions/${action.id}/export.xml`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(xmlRes.ok).toBe(true);
    expect(xmlRes.headers.get('content-type')).toContain('application/xml');
    const xml = await xmlRes.text();

    // 5. Asserts.
    expect(xml).toMatch(/<participantes total="\d+">/);
    expect(xml).toContain(`<email>${scenario.alumno.email}</email>`);
    expect(xml).toContain(`<dni>${VALID_DNI}</dni>`);
  });

  test('XML omite <dni> para participantes sin documentId', async () => {
    const scenario = await bootstrapScenario();
    const adminToken = await adminTokenForBootstrap(scenario.tenantSlug);

    await enrollAlumno({
      bearer: adminToken,
      courseId: scenario.course.id,
      userId: scenario.alumno.user.id,
    });

    // El alumno del bootstrap no tiene DNI por defecto → su <participante>
    // no debe traer <dni>.

    const stamp = Date.now();
    const codigo = `AF-NODNI-${stamp}`;
    const createAction = await fetch(`${API_URL}/api/v1/modules/fundae/actions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        codigoAccion: codigo,
        nombre: 'Curso E2E sin DNI',
        modalidad: 'TELEFORMACION',
        horasFormacion: 10,
        fechaInicio: '2026-05-01',
        fechaFin: '2026-05-15',
        courseId: scenario.course.id,
      }),
    });
    expect(createAction.ok).toBe(true);
    const action = (await createAction.json()) as { id: string };

    const xmlRes = await fetch(`${API_URL}/api/v1/modules/fundae/actions/${action.id}/export.xml`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const xml = await xmlRes.text();

    // El email aparece pero no debe haber <dni></dni> vacío.
    expect(xml).toContain(`<email>${scenario.alumno.email}</email>`);
    expect(xml).not.toContain('<dni></dni>');
  });
});
