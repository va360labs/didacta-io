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

    // 3) El QuizPlayer debe mostrar la portada del quiz
    await expect(page.getByText('Quiz E2E')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Iniciar quiz' }).click();

    // 4) Marcar la opción correcta y enviar
    // El input es radio (SINGLE_CHOICE); lo identificamos por su value (option id)
    await page
      .locator(`input[type="radio"][value="${correctOptionId}"]`)
      .check()
      .catch(async () => {
        // Si el input no expone value=optionId, probamos por label del partner Input
        await page.getByLabel('4').check();
      });

    await page.getByRole('button', { name: 'Enviar respuestas' }).click();

    // 5) Pantalla de resultado
    await expect(page.getByText(/100%/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/¡Aprobado!/)).toBeVisible();

    // 6) Refrescar y verificar que el curso quedó completado por el bridge
    await page.reload();
    await expect(page.getByText(/¡Curso completado!/)).toBeVisible({ timeout: 15_000 });
  });
});
