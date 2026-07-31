import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Bloque 2 — Encuesta post-clase (mod.surveys):
 *  - El admin crea una clase y fuerza la creación de la encuesta (endpoint
 *    idempotente, sin esperar al webhook de Zoom).
 *  - Un alumno la responde desde /clase/[id] (respuesta anónima) y ve el
 *    agradecimiento; recargar mantiene el estado (alreadyAnswered).
 *  - El segundo envío del mismo alumno devuelve 409 por API.
 *  - El admin ve los agregados: 1 respuesta, NPS 100 (un 10), texto libre.
 *
 * Usa sesión REAL (patrón de calendario-agenda.spec.ts).
 */

function isoIn(days: number, hour = 18): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

test.describe('Encuesta post-clase (mod.surveys)', () => {
  test('flujo completo: crear, responder en UI, dedupe y resultados', async ({ page }) => {
    test.setTimeout(120_000);
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    // 1. Clase de ayer (ya impartida).
    const topic = `Clase encuesta E2E ${stamp}`;
    const resSession = await fetch(`${API_URL}/api/v1/modules/zoom-live/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        topic,
        startTime: isoIn(-1),
        durationMinutes: 60,
        hostEmail: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
        timezone: 'Europe/Madrid',
      }),
    });
    expect(resSession.ok, `crear clase (${resSession.status})`).toBe(true);
    const session = (await resSession.json()) as { id: string };

    // 2. Encuesta post-clase — idempotente.
    const c1 = await fetch(`${API_URL}/api/v1/modules/surveys/admin/sessions/${session.id}`, {
      method: 'POST',
      headers,
    });
    expect(c1.ok, `crear encuesta (${c1.status})`).toBe(true);
    const created1 = (await c1.json()) as { surveyId: string; created: boolean };
    expect(created1.created).toBe(true);

    const c2 = await fetch(`${API_URL}/api/v1/modules/surveys/admin/sessions/${session.id}`, {
      method: 'POST',
      headers,
    });
    const created2 = (await c2.json()) as { surveyId: string; created: boolean };
    expect(created2.created).toBe(false);
    expect(created2.surveyId).toBe(created1.surveyId);

    // 3. Alumno responde desde la página de la clase.
    const alumno = await signup({
      tenantSlug,
      email: `e2e-encuesta-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumno Encuesta',
    });
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: alumno.tokens.accessToken,
      refreshToken: alumno.tokens.refreshToken,
      user: { ...alumno.user, onboardingCompletedAt: new Date().toISOString() },
    });
    await page.goto(`/clase/${session.id}`);

    const panel = page.getByTestId('survey-panel');
    await expect(panel.getByText('Valora esta clase')).toBeVisible();
    await panel
      .getByRole('button', { name: 'Del 0 al 10, ¿recomendarías esta clase a otro miembro?: 10' })
      .click();
    await panel.getByRole('button', { name: 'El contenido de la clase: 5' }).click();
    await panel.getByRole('button', { name: 'El ritmo y la claridad: 4' }).click();
    await panel.getByPlaceholder('Tu respuesta (opcional)').fill('Más ejemplos en directo');
    await panel.getByRole('button', { name: 'Enviar valoración' }).click();
    await expect(page.getByTestId('survey-thanks')).toBeVisible();

    // 4. El estado sobrevive a la recarga (alreadyAnswered por hash anónimo).
    await page.reload();
    await expect(page.getByTestId('survey-thanks')).toBeVisible();

    // 5. Doble envío por API → 409 (dedupe sin identificar al autor).
    const alumnoHeaders = {
      Authorization: `Bearer ${alumno.tokens.accessToken}`,
      'Content-Type': 'application/json',
    };
    const surveyRes = await fetch(`${API_URL}/api/v1/modules/surveys/sessions/${session.id}`, {
      headers: alumnoHeaders,
    });
    const surveyBody = (await surveyRes.json()) as {
      survey: {
        id: string;
        alreadyAnswered: boolean;
        questions: Array<{ id: string; type: string }>;
      };
    };
    expect(surveyBody.survey.alreadyAnswered).toBe(true);
    const dup = await fetch(`${API_URL}/api/v1/modules/surveys/${surveyBody.survey.id}/responses`, {
      method: 'POST',
      headers: alumnoHeaders,
      body: JSON.stringify({
        answers: surveyBody.survey.questions
          .filter((q) => q.type !== 'TEXT')
          .map((q) => ({ questionId: q.id, valueInt: q.type === 'NPS' ? 8 : 4 })),
      }),
    });
    expect(dup.status, 'segundo envío rechazado').toBe(409);

    // 6. Agregados del admin: 1 respuesta anónima, NPS 100, texto visible.
    const results = await fetch(
      `${API_URL}/api/v1/modules/surveys/admin/${created1.surveyId}/results`,
      { headers },
    );
    expect(results.ok, `resultados (${results.status})`).toBe(true);
    const body = (await results.json()) as {
      responseCount: number;
      questions: Array<{
        type: string;
        nps: { score: number } | null;
        average: number | null;
        texts: string[];
      }>;
    };
    expect(body.responseCount).toBe(1);
    expect(body.questions.find((q) => q.type === 'NPS')?.nps?.score).toBe(100);
    expect(body.questions.find((q) => q.type === 'TEXT')?.texts).toContain(
      'Más ejemplos en directo',
    );
  });
});
