import { expect, test } from '@playwright/test';
import { API_URL, adminSessionForBootstrap } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Borrar preguntas de un cuestionario no puede impedir añadir otras.
 *
 * Feedback de un creador (26-nov-2026): tras borrar preguntas, el editor no le
 * dejaba añadir más y acabó creando otro cuestionario. La pregunta borrada
 * seguía ocupando su posición (borrado lógico + `(quizId, position)` única) y
 * la nueva intentaba repetirla.
 *
 * Se hace como el creador: en el editor, borra la última pregunta y añade otra.
 */

const TENANT_SLUG = process.env.E2E_TENANT_SLUG ?? 'va360';

async function api<T>(path: string, bearer: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

test.describe('Editor de cuestionarios', () => {
  test('borrar la última pregunta y añadir otra funciona', async ({ page }) => {
    const admin = await adminSessionForBootstrap(TENANT_SLUG);
    const stamp = Date.now();

    const quiz = await api<{ id: string }>(
      '/api/v1/modules/assessments/quizzes',
      admin.accessToken,
      'POST',
      {
        title: `Cuestionario E2E ${stamp}`,
      },
    );
    for (const prompt of ['Pregunta uno', 'Pregunta dos']) {
      await api(
        `/api/v1/modules/assessments/quizzes/${quiz.id}/questions`,
        admin.accessToken,
        'POST',
        {
          type: 'SHORT_ANSWER',
          prompt,
        },
      );
    }

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: admin.accessToken,
      user: { ...admin.user, onboardingCompletedAt: new Date().toISOString() },
    });
    await page.goto(`/studio/quizzes/${quiz.id}`);
    await expect(page.getByText('Pregunta dos')).toBeVisible({ timeout: 20_000 });

    // Borrar la última (la del confirm nativo).
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Eliminar pregunta' }).last().click();
    await expect(page.getByText('Pregunta dos')).toHaveCount(0, { timeout: 10_000 });

    // Y añadir otra: antes la BD la rechazaba.
    await page.getByRole('button', { name: 'Añadir pregunta' }).click();
    await page.getByLabel('Tipo de pregunta').selectOption('SHORT_ANSWER');
    await page.getByLabel('Enunciado').fill('Pregunta tres');
    await page.getByRole('button', { name: 'Añadir pregunta' }).click();

    // El formulario solo se cierra si la API aceptó la pregunta (si falla, se
    // queda abierto con el error).
    await expect(page.getByLabel('Enunciado')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText('Pregunta tres')).toBeVisible();

    await expect
      .poll(async () => {
        const full = await api<{ questions: Array<{ prompt: string }> }>(
          `/api/v1/modules/assessments/quizzes/${quiz.id}`,
          admin.accessToken,
        );
        return full.questions.map((q) => q.prompt);
      })
      .toEqual(['Pregunta uno', 'Pregunta tres']);
  });
});
