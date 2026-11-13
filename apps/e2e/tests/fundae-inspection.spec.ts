import { expect, test } from '@playwright/test';
import {
  API_URL,
  adminTokenForBootstrap,
  createPublishedCourse,
  listEnrollments,
  signupOnboarded,
  trackProgress,
} from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * E2E del acceso de seguimiento Fundae (LMS-123): las claves que el centro
 * comunica a la fundación al inicio de la acción, y la pantalla con la que se
 * miran.
 *
 * Recorre el camino REAL del inspector, no la lista de endpoints:
 *
 *   1. Setup: curso publicado + empresa bonificada + acción con ese curso.
 *   2. Un alumno se matricula y consume una lección → hay evidencia que mirar.
 *   3. El alumno entra al grupo como participante.
 *   4. CONTROL: antes de conceder nada, el inspector recibe 403 al pedir el
 *      expediente. Sin este control, un 200 después no probaría nada — podría
 *      estar abierto para cualquiera.
 *   5. El admin concede el acceso → el inspector ve el grupo y el expediente
 *      por API, y la pantalla `/inspection` los pinta (participante, horas e
 *      itinerario lección a lección).
 *   6. El admin lo retira → vuelve el 403 y la pantalla deja de ofrecer nada.
 *
 * NIF propio (B44444446) porque UNIQUE (tenant, nif) sobrevive al borrado
 * lógico y los demás specs de Fundae tienen el suyo.
 */

/** CIF tipo B con dígito de control válido, propio de este spec. */
const COMPANY_NIF = 'B44444446';

