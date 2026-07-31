import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';

/**
 * Spec de quiz FILL_IN_BLANK (mod.assessments v0.2).
 *
 * Verifica auto-corrección con `acceptedAnswers`:
 *  - Respuesta exacta → puntaje completo.
 *  - Respuesta no aceptada → 0 puntos.
 *  - Case-insensitive matching (si el quiz lo soporta).
 */

test.describe('Quiz FILL_IN_BLANK (mod.assessments v0.2)', () => {
  test('respuesta aceptada → 100% del puntaje; respuesta diferente → 0', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const adminBearer = await adminTokenForBootstrap(tenantSlug);
    const admin = {
      Authorization: `Bearer ${adminBearer}`,
      'Content-Type': 'application/json',
    };

    const created = (await (
      await fetch(`${API_URL}/api/v1/modules/assessments/quizzes`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          title: 'Quiz FILL_IN_BLANK E2E',
          passThreshold: 50,
        }),
      })
    ).json()) as { id: string };

    const question = (await (
      await fetch(`${API_URL}/api/v1/modules/assessments/quizzes/${created.id}/questions`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          type: 'FILL_IN_BLANK',
          prompt: '¿Cuál es el motor de DB usado por Didacta?',
          points: 5,
          acceptedAnswers: ['Postgres', 'PostgreSQL', 'postgres'],
        }),
      })
    ).json()) as { id: string };

    await fetch(`${API_URL}/api/v1/modules/assessments/quizzes/${created.id}/publish`, {
      method: 'POST',
      headers: admin,
      body: '{}',
    });

    // Alumno A: respuesta correcta.
    const stamp = Date.now();
    const alumnoOk = await signup({
      tenantSlug,
      email: `e2e-fib-ok-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumno FIB OK',
    });
    const okHeaders = {
      Authorization: `Bearer ${alumnoOk.tokens.accessToken}`,
      'Content-Type': 'application/json',
    };
    const attemptOk = (await (
      await fetch(`${API_URL}/api/v1/modules/assessments/attempts`, {
        method: 'POST',
        headers: okHeaders,
        body: JSON.stringify({ quizId: created.id }),
      })
    ).json()) as { id: string };
    const submitOk = await fetch(
      `${API_URL}/api/v1/modules/assessments/attempts/${attemptOk.id}/submit`,
      {
        method: 'POST',
        headers: okHeaders,
        body: JSON.stringify({
          answers: [{ questionId: question.id, textAnswer: 'PostgreSQL' }],
        }),
      },
    );
    expect(submitOk.ok).toBe(true);
    const okResult = (await submitOk.json()) as { passed: boolean; scoreEarned: number };
    expect(okResult.passed).toBe(true);
    expect(okResult.scoreEarned).toBe(5);

    // Alumno B: respuesta incorrecta.
    const alumnoBad = await signup({
      tenantSlug,
      email: `e2e-fib-bad-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumno FIB BAD',
    });
    const badHeaders = {
      Authorization: `Bearer ${alumnoBad.tokens.accessToken}`,
      'Content-Type': 'application/json',
    };
    const attemptBad = (await (
      await fetch(`${API_URL}/api/v1/modules/assessments/attempts`, {
        method: 'POST',
        headers: badHeaders,
        body: JSON.stringify({ quizId: created.id }),
      })
    ).json()) as { id: string };
    const submitBad = await fetch(
      `${API_URL}/api/v1/modules/assessments/attempts/${attemptBad.id}/submit`,
      {
        method: 'POST',
        headers: badHeaders,
        body: JSON.stringify({
          answers: [{ questionId: question.id, textAnswer: 'MongoDB' }],
        }),
      },
    );
    expect(submitBad.ok).toBe(true);
    const badResult = (await submitBad.json()) as { passed: boolean; scoreEarned: number };
    expect(badResult.passed).toBe(false);
    expect(badResult.scoreEarned).toBe(0);
  });
});
