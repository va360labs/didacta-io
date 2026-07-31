/**
 * UC-17 — Rutas de aprendizaje: lifecycle completo
 *
 * Tests de integración pura (sin browser). Todos los flujos se ejercitan
 * directamente contra la API REST.
 *
 * Cobertura:
 *  - Formador crea, edita, publica, archiva y restaura una ruta
 *  - Alumno lista rutas publicadas y ve el detalle
 *  - Alumno se matricula → aparece en /me/paths con progreso 0
 *  - Doble matrícula activa → 409 Conflict
 *  - Matriculación sin cursos → 400 Bad Request
 *  - Alumno cancela matrícula → desaparece de /me/paths
 */

import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, createPublishedCourse, signup } from '../helpers/api';

// ─── helpers locales ─────────────────────────────────────────────────────────

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; bearer?: string } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.bearer) headers['Authorization'] = `Bearer ${init.bearer}`;

  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  return { status: res.status, body: body as T };
}

const PATHS_BASE = '/api/v1/modules/learning/paths';
const ME_PATHS = '/api/v1/modules/learning/me/paths';

// ─── setup compartido ─────────────────────────────────────────────────────────

test.describe('Rutas de aprendizaje — lifecycle (UC-17)', () => {
  const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
  const stamp = Date.now();

  let adminToken: string;
  let alumnoToken: string;

  test.beforeAll(async () => {
    // Admin seed (super_admin o tenant_admin)
    adminToken = await adminTokenForBootstrap(tenantSlug);

    // Alumno sin rol editor
    const alumnoEmail = `e2e-alumno-rutas-${stamp}@example.test`;
    const session = await signup({
      tenantSlug,
      email: alumnoEmail,
      password: 'E2eTestPassword123!',
      name: 'Alumno Rutas E2E',
    });
    alumnoToken = session.tokens.accessToken;
  });

  // ─── 1. Crear ruta en DRAFT ─────────────────────────────────────────────────

  test('formador crea ruta en borrador', async () => {
    const { status, body } = await api<{ id: string; status: string; slug: string }>(PATHS_BASE, {
      method: 'POST',
      body: { title: `Ruta E2E ${stamp}`, description: 'Ruta de prueba', sequenceType: 'LINEAR' },
      bearer: adminToken,
    });
    expect(status).toBe(201);
    expect(body.status).toBe('DRAFT');
    expect(body.slug).toMatch(/ruta-e2e/);
  });

  // ─── 2. DRAFT no aparece en listado público ──────────────────────────────────

  test('ruta en draft no es visible en listado público', async () => {
    const { status, body } = await api<Array<{ title: string }>>(PATHS_BASE, {
      bearer: alumnoToken,
    });
    expect(status).toBe(200);
    const found = (body as Array<{ title: string }>).find((p) =>
      p.title.includes(`Ruta E2E ${stamp}`),
    );
    expect(found).toBeUndefined();
  });

  // ─── 3. Publicar sin cursos → 400 ───────────────────────────────────────────

  test('publicar ruta sin cursos devuelve 400', async () => {
    // Crear ruta nueva específica para este test
    const { body: created } = await api<{ id: string }>(PATHS_BASE, {
      method: 'POST',
      body: { title: `Ruta SinCurso ${stamp}` },
      bearer: adminToken,
    });
    const { status } = await api(`${PATHS_BASE}/${created.id}/publish`, {
      method: 'POST',
      bearer: adminToken,
    });
    expect(status).toBe(400);
  });

  // ─── 4. Formador: flujo completo crear → cursos → publicar ──────────────────

  test('formador crea ruta con curso y la publica', async () => {
    // Crear curso publicado
    const course = await createPublishedCourse({
      bearer: adminToken,
      title: `Curso para ruta ${stamp}`,
      slug: `curso-ruta-${stamp}`,
    });

    // Crear ruta
    const { body: path } = await api<{ id: string; slug: string; status: string }>(PATHS_BASE, {
      method: 'POST',
      body: { title: `Ruta Con Cursos ${stamp}`, sequenceType: 'LINEAR' },
      bearer: adminToken,
    });
    expect(path.status).toBe('DRAFT');

    // Añadir curso a la ruta
    const { status: patchStatus, body: updated } = await api<{ courses: unknown[] }>(
      `${PATHS_BASE}/${path.id}`,
      {
        method: 'PATCH',
        body: { courses: [{ courseId: course.id, position: 0 }] },
        bearer: adminToken,
      },
    );
    expect(patchStatus).toBe(200);
    expect((updated.courses as unknown[]).length).toBe(1);

    // Publicar
    const { status: publishStatus, body: published } = await api<{ status: string }>(
      `${PATHS_BASE}/${path.id}/publish`,
      { method: 'POST', bearer: adminToken },
    );
    expect(publishStatus).toBe(200);
    expect(published.status).toBe('PUBLISHED');
  });

  // ─── 5. Alumno lista rutas publicadas ───────────────────────────────────────

  test('alumno ve rutas publicadas en el listado', async () => {
    const { status, body } = await api<Array<{ title: string; status: string }>>(PATHS_BASE, {
      bearer: alumnoToken,
    });
    expect(status).toBe(200);
    const found = (body as Array<{ title: string; status: string }>).find((p) =>
      p.title.includes(`Ruta Con Cursos ${stamp}`),
    );
    expect(found).toBeDefined();
    expect(found?.status).toBe('PUBLISHED');
  });

  // ─── 6. Alumno ve detalle de la ruta ────────────────────────────────────────

  test('alumno obtiene detalle de la ruta por slug', async () => {
    // Obtener slug de la ruta publicada
    const { body: all } = await api<Array<{ title: string; slug: string }>>(PATHS_BASE, {
      bearer: alumnoToken,
    });
    const path = (all as Array<{ title: string; slug: string }>).find((p) =>
      p.title.includes(`Ruta Con Cursos ${stamp}`),
    );
    expect(path).toBeDefined();

    const { status, body } = await api<{
      slug: string;
      courseCount: number;
      enrollment: null;
      nextStep: null;
    }>(`${PATHS_BASE}/${path!.slug}`, { bearer: alumnoToken });
    expect(status).toBe(200);
    expect(body.courseCount).toBe(1);
    expect(body.enrollment).toBeNull();
    expect(body.nextStep).toBeNull();
  });

  // ─── 7. Alumno se matricula ──────────────────────────────────────────────────

  test('alumno se matricula en la ruta y aparece en /me/paths', async () => {
    // Resolver slug + id
    const { body: all } = await api<Array<{ id: string; title: string; slug: string }>>(
      PATHS_BASE,
      { bearer: alumnoToken },
    );
    const path = (all as Array<{ id: string; title: string; slug: string }>).find((p) =>
      p.title.includes(`Ruta Con Cursos ${stamp}`),
    );
    expect(path).toBeDefined();

    // Matricularse
    const { status, body: enrollment } = await api<{ status: string; progressPercent: number }>(
      `${PATHS_BASE}/${path!.id}/enroll`,
      { method: 'POST', bearer: alumnoToken },
    );
    expect(status).toBe(200);
    expect(enrollment.status).toBe('ACTIVE');
    expect(enrollment.progressPercent).toBe(0);

    // Verificar en /me/paths
    const { status: meStatus, body: myPaths } = await api<
      Array<{ title: string; enrollment: { status: string } }>
    >(ME_PATHS, { bearer: alumnoToken });
    expect(meStatus).toBe(200);
    const myPath = (
      myPaths as Array<{ title: string; enrollment: { status: string } | null }>
    ).find((p) => p.title.includes(`Ruta Con Cursos ${stamp}`));
    expect(myPath).toBeDefined();

    // Verificar nextStep ahora existe en el detalle
    const { body: detail } = await api<{ nextStep: { courseId: string } | null }>(
      `${PATHS_BASE}/${path!.slug}`,
      { bearer: alumnoToken },
    );
    expect(detail.nextStep).not.toBeNull();
    expect(detail.nextStep?.courseId).toBeTruthy();
  });

  // ─── 8. Doble matrícula activa → 409 ────────────────────────────────────────

  test('intentar matricularse dos veces devuelve 409', async () => {
    const { body: all } = await api<Array<{ id: string; title: string }>>(PATHS_BASE, {
      bearer: alumnoToken,
    });
    const path = (all as Array<{ id: string; title: string }>).find((p) =>
      p.title.includes(`Ruta Con Cursos ${stamp}`),
    );
    expect(path).toBeDefined();

    const { status } = await api(`${PATHS_BASE}/${path!.id}/enroll`, {
      method: 'POST',
      bearer: alumnoToken,
    });
    expect(status).toBe(409);
  });

  // ─── 9. Alumno cancela matrícula ─────────────────────────────────────────────

  test('alumno cancela matrícula y desaparece de /me/paths', async () => {
    const { body: all } = await api<Array<{ id: string; title: string }>>(PATHS_BASE, {
      bearer: alumnoToken,
    });
    const path = (all as Array<{ id: string; title: string }>).find((p) =>
      p.title.includes(`Ruta Con Cursos ${stamp}`),
    );
    expect(path).toBeDefined();

    const { status } = await api(`${PATHS_BASE}/${path!.id}/enroll`, {
      method: 'DELETE',
      bearer: alumnoToken,
    });
    expect(status).toBe(200);

    const { body: myPaths } = await api<Array<{ title: string }>>(ME_PATHS, {
      bearer: alumnoToken,
    });
    const still = (myPaths as Array<{ title: string }>).find((p) =>
      p.title.includes(`Ruta Con Cursos ${stamp}`),
    );
    expect(still).toBeUndefined();
  });

  // ─── 10. Formador archiva y restaura ─────────────────────────────────────────

  test('formador archiva la ruta → ya no aparece en listado público', async () => {
    const { body: formadorPaths } = await api<Array<{ id: string; title: string }>>(
      `${PATHS_BASE}/formador`,
      { bearer: adminToken },
    );
    const path = (formadorPaths as Array<{ id: string; title: string }>).find((p) =>
      p.title.includes(`Ruta Con Cursos ${stamp}`),
    );
    expect(path).toBeDefined();

    // Archivar
    const { status, body: archived } = await api<{ status: string }>(
      `${PATHS_BASE}/${path!.id}/archive`,
      { method: 'POST', bearer: adminToken },
    );
    expect(status).toBe(200);
    expect(archived.status).toBe('ARCHIVED');

    // No aparece en listado público
    const { body: publicList } = await api<Array<{ title: string }>>(PATHS_BASE, {
      bearer: alumnoToken,
    });
    const inPublic = (publicList as Array<{ title: string }>).find((p) =>
      p.title.includes(`Ruta Con Cursos ${stamp}`),
    );
    expect(inPublic).toBeUndefined();

    // Restaurar → vuelve a DRAFT
    const { status: restoreStatus, body: restored } = await api<{ status: string }>(
      `${PATHS_BASE}/${path!.id}/restore`,
      { method: 'POST', bearer: adminToken },
    );
    expect(restoreStatus).toBe(200);
    expect(restored.status).toBe('DRAFT');
  });

  // ─── 11. Panel formador lista todas las rutas ─────────────────────────────────

  test('formador accede al panel y ve rutas de todos los estados', async () => {
    const { status, body } = await api<Array<{ title: string; status: string }>>(
      `${PATHS_BASE}/formador`,
      { bearer: adminToken },
    );
    expect(status).toBe(200);
    const titles = (body as Array<{ title: string }>).map((p) => p.title);
    expect(titles.some((t) => t.includes(`Ruta Con Cursos ${stamp}`))).toBe(true);
  });

  // ─── 12. Alumno no puede acceder al panel formador ───────────────────────────

  test('alumno sin rol editor recibe 403 al acceder al panel formador', async () => {
    const { status } = await api(`${PATHS_BASE}/formador`, { bearer: alumnoToken });
    expect(status).toBe(403);
  });
});