interface Created {
  id: string;
}
interface InspectionGroupRef {
  groupId: string;
  numeroGrupo: number;
  codigoAccion: string;
}
interface InspectionParticipantRes {
  userId: string;
  nombre: string | null;
  horasAsistidas: number;
  leccionesCompletadas: number;
  leccionesVerificadas: number;
  itinerario: Array<{ leccion: string; completada: boolean; segundosRegistrados: number }>;
}
interface InspectionRes {
  groupId: string;
  denominacion: string;
  participants: InspectionParticipantRes[];
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

test.describe('Fundae · Acceso de seguimiento (LMS-123)', () => {
  test('conceder, mirar el expediente y retirar', async ({ page }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const stamp = Date.now();
    const password = 'E2eUserPassword123!';

    // ─── 1. Curso + empresa + acción ────────────────────────────────────

    const course = await createPublishedCourse({
      bearer,
      title: `Curso seguimiento E2E ${stamp}`,
      slug: `curso-seguimiento-e2e-${stamp}`,
    });
    const lesson = course.modules[0]?.lessons[0];
    expect(lesson, 'el curso de apoyo trae su lección').toBeTruthy();
    const lessonId = lesson!.id;
    const lessonTitle = lesson!.title;

    // La empresa se REUSA si ya existe: UNIQUE (tenant, nif) sobrevive al
    // borrado lógico, así que con un NIF fijo la segunda pasada sin `reset`
    // moriría aquí — y este spec no tiene por qué exigir base limpia, todo lo
    // demás que crea ya lleva `stamp`.
    const companyRes = await api<Created>('/api/v1/admin/fundae/companies', {
      method: 'POST',
      bearer,
      body: {
        nif: COMPANY_NIF,
        razonSocial: `Empresa Seguimiento E2E ${stamp}`,
        creditoTotalCents: 1_000_000_00,
      },
    });
    let companyId: string;
    if (companyRes.status < 300) {
      companyId = (companyRes.body as Created).id;
    } else {
      expect(
        (companyRes.body as ErrRes).code,
        `crear empresa: ${JSON.stringify(companyRes.body)}`,
      ).toBe('FUNDAE_COMPANY_NIF_DUPLICADO');
      const listRes = await api<Array<{ id: string; nif: string }>>(
        '/api/v1/admin/fundae/companies',
        { bearer },
      );
      const existente = (listRes.body as Array<{ id: string; nif: string }>).find(
        (c) => c.nif === COMPANY_NIF,
      );
      expect(existente, 'la empresa duplicada se puede reutilizar').toBeTruthy();
      companyId = existente!.id;
    }

    const actionRes = await api<Created>('/api/v1/modules/fundae/actions', {
      method: 'POST',
      bearer,
      body: {
        codigoAccion: `INS-${stamp}`,
        nombre: `Acción seguimiento E2E ${stamp}`,
        modalidad: 'TELEFORMACION',
        horasFormacion: 10,
        fechaInicio: '2026-09-01',
        fechaFin: '2026-10-31',
        // Sin curso vinculado no hay expediente que mirar: el seguimiento sale
        // del rastro de interacción con SU contenido.
        courseId: course.id,
      },
    });
    expect(actionRes.status, 'crear acción').toBeLessThan(300);
    const actionId = (actionRes.body as Created).id;

    const groupRes = await api<Created>('/api/v1/admin/fundae/groups', {
      method: 'POST',
      bearer,
      body: {
        actionId,
        companyId,
        modalidad: 'TELEFORMACION',
        fechaInicioPrevista: '2026-09-01T08:00:00.000Z',
        fechaFinPrevista: '2026-10-31T18:00:00.000Z',
      },
    });
    expect(groupRes.status, 'crear grupo').toBeLessThan(300);
    const groupId = (groupRes.body as Created).id;

    // ─── 2. Un alumno con recorrido real ────────────────────────────────

    const alumno = await signupOnboarded({
      tenantSlug,
      email: `e2e-fundae-alumno-${stamp}@example.test`,
      password,
      name: 'Alumna Seguimiento E2E',
    });

    const enrollRes = await api<Created>('/api/v1/modules/learning/enrollments/me', {
      method: 'POST',
      bearer: alumno.tokens.accessToken,
      body: { courseId: course.id },
    });
    expect(enrollRes.status, 'matricular alumno en el curso').toBeLessThan(300);

    const enrollments = await listEnrollments(alumno.tokens.accessToken);
    const enrollment = enrollments.find((e) => e.courseId === course.id);
    expect(enrollment, 'la matrícula del alumno existe').toBeTruthy();

    await trackProgress({
      bearer: alumno.tokens.accessToken,
      enrollmentId: enrollment!.id,
      lessonId,
      durationSec: 60,
    });

    // ─── 3. El alumno entra en el grupo ─────────────────────────────────

    const participantRes = await api<Created>(
      `/api/v1/admin/fundae/groups/${groupId}/participants`,
      { method: 'POST', bearer, body: { userId: alumno.user.id } },
    );
    expect(participantRes.status, 'matricular participante en el grupo').toBeLessThan(300);

    // ─── 4. CONTROL: sin concesión, el expediente NO abre ───────────────

    const inspector = await signupOnboarded({
      tenantSlug,
      email: `e2e-fundae-inspector-${stamp}@example.test`,
      password,
      name: 'Inspección E2E',
    });
    const inspectorBearer = inspector.tokens.accessToken;

    const sinConcesion = await api<ErrRes>(`/api/v1/fundae/inspection/groups/${groupId}`, {
      bearer: inspectorBearer,
    });
    expect(sinConcesion.status, 'sin concesión el expediente responde 403').toBe(403);
    expect((sinConcesion.body as ErrRes).code).toBe('FUNDAE_INSPECTION_FORBIDDEN');

    const sinGrupos = await api<InspectionGroupRef[]>('/api/v1/fundae/inspection/groups', {
      bearer: inspectorBearer,
    });
    expect(sinGrupos.status).toBe(200);
    expect((sinGrupos.body as InspectionGroupRef[]).length, 'aún no sigue ningún grupo').toBe(0);

    // ─── 5. El admin concede el acceso ──────────────────────────────────

    const grantRes = await api<{ activo: boolean }>(
      `/api/v1/admin/fundae/groups/${groupId}/inspectors`,
      { method: 'POST', bearer, body: { userId: inspector.user.id, notas: 'Alta E2E' } },
    );
    expect(grantRes.status, 'conceder acceso de seguimiento').toBeLessThan(300);
    expect((grantRes.body as { activo: boolean }).activo).toBe(true);

    const misGrupos = await api<InspectionGroupRef[]>('/api/v1/fundae/inspection/groups', {
      bearer: inspectorBearer,
    });
    expect((misGrupos.body as InspectionGroupRef[]).map((g) => g.groupId)).toContain(groupId);

    const expediente = await api<InspectionRes>(`/api/v1/fundae/inspection/groups/${groupId}`, {
      bearer: inspectorBearer,
    });
    expect(expediente.status, 'con concesión el expediente abre').toBe(200);
    const vista = expediente.body as InspectionRes;
    const fila = vista.participants.find((p) => p.userId === alumno.user.id);
    expect(fila, 'el alumno aparece en el expediente').toBeTruthy();
    expect(fila!.leccionesCompletadas).toBeGreaterThan(0);
    expect(
      fila!.itinerario.length,
      'el itinerario trae el recorrido lección a lección',
    ).toBeGreaterThan(0);
    // El inspector NO se cuela en el expediente que viene a inspeccionar: su
    // matrícula es `source = INSPECTION` y `participant-filter` la excluye.
    expect(vista.participants.some((p) => p.userId === inspector.user.id)).toBe(false);

    // ─── 5b. La pantalla del inspector ──────────────────────────────────

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: inspectorBearer,
      refreshToken: inspector.tokens.refreshToken,
      user: inspector.user,
    });
    await page.goto('/inspection');

    await expect(page.getByRole('heading', { name: /Seguimiento/i })).toBeVisible();
    await expect(page.getByText(`Acción seguimiento E2E ${stamp}`)).toBeVisible();
    await expect(page.getByText('Alumna Seguimiento E2E')).toBeVisible();

    // El itinerario se despliega por participante y trae la lección real.
    await page.getByRole('button', { name: 'Ver itinerario' }).first().click();
    await expect(page.getByText(lessonTitle)).toBeVisible();

    // ─── 6. Retirar el acceso lo cierra en el acto ──────────────────────

    const revokeRes = await api<{ revoked: boolean }>(
      `/api/v1/admin/fundae/groups/${groupId}/inspectors/${inspector.user.id}`,
      { method: 'DELETE', bearer },
    );
    expect(revokeRes.status, 'retirar el acceso').toBe(200);

    const trasRevocar = await api<ErrRes>(`/api/v1/fundae/inspection/groups/${groupId}`, {
      bearer: inspectorBearer,
    });
    expect(trasRevocar.status, 'retirado el acceso, el expediente vuelve a cerrarse').toBe(403);

    // La fila NO se borra: quién pudo mirar el expediente es parte de la
    // trazabilidad, y el admin la sigue viendo marcada como retirada.
    const listaAdmin = await api<
      Array<{ userId: string; activo: boolean; revokedAt: string | null }>
    >(`/api/v1/admin/fundae/groups/${groupId}/inspectors`, { bearer });
    const registro = (
      listaAdmin.body as Array<{ userId: string; activo: boolean; revokedAt: string | null }>
    ).find((a) => a.userId === inspector.user.id);
    expect(registro, 'el rastro del acceso se conserva').toBeTruthy();
    expect(registro!.activo).toBe(false);
    expect(registro!.revokedAt).not.toBeNull();
  });
});
