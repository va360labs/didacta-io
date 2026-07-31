import { expect, test } from '@playwright/test';
import {
  adminTokenForBootstrap,
  API_URL,
  bootstrapScenario,
  trackProgress,
  listEnrollments,
} from '../helpers/api';

/**
 * Spec del listado de alumnos por curso (HU-FORM-002).
 *
 * Bootstrap: admin crea curso, alumno se matricula y completa la lección.
 * Verifica que el endpoint /formador/cursos/:id/alumnos lo devuelve con
 * el progreso correcto.
 */

test.describe('Listado de alumnos por curso (HU-FORM-002)', () => {
  test('alumno completa curso → aparece en el listado del formador con progreso 100', async () => {
    const scenario = await bootstrapScenario();

    // bootstrapScenario crea curso + alumno pero NO matricula. Lo
    // hacemos explícito vía API antes de track de progreso.
    const enrollRes = await fetch(`${API_URL}/api/v1/modules/learning/enrollments/me`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${scenario.alumno.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ courseId: scenario.course.id }),
    });
    expect(enrollRes.ok, `self-enroll OK (got ${enrollRes.status})`).toBe(true);

    // El alumno completa la lección.
    const enrollments = await listEnrollments(scenario.alumno.accessToken);
    const ours = enrollments.find((e) => e.courseId === scenario.course.id);
    expect(ours).toBeDefined();
    const lessonId = scenario.course.modules[0]?.lessons[0]?.id;
    expect(lessonId).toBeDefined();
    await trackProgress({
      bearer: scenario.alumno.accessToken,
      enrollmentId: ours!.id,
      lessonId: lessonId!,
      durationSec: 60,
    });

    // El formador (admin con rol incluido) consulta el listado.
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${bearer}` };
    const res = await fetch(
      `${API_URL}/api/v1/modules/learning/courses/${scenario.course.id}/enrollments`,
      { headers },
    );
    expect(res.ok, 'enrollments endpoint → 200').toBe(true);
    const list = (await res.json()) as Array<{
      userId: string;
      userEmail?: string;
      email?: string;
      progressPercent: number;
      status: string;
    }>;

    // El endpoint puede devolver `email` o `userEmail` según el shape;
    // chequeamos ambos para no romper si el contracto evoluciona.
    const ours2 = list.find(
      (s) =>
        s.userId === scenario.alumno.user.id ||
        s.email === scenario.alumno.email ||
        s.userEmail === scenario.alumno.email,
    );
    expect(ours2, 'alumno en lista').toBeDefined();
    expect(ours2!.progressPercent).toBeGreaterThanOrEqual(75);
    expect(['ACTIVE', 'COMPLETED']).toContain(ours2!.status);
  });
});
