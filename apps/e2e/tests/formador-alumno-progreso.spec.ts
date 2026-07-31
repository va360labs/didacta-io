import { expect, test } from '@playwright/test';
import {
  adminTokenForBootstrap,
  API_URL,
  bootstrapScenario,
  listEnrollments,
  trackProgress,
  type BootstrapResult,
} from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Spec del detalle de progreso por lección de un alumno (vista del formador).
 *
 * Contrato congelado:
 *   GET /api/v1/modules/learning/courses/:courseId/enrollments/:enrollmentId/progress
 *   Roles: super_admin | tenant_admin | formador.
 *     - Sin user  → 401 Unauthorized.
 *     - Rol no permitido (alumno) → 403 Forbidden.
 *     - Enrollment inexistente → 404 (ENROLLMENT_NOT_FOUND).
 *   Respuesta (EnrollmentProgressDetail): enrollmentId, userId, userEmail, userName,
 *   status, progressPercent, totalWatchedSeconds, lessonsCompleted, lessonsTotal,
 *   modules[].lessons[] con watchedSeconds / resumePositionSec / completed /
 *   completedAt / lastAccessedAt. Las lecciones nunca empezadas aparecen en 0.
 *
 * UI nueva: /formador/cursos/[id]/alumnos/[enrollmentId] con botón "Ver progreso"
 * en la tabla de /formador/cursos/[id]/alumnos.
 *
 * Estado de cobertura: las 4 pruebas están ACTIVAS. Las guardas 401/403 no
 * dependen de datos; el happy-path de shape y el flujo UI requieren stack vivo
 * (API_URL + web + DB con seed admin), igual que el resto de la suite e2e.
 */

const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';

