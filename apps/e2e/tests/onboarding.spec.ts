import { expect, test } from '@playwright/test';
import { bootstrapScenario, API_URL } from '../helpers/api';

/**
 * Spec del onboarding de primera vez + preferencias de notificación (US-ONB).
 *
 * Verifica (API-driven):
 *  - GET /me/onboarding/status para un alumno recién creado → incompleto, falta avatar.
 *  - POST /me/onboarding/complete sin avatar → 422 con `missing`.
 *  - PATCH /me/profile acepta avatar relativo de storage + bio.
 *  - POST /me/onboarding/complete tras tener nombre + avatar → 200 y marca el flag.
 *  - Idempotencia: segunda llamada devuelve `alreadyCompleted` con el mismo timestamp.
 *  - GET/PUT /me/notification-preferences: 8 celdas default activadas + persistencia.
 */

test.describe('Onboarding de primera vez + preferencias (US-ONB)', () => {
  test('status → gate por avatar → completar → idempotente', async () => {
    const scenario = await bootstrapScenario();
    const headers = {
      Authorization: `Bearer ${scenario.alumno.accessToken}`,
      'Content-Type': 'application/json',
    };

    // 1. Estado inicial: no completado, falta avatar (el alumno ya tiene nombre).
    const st0 = await fetch(`${API_URL}/api/v1/me/onboarding/status`, { headers });
    expect(st0.ok).toBe(true);
    const status0 = (await st0.json()) as {
      completed: boolean;
      completedAt: string | null;
      missing: string[];
    };
    expect(status0.completed).toBe(false);
    expect(status0.completedAt).toBeNull();
    expect(status0.missing).toContain('avatar');

    // 2. Completar sin avatar → 422 con `missing`.
    const bad = await fetch(`${API_URL}/api/v1/me/onboarding/complete`, {
      method: 'POST',
      headers,
    });
    expect(bad.status).toBe(422);
    const badBody = (await bad.json()) as { missing?: string[] };
    expect(badBody.missing).toContain('avatar');

    // 3. Set avatar (ruta relativa de storage — válida tras relajar la validación) + bio.
    const patch = await fetch(`${API_URL}/api/v1/me/profile`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        avatarUrl: '/api/v1/storage/file/avatars/e2e.png',
        bio: 'Hola, soy E2E.',
      }),
    });
    expect(patch.ok).toBe(true);
    const patched = (await patch.json()) as { bio: string | null; avatarUrl: string | null };
    expect(patched.bio).toBe('Hola, soy E2E.');
    expect(patched.avatarUrl).toBe('/api/v1/storage/file/avatars/e2e.png');

    // 4. Completar → 200, marca el timestamp.
    const ok = await fetch(`${API_URL}/api/v1/me/onboarding/complete`, { method: 'POST', headers });
    expect(ok.ok).toBe(true);
    const okBody = (await ok.json()) as { ok: boolean; onboardingCompletedAt: string };
    expect(okBody.ok).toBe(true);
    expect(okBody.onboardingCompletedAt).toBeTruthy();

    // 5. Status ahora completado.
    const st1 = await fetch(`${API_URL}/api/v1/me/onboarding/status`, { headers });
    const status1 = (await st1.json()) as { completed: boolean; completedAt: string | null };
    expect(status1.completed).toBe(true);
    expect(status1.completedAt).toBe(okBody.onboardingCompletedAt);

    // 6. Idempotencia: segunda llamada no cambia el timestamp.
    const again = await fetch(`${API_URL}/api/v1/me/onboarding/complete`, {
      method: 'POST',
      headers,
    });
    expect(again.ok).toBe(true);
    const againBody = (await again.json()) as {
      alreadyCompleted?: boolean;
      onboardingCompletedAt: string;
    };
    expect(againBody.alreadyCompleted).toBe(true);
    expect(againBody.onboardingCompletedAt).toBe(okBody.onboardingCompletedAt);
  });

  test('matriz de preferencias de notificación: GET default + PUT persiste', async () => {
    const scenario = await bootstrapScenario();
    const headers = {
      Authorization: `Bearer ${scenario.alumno.accessToken}`,
      'Content-Type': 'application/json',
    };

    // 1. GET inicial: 8 combinaciones (4 categorías × 2 canales), todas activadas.
    const g0 = await fetch(`${API_URL}/api/v1/me/notification-preferences`, { headers });
    expect(g0.ok).toBe(true);
    const body0 = (await g0.json()) as {
      preferences: Array<{ category: string; channel: string; enabled: boolean }>;
    };
    expect(body0.preferences).toHaveLength(8);
    expect(body0.preferences.every((p) => p.enabled)).toBe(true);

    // 2. PUT: desactivar Comunidad×Email.
    const put = await fetch(`${API_URL}/api/v1/me/notification-preferences`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        preferences: [{ category: 'COMMUNITY', channel: 'EMAIL', enabled: false }],
      }),
    });
    expect(put.ok).toBe(true);

    // 3. GET refleja el cambio; el resto sigue activado.
    const g1 = await fetch(`${API_URL}/api/v1/me/notification-preferences`, { headers });
    const body1 = (await g1.json()) as {
      preferences: Array<{ category: string; channel: string; enabled: boolean }>;
    };
    const cell = body1.preferences.find((p) => p.category === 'COMMUNITY' && p.channel === 'EMAIL');
    expect(cell?.enabled).toBe(false);
    const learningEmail = body1.preferences.find(
      (p) => p.category === 'LEARNING' && p.channel === 'EMAIL',
    );
    expect(learningEmail?.enabled).toBe(true);
  });
});
