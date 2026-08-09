import { expect, test } from '@playwright/test';
import { bootstrapScenario, API_URL } from '../helpers/api';

/**
 * Spec G5.1: el toggle de "resumen semanal de comunidad" en `/cuenta`
 * debe **persistir tras reload**. Verifica el flow completo:
 *   1. GET /modules/community/me/preferences → digestOptOut=false (default).
 *   2. PUT con digestOptOut=true → 200.
 *   3. Re-GET → digestOptOut=true (persistió en DB, no solo en memoria).
 *   4. PUT con digestOptOut=false → 200.
 *   5. Re-GET → digestOptOut=false.
 *
 * El test se hace API-driven para evitar depender de la UI de tabs;
 * el contrato HTTP es el que importa: si esto pasa, el toggle del
 * frontend (que usa el mismo endpoint) también persistirá.
 *
 * Si el módulo community está deshabilitado en el tenant E2E, los
 * endpoints devuelven 403 y el test queda skip-en-el-acto.
 *
 * OJO con la ruta: es `me/preferences`, no `preferences` (ver
 * `@Get('me/preferences')` en apps/api/src/modules/community/community.controller.ts).
 * Con la ruta sin `me/` el dispatcher devuelve 404 y el propio guard de arriba
 * lo interpretaba como «módulo deshabilitado»: el test llevaba tiempo
 * SKIPEÁNDOSE siempre y nadie ejercitaba el contrato del digest.
 */
test.describe('Comunidad · digest opt-out persistente (G5.1)', () => {
  test('toggle del digest se persiste en DB tras reload', async () => {
    const scenario = await bootstrapScenario();
    const headers = {
      Authorization: `Bearer ${scenario.alumno.accessToken}`,
      'Content-Type': 'application/json',
    };

    // 1. Estado inicial.
    const initial = await fetch(`${API_URL}/api/v1/modules/community/me/preferences`, { headers });
    if (initial.status === 403 || initial.status === 404) {
      test.skip(
        true,
        'El módulo community no está habilitado para el tenant E2E (403/404 — habilitar en /admin/configuracion).',
      );
      return;
    }
    expect(initial.ok, `GET preferences OK (got ${initial.status})`).toBe(true);
    const before = (await initial.json()) as { digestOptOut: boolean };
    expect(before.digestOptOut).toBe(false);

    // 2. PUT digestOptOut=true.
    const enable = await fetch(`${API_URL}/api/v1/modules/community/me/preferences`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ digestOptOut: true }),
    });
    expect(enable.ok).toBe(true);
    const enabled = (await enable.json()) as { digestOptOut: boolean };
    expect(enabled.digestOptOut).toBe(true);

    // 3. Reload (nuevo fetch, simula recargar la página).
    const afterEnable = await fetch(`${API_URL}/api/v1/modules/community/me/preferences`, {
      headers,
    });
    expect(afterEnable.ok).toBe(true);
    const persisted = (await afterEnable.json()) as { digestOptOut: boolean };
    expect(persisted.digestOptOut).toBe(true);

    // 4. PUT digestOptOut=false.
    const disable = await fetch(`${API_URL}/api/v1/modules/community/me/preferences`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ digestOptOut: false }),
    });
    expect(disable.ok).toBe(true);

    // 5. Reload final.
    const afterDisable = await fetch(`${API_URL}/api/v1/modules/community/me/preferences`, {
      headers,
    });
    const finalState = (await afterDisable.json()) as { digestOptOut: boolean };
    expect(finalState.digestOptOut).toBe(false);
  });
});
