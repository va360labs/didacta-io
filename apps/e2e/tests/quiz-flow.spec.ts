import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, createPublishedCourseWithQuiz, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Flujo: alumno realiza quiz desde la página del curso.
 *
 * Esto cierra el ciclo end-to-end de mod.assessments (PRs #44-49):
 * el alumno hace el quiz, lo aprueba, y el bridge backend (PR #47)
 * marca la lección QUIZ como completada vía evento.
 *
 * Pre-requisitos: igual que golden-path (E2E_ADMIN_EMAIL/PASSWORD apuntan
 * al seed admin del tenant).
 */
test.describe('mod.assessments — flujo del alumno', () => {
  test('alumno aprueba quiz → lección queda marcada completada y curso al 100%', async ({
    page,
  }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);

    const { course, correctOptionId } = await createPublishedCourseWithQuiz({
      bearer: adminToken,
      title: `Quiz E2E ${stamp}`,
      slug: `quiz-e2e-${stamp}`,
    });

    const alumnoEmail = `e2e-quiz-alumno-${stamp}@example.test`;
    const alumno = await signup({
      tenantSlug,
      email: alumnoEmail,
      password: 'E2eQuizAlumno123!',
      name: 'Alumno Quiz',
    });

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: alumno.tokens.accessToken,
      user: alumno.user,
    });

    // 1) Catálogo y entrada al curso
    await page.goto(`/cursos/${course.slug}`);
    await page.getByRole('button', { name: 'Matricularme' }).click();
    await expect(page.getByText('Tu progreso')).toBeVisible({ timeout: 15_000 });

    // 2) Click en la lección QUIZ desde el sidebar
    await page.getByRole('button', { name: /Quiz lesson/ }).click();

    // 3) El QuizPlayer debe mostrar la portada del quiz. Usamos el
    //    role heading para evitar matchear el h1 del header del curso
    //    (que también incluye 'Quiz E2E' por venir del título del curso).
    await expect(page.getByRole('heading', { name: 'Quiz E2E', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: /Empezar quiz|Reintentar quiz/ }).click();

    // 4) Marcar la opción correcta y enviar.
    // El QuizPlayer renderiza `<label><input type="radio"/><span>{label}</span></label>`
    // y el input NO expone `value` con el option id (el state se mantiene
    // en React via `checked` controlado). Identificamos la opción por
    // el texto del label (en este quiz: "4" es la respuesta correcta a
    // "¿2 + 2?", definido en el helper E2E createPublishedQuizForLesson).
    void correctOptionId; // referenciado solo para semantica del test
    await page.locator('label').filter({ hasText: '4' }).first().click();

    await page.getByRole('button', { name: 'Enviar respuestas' }).click();

    // 5) Pantalla de resultado: el header muestra `<score>%` + `· aprobado`.
    await expect(page.getByText(/100%/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('· aprobado')).toBeVisible();

    // 6) Refrescar y verificar que el curso quedó completado por el bridge
    await page.reload();
    await expect(page.getByText(/¡Curso completado!/)).toBeVisible({ timeout: 15_000 });
  });
});
