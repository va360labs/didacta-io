import { expect, test } from '@playwright/test';
import {
  adminTokenForBootstrap,
  bootstrapScenario,
  createPublishedCourse,
  API_URL,
} from '../helpers/api';

/**
 * Viaje 1 (alta manual + matrícula) — F5 de la arquitectura de captación.
 *
 * Cubre la superficie nueva de admin sobre la que se apoya la UI de la ficha
 * de usuario y el alta con aula:
 *  - matrícula directa por admin (POST /modules/learning/enrollments)
 *  - expediente con matrículas accionables (id + source) y grupos de acceso
 *  - baja administrativa (DELETE /modules/learning/enrollments/:id/by-admin)
 *    idempotente y re-matriculable (reactiva la fila CANCELLED, no duplica)
 *  - invitación con grupo de acceso: el invitado queda en el grupo y
 *    matriculado en sus cursos ANTES de estrenar la contraseña
 *  - la baja administrativa exige rol staff (un alumno recibe 403)
 *
 * Estilo API-only (como admin-users-invite.spec.ts): sin navegador, contra el
 * stack efímero. Un solo signin de admin cacheado para no tropezar con el
 * rate-limit de /auth/signin.
 */

const TENANT = process.env.E2E_TENANT_SLUG ?? 'demo';

let cachedAdminToken: string | null = null;
async function adminToken(): Promise<string> {
  if (!cachedAdminToken) cachedAdminToken = await adminTokenForBootstrap(TENANT);
  return cachedAdminToken;
}

async function adminHeaders(): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await adminToken()}`,
    'Content-Type': 'application/json',
  };
}

interface DossierShape {
  learning: {
    enrollments: Array<{
      id: string;
      courseId: string;
      courseTitle: string | null;
      status: string;
      source: string;
    }>;
  };
  accessGroups: Array<{ groupId: string; name: string; slug: string; source: string }>;
}

async function dossierOf(userId: string): Promise<DossierShape> {
  const res = await fetch(`${API_URL}/api/v1/admin/users/${userId}/dossier`, {
    headers: await adminHeaders(),
  });
  expect(res.ok, 'dossier → 200').toBe(true);
  return (await res.json()) as DossierShape;
}

async function inviteUser(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${API_URL}/api/v1/admin/users`, {
    method: 'POST',
    headers: await adminHeaders(),
    body: JSON.stringify(body),
  });
}

