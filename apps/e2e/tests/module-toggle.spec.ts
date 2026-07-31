import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec del toggle de módulos por tenant + guard runtime (HU-TA-002 + #118).
 *
 * Verifica:
 *  - El admin puede desactivar `mod.community` desde la API admin.
 *  - Cuando está desactivado, los endpoints de community devuelven 403.
 *  - Re-activar lo deja accesible nuevamente.
 *
 * Este spec NO usa UI — el ciclo completo se prueba a nivel HTTP, lo que
 * hace este test rápido y robusto. La UI tiene su propio smoke separado.
 */

test.describe('Toggle de módulos por tenant (HU-TA-002 + guard runtime)', () => {
  test('desactivar mod.community → endpoint responde 403; reactivar → 200', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${bearer}` };

    // Estado inicial: el módulo community debería responder a GET con 200.
    const initialList = await fetch(`${API_URL}/api/v1/admin/modules`, { headers });
    expect(initialList.ok).toBe(true);
    const modules = (await initialList.json()) as Array<{ name: string; enabled: boolean }>;
    const community = modules.find((m) => m.name === 'mod.community');
    expect(community, 'mod.community esta cargado').toBeDefined();

    // Desactivar.
    const disable = await fetch(
      `${API_URL}/api/v1/admin/modules/${encodeURIComponent('mod.community')}/disable`,
      { method: 'POST', headers, body: '{}' },
    );
    expect(disable.ok, 'disable responde 200').toBe(true);

    // Esperar a que la cache del interceptor invalide (TenantModulesService.disable lo
    // hace síncrono, así que basta con ceder el event loop).
    await new Promise((r) => setTimeout(r, 50));

    // Verificar que el endpoint del módulo ahora responde 403.
    const blocked = await fetch(`${API_URL}/api/v1/modules/community/posts`, { headers });
    expect(blocked.status, 'community posts → 403 cuando desactivado').toBe(403);

    // Re-activar.
    const enable = await fetch(
      `${API_URL}/api/v1/admin/modules/${encodeURIComponent('mod.community')}/enable`,
      { method: 'POST', headers, body: '{}' },
    );
    expect(enable.ok, 'enable responde 200').toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    // Verificar que vuelve a responder.
    const restored = await fetch(`${API_URL}/api/v1/modules/community/posts`, { headers });
    expect(restored.status, 'community posts → 200 tras reactivar').toBe(200);
  });
});
