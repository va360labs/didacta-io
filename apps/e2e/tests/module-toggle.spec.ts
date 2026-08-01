import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec del toggle de módulos por tenant + guard runtime (HU-TA-002 + #118).
 *
 * Verifica:
 *  - El admin puede desactivar un módulo NO-core (`mod.resources`) desde la API admin.
 *  - Cuando está desactivado, los endpoints del módulo devuelven 403.
 *  - Re-activar lo deja accesible nuevamente.
 *  - Un módulo core (`mod.community`) NO se puede desactivar: 422
 *    CORE_MODULE_NOT_DISABLEABLE (contrato desde alpha.10; antes este spec
 *    desactivaba community y quedó obsoleto al declararse core).
 *
 * Este spec NO usa UI — el ciclo completo se prueba a nivel HTTP, lo que
 * hace este test rápido y robusto. La UI tiene su propio smoke separado.
 */

test.describe('Toggle de módulos por tenant (HU-TA-002 + guard runtime)', () => {
  test('desactivar mod.resources → endpoint responde 403; reactivar → 200', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${bearer}` };

    // Estado inicial: el módulo resources está en el catálogo del tenant.
    const initialList = await fetch(`${API_URL}/api/v1/admin/modules`, { headers });
    expect(initialList.ok).toBe(true);
    const modules = (await initialList.json()) as Array<{ name: string; enabled: boolean }>;
    const resources = modules.find((m) => m.name === 'mod.resources');
    expect(resources, 'mod.resources esta cargado').toBeDefined();

    // Desactivar.
    const disable = await fetch(
      `${API_URL}/api/v1/admin/modules/${encodeURIComponent('mod.resources')}/disable`,
      { method: 'POST', headers, body: '{}' },
    );
    expect(disable.ok, 'disable responde 200').toBe(true);

    // Esperar a que la cache del interceptor invalide (TenantModulesService.disable lo
    // hace síncrono, así que basta con ceder el event loop).
    await new Promise((r) => setTimeout(r, 50));

    // Verificar que el endpoint del módulo ahora responde 403.
    const blocked = await fetch(`${API_URL}/api/v1/modules/resources/collections`, { headers });
    expect(blocked.status, 'resources collections → 403 cuando desactivado').toBe(403);

    // Re-activar.
    const enable = await fetch(
      `${API_URL}/api/v1/admin/modules/${encodeURIComponent('mod.resources')}/enable`,
      { method: 'POST', headers, body: '{}' },
    );
    expect(enable.ok, 'enable responde 200').toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    // Verificar que vuelve a responder.
    const restored = await fetch(`${API_URL}/api/v1/modules/resources/collections`, { headers });
    expect(restored.status, 'resources collections → 200 tras reactivar').toBe(200);
  });

  test('un módulo core (mod.community) no se puede desactivar → 422', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${bearer}` };

    const disable = await fetch(
      `${API_URL}/api/v1/admin/modules/${encodeURIComponent('mod.community')}/disable`,
      { method: 'POST', headers, body: '{}' },
    );
    expect(disable.status, 'disable de un core responde 422').toBe(422);
    const body = (await disable.json()) as { code?: string };
    expect(body.code, 'código CORE_MODULE_NOT_DISABLEABLE').toBe('CORE_MODULE_NOT_DISABLEABLE');

    // Y el módulo sigue respondiendo con normalidad.
    const stillUp = await fetch(`${API_URL}/api/v1/modules/community/posts`, { headers });
    expect(stillUp.status, 'community posts sigue en 200').toBe(200);
  });
});
