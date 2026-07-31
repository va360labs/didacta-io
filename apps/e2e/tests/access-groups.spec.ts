import { expect, test } from '@playwright/test';
import {
  API_URL,
  adminTokenForBootstrap,
  createPublishedCourse,
  listEnrollments,
  signup,
} from '../helpers/api';

/**
 * E2E de mod.access-groups (Fase 2): grupos de acceso que materializan
 * enrollments (source GROUP) vía fan-out, con revocación segura por refcount.
 *
 * Cubre:
 *  - AC-G2: asignar un miembro a un grupo MULTI_COURSE crea un enrollment por curso.
 *  - AC-G7: editar el set de cursos del grupo reconcilia (añade/revoca) enrollments.
 *  - AC-G4: al quitar un curso (o revocar al miembro), el enrollment se CANCELA por refcount.
 *  - AC-G3: un grupo ALL_COURSES matricula al miembro en todos los cursos publicados.
 *
 * Requiere stack vivo (API en E2E_API_URL) + seed con admin (E2E_ADMIN_EMAIL/PASSWORD)
 * + migración 20260625000002_add_access_groups aplicada.
 */

/** Cliente directo a los endpoints del módulo (el helper `api` interno no se exporta). */
async function ag<T>(method: string, path: string, bearer: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_URL}/api/v1/modules/access-groups${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : res.statusText;
    throw new Error(`access-groups ${method} ${path} -> ${res.status}: ${message}`);
  }
  return parsed as T;
}

interface GroupDetail {
  id: string;
  kind: string;
  courseIds: string[];
  memberCount: number;
}

function status(
  enrollments: Array<{ courseId: string; status: string }>,
  courseId: string,
): string | null {
  return enrollments.find((e) => e.courseId === courseId)?.status ?? null;
}

test.describe('mod.access-groups (Fase 2)', () => {
  test('MULTI_COURSE: asignar fan-out, reconciliar cursos y revocar por refcount', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);

    const cA = await createPublishedCourse({
      bearer: adminToken,
      title: `AG Curso A ${stamp}`,
      slug: `ag-curso-a-${stamp}`,
    });
    const cB = await createPublishedCourse({
      bearer: adminToken,
      title: `AG Curso B ${stamp}`,
      slug: `ag-curso-b-${stamp}`,
    });

    const alumno = await signup({
      tenantSlug,
      email: `e2e-ag-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumno AG',
    });
    const alumnoId = alumno.user.id;
    const alumnoToken = alumno.tokens.accessToken;

    // 1) Crear grupo MULTI_COURSE con [cA].
    const group = await ag<GroupDetail>('POST', '', adminToken, {
      name: `Grupo AG ${stamp}`,
      kind: 'MULTI_COURSE',
      courseIds: [cA.id],
    });
    expect(group.courseIds).toContain(cA.id);

    // 2) Asignar al alumno → un enrollment ACTIVE en cA, nada en cB. (AC-G2)
    await ag('POST', `/${group.id}/members`, adminToken, { userIds: [alumnoId] });
    let enr = await listEnrollments(alumnoToken);
    expect(status(enr, cA.id)).toBe('ACTIVE');
    expect(status(enr, cB.id)).toBeNull();

    // 3) Añadir cB al grupo → el alumno queda matriculado también en cB. (AC-G7)
    await ag('PUT', `/${group.id}/courses`, adminToken, { courseIds: [cA.id, cB.id] });
    enr = await listEnrollments(alumnoToken);
    expect(status(enr, cA.id)).toBe('ACTIVE');
    expect(status(enr, cB.id)).toBe('ACTIVE');

    // 4) Quitar cA del grupo → enrollment de cA CANCELADO por refcount; cB sigue. (AC-G4/G7)
    await ag('PUT', `/${group.id}/courses`, adminToken, { courseIds: [cB.id] });
    enr = await listEnrollments(alumnoToken);
    expect(status(enr, cA.id)).toBe('CANCELLED');
    expect(status(enr, cB.id)).toBe('ACTIVE');

    // 5) Revocar al miembro → cB también CANCELADO. (AC-G4)
    await ag('DELETE', `/${group.id}/members/${alumnoId}`, adminToken);
    enr = await listEnrollments(alumnoToken);
    expect(status(enr, cB.id)).toBe('CANCELLED');
  });

  test('ALL_COURSES: asignar matricula en todos los cursos publicados', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now() + 1;
    const adminToken = await adminTokenForBootstrap(tenantSlug);

    const course = await createPublishedCourse({
      bearer: adminToken,
      title: `AG All ${stamp}`,
      slug: `ag-all-${stamp}`,
    });

    const alumno = await signup({
      tenantSlug,
      email: `e2e-ag-all-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumno AG All',
    });

    const group = await ag<GroupDetail>('POST', '', adminToken, {
      name: `Grupo AG All ${stamp}`,
      kind: 'ALL_COURSES',
    });
    expect(group.kind).toBe('ALL_COURSES');

    await ag('POST', `/${group.id}/members`, adminToken, { userIds: [alumno.user.id] });
    const enr = await listEnrollments(alumno.tokens.accessToken);
    // El curso recién publicado está en "todos los publicados" → el alumno queda matriculado.
    expect(status(enr, course.id)).toBe('ACTIVE');
  });
});
