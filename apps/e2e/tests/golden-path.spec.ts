import { expect, test } from '@playwright/test';
import {
  bootstrapScenario,
  listEnrollments,
  trackProgress,
  type BootstrapResult,
} from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Golden path completo del alumno.
 *
 * Pre-requisitos para correrlo:
 * - API y web corriendo (E2E_BASE_URL apunta al web, E2E_API_URL al api).
 * - Seed inicial corrido con BOOTSTRAP_PASSWORD/BOOTSTRAP_EMAIL.
 * - Variables E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD apuntan a esas mismas credenciales.
 *
 * El flujo:
 * 1. Bootstrap: admin crea curso publicado (vía API). Alumno se registra (vía API).
 * 2. UI: el alumno ya logueado (token inyectado) entra al catálogo.
 * 3. UI: matricularse en el curso, completar la lección (vía API), refrescar.
 * 4. UI: ver tarjeta de certificado lista para descarga.
 * 5. UI: ir a /mis-certificados y verificar que el certificado aparece.
 */

test.describe('Golden path del alumno', () => {
  test('signup → matrícula → completar curso → certificado emitido', async ({ page, context }) => {
    const scenario: BootstrapResult = await bootstrapScenario();

    // Cargamos el origin antes de poder escribir storage.
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: scenario.alumno.accessToken,
      // Sin onboardingCompletedAt el alumno recién creado cae en el gate de
      // onboarding obligatorio ("Completa tu perfil para empezar") — este
      // spec no lo testea (eso lo cubre tests/onboarding.spec.ts).
      user: { ...scenario.alumno.user, onboardingCompletedAt: new Date().toISOString() },
    });

    // 1) Catálogo
    await page.goto('/cursos');
    await expect(page.getByRole('heading', { name: 'Catálogo' })).toBeVisible();
    await expect(page.getByText(scenario.course.title)).toBeVisible();

    // 2) Detalle del curso + matrícula por código de invitación (el botón
    // "Matricularme" de matrícula libre fue eliminado globalmente, ver
    // inscribe-by-api.spec.ts).
    await page.getByText(scenario.course.title).click();
    await expect(page).toHaveURL(new RegExp(`/cursos/${scenario.course.slug}$`));
    await page.getByLabel(/código de invitación/i).fill(scenario.invitationCode);

    // Sincronizamos contra la respuesta REAL del POST de canje, no contra un
    // texto en pantalla ("Tu progreso"): investigado a fondo (sesión de
    // retoma 2026-08-06, ver memoria "didacta-consistencia-eventual-me-enrollments")
    // — `getByText('Tu progreso').toBeVisible()` podía resolver en falso
    // positivo (~1/20 runs) ANTES de que el propio estado `enrollment` del
    // componente se actualizara, dejando una ventana de milisegundos donde
    // una llamada externa a GET /me/enrollments (fuera del navegador,
    // network-only) corría en paralelo con el POST y lo veía vacío. No era
    // consistencia eventual de Postgres/Prisma — confirmado con 2100+
    // lecturas directas contra la API sin ni una sola anomalía.
    const [byCodeResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/enrollments/by-code') && res.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Canjear código' }).click(),
    ]);
    expect(byCodeResponse.ok(), 'POST /enrollments/by-code debe responder 2xx').toBe(true);

    // 3) Completar la lección vía API (replica lo que haría LessonPlayer al final del video).
    // Ahora sí garantizado secuencial: el POST ya resolvió del lado servidor.
    const enrollments = await listEnrollments(scenario.alumno.accessToken);
    const ours = enrollments.find((e) => e.courseId === scenario.course.id);
    expect(ours, 'enrollment recién creada').toBeDefined();

    // La UI también debería reflejarlo (panel de progreso post-matrícula).
    await expect(page.getByText('Tu progreso')).toBeVisible({ timeout: 15_000 });
    const firstModule = scenario.course.modules[0];
    const firstLesson = firstModule?.lessons[0];
    expect(firstLesson, 'curso con al menos una lección').toBeDefined();
    const lessonId = firstLesson!.id;
    await trackProgress({
      bearer: scenario.alumno.accessToken,
      enrollmentId: ours!.id,
      lessonId,
      durationSec: 60,
    });

    // 4) Refrescar y ver tarjeta de certificado disponible.
    // El handler de learning.course.completed corre síncrono in-process,
    // así que el certificado debería existir tras la response del progress.
    // Aún así, dejamos un poco de margen para el outbox dispatch.
    await page.reload();
    await expect(page.getByText(/¡Curso completado!/)).toBeVisible({ timeout: 15_000 });
    const downloadBtn = page.getByRole('button', { name: /Descargar certificado/ });
    await expect(downloadBtn).toBeVisible({ timeout: 15_000 });

    // 5) Ir a /mis-certificados
    await page.goto('/mis-certificados');
    await expect(page.getByRole('heading', { name: 'Mis certificados' })).toBeVisible();
    await expect(page.getByText(scenario.course.title)).toBeVisible({ timeout: 10_000 });
    // El número correlativo tiene formato LS-{año}-{6 dígitos}
    await expect(page.getByText(/LS-\d{4}-\d{6}/)).toBeVisible();

    // Cleanup defensivo (Playwright cierra el context automáticamente).
    void context;
  });
});
