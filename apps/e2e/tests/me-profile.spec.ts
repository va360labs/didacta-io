import { expect, test } from '@playwright/test';
import { bootstrapScenario, API_URL } from '../helpers/api';

/**
 * Spec del perfil del usuario (HU-USR-001).
 *
 * Verifica:
 *  - GET /me/profile devuelve perfil del alumno con shape esperado.
 *  - PATCH /me/profile actualiza name + locale + timezone.
 *  - PATCH con avatarUrl no-https → 400.
 *  - POST /me/security/password con currentPassword incorrecta → 403.
 */

test.describe('Perfil del usuario (HU-USR-001)', () => {
  test('GET → PATCH actualiza name + locale + timezone', async () => {
    const scenario = await bootstrapScenario();
    const headers = {
      Authorization: `Bearer ${scenario.alumno.accessToken}`,
      'Content-Type': 'application/json',
    };

    // 1. GET inicial.
    const initial = await fetch(`${API_URL}/api/v1/me/profile`, { headers });
    expect(initial.ok).toBe(true);
    const profile = (await initial.json()) as {
      id: string;
      email: string;
      name: string | null;
      locale: string;
      timezone: string;
      mfaEnabled: boolean;
    };
    expect(profile.email).toBe(scenario.alumno.email);

    // 2. PATCH.
    const patch = await fetch(`${API_URL}/api/v1/me/profile`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        name: 'Nombre Actualizado E2E',
        locale: 'es-AR',
        timezone: 'America/Argentina/Buenos_Aires',
      }),
    });
    expect(patch.ok).toBe(true);
    const updated = (await patch.json()) as {
      name: string;
      locale: string;
      timezone: string;
    };
    expect(updated.name).toBe('Nombre Actualizado E2E');
    expect(updated.locale).toBe('es-AR');
    expect(updated.timezone).toBe('America/Argentina/Buenos_Aires');
  });

  test('PATCH con avatarUrl no-https → 400', async () => {
    const scenario = await bootstrapScenario();
    const headers = {
      Authorization: `Bearer ${scenario.alumno.accessToken}`,
      'Content-Type': 'application/json',
    };
    const res = await fetch(`${API_URL}/api/v1/me/profile`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ avatarUrl: 'http://insecure.com/avatar.png' }),
    });
    expect(res.status).toBe(400);
  });

  test('POST /me/security/password con currentPassword incorrecta → 403', async () => {
    const scenario = await bootstrapScenario();
    const headers = {
      Authorization: `Bearer ${scenario.alumno.accessToken}`,
      'Content-Type': 'application/json',
    };
    const res = await fetch(`${API_URL}/api/v1/me/security/password`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        currentPassword: 'WRONG-password-123',
        newPassword: 'CorrectNewPassword123!',
      }),
    });
    expect(res.status).toBe(403);
  });
});
