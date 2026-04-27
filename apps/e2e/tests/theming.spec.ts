import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec del theming por tenant (mod.theming v0.1).
 *
 * Verifica el ciclo:
 *  - GET /modules/theming/me devuelve el theme actual.
 *  - PUT /modules/theming/me actualiza primaryHue/saturation y persiste.
 *  - POST /modules/theming/me/reset restaura defaults Didacta.
 */

test.describe('Theming por tenant (mod.theming)', () => {
  test('GET → PUT (cambio de hue) → GET → reset → defaults restaurados', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };

    // 1. Estado inicial.
    const initial = await fetch(`${API_URL}/api/v1/modules/theming/me`, { headers });
    expect(initial.ok).toBe(true);
    const before = (await initial.json()) as { brandHue: number; brandSaturation: number };
    expect(typeof before.brandHue).toBe('number');
    expect(typeof before.brandSaturation).toBe('number');

    // 2. Update — usar un hue distinto al default y dentro de [0, 360).
    const targetHue = before.brandHue === 200 ? 50 : 200;
    const updated = await fetch(`${API_URL}/api/v1/modules/theming/me`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ brandHue: targetHue, brandSaturation: 80 }),
    });
    expect(updated.ok, 'PUT /theming/me → 200').toBe(true);
    const afterUpdate = (await updated.json()) as { brandHue: number; brandSaturation: number };
    expect(afterUpdate.brandHue).toBe(targetHue);
    expect(afterUpdate.brandSaturation).toBe(80);

    // 3. GET vuelve a confirmar.
    const reread = await fetch(`${API_URL}/api/v1/modules/theming/me`, { headers });
    const persisted = (await reread.json()) as { brandHue: number };
    expect(persisted.brandHue).toBe(targetHue);

    // 4. Reset → restaurado.
    const reset = await fetch(`${API_URL}/api/v1/modules/theming/me/reset`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(reset.ok, 'reset → 200').toBe(true);
    const afterReset = (await reset.json()) as { brandHue: number };
    expect(afterReset.brandHue).not.toBe(targetHue);
  });

  test('PUT con brandHue fuera de rango → 400', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };
    const res = await fetch(`${API_URL}/api/v1/modules/theming/me`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ brandHue: 999, brandSaturation: 50 }),
    });
    expect(res.status).toBe(400);
  });
});