test.describe('Viaje 1: matrícula directa, ficha accionable y alta con aula', () => {
  test('matricular → dossier con id+source → baja administrativa → re-matricular reactiva', async () => {
    const headers = await adminHeaders();
    const stamp = Date.now();

    const course = await createPublishedCourse({
      bearer: await adminToken(),
      title: `Curso viaje1 ${stamp}`,
      slug: `curso-viaje1-${stamp}`,
    });

    const invited = await inviteUser({
      email: `e2e-viaje1-${stamp}@example.test`,
      name: 'Alumna Viaje1',
      role: 'alumno',
    });
    expect(invited.ok).toBe(true);
    const user = (await invited.json()) as { id: string };

    // Matrícula directa (el endpoint que la ficha usa desde F5).
    const enrollRes = await fetch(`${API_URL}/api/v1/modules/learning/enrollments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: user.id, courseId: course.id }),
    });
    expect(enrollRes.ok, 'enrollByAdmin → ok').toBe(true);
    const enrollment = (await enrollRes.json()) as { id: string; status: string; source: string };
    expect(enrollment.status).toBe('ACTIVE');
    expect(enrollment.source).toBe('ADMIN');

    // El expediente trae la matrícula con id + source (lo que la UI necesita
    // para pintar el badge de origen y ofrecer la baja) y sin grupos aún.
    let dossier = await dossierOf(user.id);
    const enDossier = dossier.learning.enrollments.find((e) => e.id === enrollment.id);
    expect(enDossier, 'la matrícula aparece en el expediente').toBeDefined();
    expect(enDossier?.source).toBe('ADMIN');
    expect(enDossier?.status).toBe('ACTIVE');
    expect(enDossier?.courseTitle).toContain('viaje1');
    expect(dossier.accessGroups).toEqual([]);

    // Baja administrativa: el admin NO es el dueño de la matrícula.
    const cancelRes = await fetch(
      `${API_URL}/api/v1/modules/learning/enrollments/${enrollment.id}/by-admin`,
      { method: 'DELETE', headers },
    );
    expect(cancelRes.ok, 'baja administrativa → 200').toBe(true);
    expect(((await cancelRes.json()) as { status: string }).status).toBe('CANCELLED');

    // Idempotente: repetir la baja no rompe.
    const cancelAgain = await fetch(
      `${API_URL}/api/v1/modules/learning/enrollments/${enrollment.id}/by-admin`,
      { method: 'DELETE', headers },
    );
    expect(cancelAgain.ok).toBe(true);

    dossier = await dossierOf(user.id);
    expect(dossier.learning.enrollments.find((e) => e.id === enrollment.id)?.status).toBe(
      'CANCELLED',
    );

    // Re-matricular reactiva la MISMA fila (no duplica, conserva progreso).
    const reEnroll = await fetch(`${API_URL}/api/v1/modules/learning/enrollments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: user.id, courseId: course.id }),
    });
    expect(reEnroll.ok).toBe(true);
    const reactivated = (await reEnroll.json()) as { id: string; status: string };
    expect(reactivated.id).toBe(enrollment.id);
    expect(reactivated.status).toBe('ACTIVE');
  });

  test('invitar con grupo de acceso: membresía + matrícula GROUP antes del primer login', async () => {
    const headers = await adminHeaders();
    const stamp = Date.now();

    const course = await createPublishedCourse({
      bearer: await adminToken(),
      title: `Curso aula ${stamp}`,
      slug: `curso-aula-${stamp}`,
    });

    const groupRes = await fetch(`${API_URL}/api/v1/modules/access-groups`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `Aula E2E ${stamp}`,
        kind: 'COURSE',
        courseIds: [course.id],
      }),
    });
    expect(groupRes.ok, 'crear grupo → ok').toBe(true);
    const group = (await groupRes.json()) as { id: string; name: string };

    const invited = await inviteUser({
      email: `e2e-aula-${stamp}@example.test`,
      name: 'Alumna Con Aula',
      role: 'alumno',
      accessGroupId: group.id,
    });
    expect(invited.ok, 'invite con grupo → ok').toBe(true);
    const user = (await invited.json()) as { id: string };

    // Sin tocar contraseña ni entrar nunca: ya está en el grupo y matriculada.
    const dossier = await dossierOf(user.id);
    const membership = dossier.accessGroups.find((g) => g.groupId === group.id);
    expect(membership, 'membresía visible en el expediente').toBeDefined();
    expect(membership?.source).toBe('MANUAL');
    const enrollment = dossier.learning.enrollments.find((e) => e.courseId === course.id);
    expect(enrollment, 'matrícula del curso del grupo').toBeDefined();
    expect(enrollment?.source).toBe('GROUP');
    expect(enrollment?.status).toBe('ACTIVE');
  });

  test('invitar con grupo inexistente → 404 y el user NO se crea', async () => {
    const stamp = Date.now();
    const email = `e2e-grupo-fantasma-${stamp}@example.test`;

    const invited = await inviteUser({
      email,
      role: 'alumno',
      accessGroupId: '00000000-0000-4000-8000-000000000000',
    });
    expect(invited.status).toBe(404);

    const listRes = await fetch(
      `${API_URL}/api/v1/admin/users?search=${encodeURIComponent(email)}`,
      { headers: await adminHeaders() },
    );
    expect(listRes.ok).toBe(true);
    const list = (await listRes.json()) as { items: unknown[] };
    expect(list.items, 'nada a medias: el alta abortó entera').toHaveLength(0);
  });

  test('la baja administrativa exige rol staff: un alumno recibe 403', async () => {
    const scenario = await bootstrapScenario();
    const headers = await adminHeaders();

    const enrollRes = await fetch(`${API_URL}/api/v1/modules/learning/enrollments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: scenario.alumno.user.id, courseId: scenario.course.id }),
    });
    expect(enrollRes.ok).toBe(true);
    const enrollment = (await enrollRes.json()) as { id: string };

    const asAlumno = await fetch(
      `${API_URL}/api/v1/modules/learning/enrollments/${enrollment.id}/by-admin`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${scenario.alumno.accessToken}` },
      },
    );
    expect(asAlumno.status, 'alumno sin rol staff → 403').toBe(403);
  });
});