test.describe('Detalle de progreso por lección de un alumno (HU-FORM-003)', () => {
  // ── ACTIVO: guarda de autorización (alumno no puede ver el detalle) ──────────
  test('alumno (rol no permitido) → 403 Forbidden', async () => {
    const scenario = await bootstrapScenario();

    // Self-enroll del alumno para tener un enrollmentId real.
    const enrollRes = await fetch(`${API_URL}/api/v1/modules/learning/enrollments/me`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${scenario.alumno.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ courseId: scenario.course.id }),
    });
    expect(enrollRes.ok, `self-enroll OK (got ${enrollRes.status})`).toBe(true);
    const enrollments = await listEnrollments(scenario.alumno.accessToken);
    const ours = enrollments.find((e) => e.courseId === scenario.course.id);
    expect(ours, 'enrollment del alumno').toBeDefined();

    // El propio alumno (rol básico) intenta consultar el detalle del formador.
    const res = await fetch(
      `${API_URL}/api/v1/modules/learning/courses/${scenario.course.id}/enrollments/${ours!.id}/progress`,
      { headers: { Authorization: `Bearer ${scenario.alumno.accessToken}` } },
    );
    expect(res.status, 'alumno no es formador/admin → 403').toBe(403);
  });

  // ── ACTIVO: guarda de autenticación (sin token) ──────────────────────────────
  test('sin sesión → 401 Unauthorized', async () => {
    const res = await fetch(
      `${API_URL}/api/v1/modules/learning/courses/course-x/enrollments/enr-x/progress`,
    );
    expect(res.status, 'sin Authorization → 401').toBe(401);
  });

  // ── ACTIVO: happy-path de shape del contrato ─────────────────────────────────
  // El bootstrap deja curso publicado + alumno matriculado + 1 lección completada
  // vía trackProgress (watchedSeconds + completed:true). Requiere stack vivo.
  test('formador → detalle con shape del contrato y lección con tiempo visto', async () => {
    const scenario = await bootstrapScenario();

    // Matrícula + progreso (deja watchedSeconds > 0 en la 1ª lección).
    const enrollRes = await fetch(`${API_URL}/api/v1/modules/learning/enrollments/me`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${scenario.alumno.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ courseId: scenario.course.id }),
    });
    expect(enrollRes.ok).toBe(true);
    const enrollments = await listEnrollments(scenario.alumno.accessToken);
    const ours = enrollments.find((e) => e.courseId === scenario.course.id);
    expect(ours).toBeDefined();
    const lessonId = scenario.course.modules[0]?.lessons[0]?.id;
    expect(lessonId).toBeDefined();
    await trackProgress({
      bearer: scenario.alumno.accessToken,
      enrollmentId: ours!.id,
      lessonId: lessonId!,
      durationSec: 90,
    });

    // El formador (admin seed con rol incluido) consulta el detalle.
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const res = await fetch(
      `${API_URL}/api/v1/modules/learning/courses/${scenario.course.id}/enrollments/${ours!.id}/progress`,
      { headers: { Authorization: `Bearer ${bearer}` } },
    );
    expect(res.ok, `detalle endpoint → 200 (got ${res.status})`).toBe(true);

    const detail = (await res.json()) as {
      enrollmentId: string;
      userId: string;
      userEmail: string | null;
      userName: string | null;
      status: string;
      progressPercent: number;
      totalWatchedSeconds: number;
      lessonsCompleted: number;
      lessonsTotal: number;
      modules: Array<{
        moduleId: string;
        moduleTitle: string;
        lessons: Array<{
          lessonId: string;
          lessonTitle: string;
          type: string;
          durationMinutes: number | null;
          watchedSeconds: number;
          resumePositionSec: number;
          completed: boolean;
          completedAt: string | null;
          lastAccessedAt: string | null;
        }>;
      }>;
    };

    // Cabecera del contrato.
    expect(detail.enrollmentId).toBe(ours!.id);
    expect(detail.userId).toBe(scenario.alumno.user.id);
    expect(detail.userEmail).toBe(scenario.alumno.email);
    expect(['ACTIVE', 'COMPLETED', 'CANCELLED', 'PAUSED']).toContain(detail.status);
    expect(detail.lessonsTotal).toBeGreaterThanOrEqual(1);
    expect(detail.lessonsCompleted).toBeGreaterThanOrEqual(1);
    expect(detail.totalWatchedSeconds).toBeGreaterThanOrEqual(90);

    // Estructura por módulo/lección con left-join del progreso.
    expect(detail.modules.length).toBeGreaterThanOrEqual(1);
    const allLessons = detail.modules.flatMap((m) => m.lessons);
    const tracked = allLessons.find((l) => l.lessonId === lessonId);
    expect(tracked, 'la lección con progreso aparece en el detalle').toBeDefined();
    expect(tracked!.completed).toBe(true);
    expect(tracked!.watchedSeconds).toBeGreaterThanOrEqual(90);
    expect(tracked!.completedAt).not.toBeNull();
  });

  // ── ACTIVO: flujo UI (página de detalle + botón "Ver progreso") ──────────────
  // Requiere stack vivo (web + API + DB con seed admin).
  test('UI: formador abre el detalle desde la tabla de alumnos', async ({ page }) => {
    const scenario: BootstrapResult = await bootstrapScenario();

    // Dejar al alumno matriculado y con progreso para que tenga filas que ver.
    const enrollRes = await fetch(`${API_URL}/api/v1/modules/learning/enrollments/me`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${scenario.alumno.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ courseId: scenario.course.id }),
    });
    expect(enrollRes.ok).toBe(true);
    const enrollments = await listEnrollments(scenario.alumno.accessToken);
    const ours = enrollments.find((e) => e.courseId === scenario.course.id);
    expect(ours).toBeDefined();
    const lessonId = scenario.course.modules[0]?.lessons[0]?.id;
    await trackProgress({
      bearer: scenario.alumno.accessToken,
      enrollmentId: ours!.id,
      lessonId: lessonId!,
      durationSec: 90,
    });

    // Login como formador/admin (token seed inyectado en el origin del web).
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: adminToken,
      user: {
        id: 'seed-admin',
        email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
        name: 'Admin E2E',
        tenantId: scenario.alumno.user.tenantId,
        tenantSlug,
        roles: ['super_admin', 'tenant_admin', 'formador'],
        mfaEnabled: true,
      },
    });

    // Tabla de alumnos del curso → clic en "Ver progreso" del alumno.
    await page.goto(`/formador/cursos/${scenario.course.id}/alumnos`);
    await expect(page.getByRole('heading', { name: 'Alumnos del curso' })).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(scenario.alumno.email, 'i') });
    await row.getByRole('link', { name: /Ver progreso/i }).click();

    // Página de detalle: nombre del alumno + StatCard "Tiempo total visto" +
    // al menos una fila de lección con su estado.
    await expect(page).toHaveURL(
      new RegExp(`/formador/cursos/${scenario.course.id}/alumnos/${ours!.id}$`),
    );
    await expect(page.getByText(scenario.alumno.email)).toBeVisible();
    await expect(page.getByText(/Tiempo total visto/i)).toBeVisible();
    await expect(page.getByText(scenario.course.modules[0]!.lessons[0]!.title)).toBeVisible();
  });
});
