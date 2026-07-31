import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';

/**
 * Spec de quiz MULTIPLE_CHOICE (mod.assessments).
 *
 * Crea un quiz standalone con una pregunta MULTIPLE_CHOICE (≥2 correctas),
 * un alumno, lo intenta y verifica que el scoring auto reconoce las
 * combinaciones parciales correctamente.
 */

test.describe('Quiz MULTIPLE_CHOICE (mod.assessments)', () => {
  test('responder con todas las correctas → score completo', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const adminBearer = await adminTokenForBootstrap(tenantSlug);
    const admin = {
      Authorization: `Bearer ${adminBearer}`,
      'Content-Type': 'application/json',
    };

    // 1. Crear quiz standalone (sin lesson).
    const created = (await (
      await fetch(`${API_URL}/api/v1/modules/assessments/quizzes`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          title: 'Quiz MULTIPLE_CHOICE E2E',
          passThreshold: 60,
        }),
      })
    ).json()) as { id: string };

    // 2. Pregunta MULTIPLE_CHOICE con 2 opciones correctas y 2 incorrectas.
    const question = (await (
      await fetch(`${API_URL}/api/v1/modules/assessments/quizzes/${created.id}/questions`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          type: 'MULTIPLE_CHOICE',
          prompt: 'Marcá las afirmaciones verdaderas:',
          points: 10,
          options: [
            { label: 'Postgres es relacional', isCorrect: true },
            { label: 'Postgres es NoSQL', isCorrect: false },
            { label: 'Postgres soporta JSON', isCorrect: true },
            { label: 'Postgres no es ACID', isCorrect: false },
          ],
        }),
      })
    ).json()) as { id: string; options: Array<{ id: string; isCorrect: boolean }> };

    await fetch(`${API_URL}/api/v1/modules/assessments/quizzes/${created.id}/publish`, {
      method: 'POST',
      headers: admin,
      body: '{}',
    });

    // 3. Alumno se registra.
    const stamp = Date.now();
    const alumno = await signup({
      tenantSlug,
      email: `e2e-mc-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Alumno MC',
    });
    const alumnoHeaders = {
      Authorization: `Bearer ${alumno.tokens.accessToken}`,
      'Content-Type': 'application/json',
    };

    // 4. Start attempt.
    const attempt = (await (
      await fetch(`${API_URL}/api/v1/modules/assessments/attempts`, {
        method: 'POST',
        headers: alumnoHeaders,
        body: JSON.stringify({ quizId: created.id }),
      })
    ).json()) as { id: string };

    // 5. Submit con TODAS las correctas marcadas.
    const correctIds = question.options.filter((o) => o.isCorrect).map((o) => o.id);
    const submit = await fetch(
      `${API_URL}/api/v1/modules/assessments/attempts/${attempt.id}/submit`,
      {
        method: 'POST',
        headers: alumnoHeaders,
        body: JSON.stringify({
          answers: [{ questionId: question.id, selectedOptionIds: correctIds }],
        }),
      },
    );
    expect(submit.ok).toBe(true);
    const result = (await submit.json()) as {
      passed: boolean;
      scoreEarned: number;
      scoreMax: number;
    };
    expect(result.passed).toBe(true);
    expect(result.scoreEarned).toBe(10);
  });
});
