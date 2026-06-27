import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Spec de mod.payment-connections (conectar cuentas Stripe read-only +
 * reconciliar suscripciones contra usuarios Didacta por email).
 *
 * Cubre lo que es testeable SIN una cuenta Stripe real (el conectar/reconciliar
 * con datos reales requiere una restricted key de Stripe, fuera del alcance de
 * CI):
 *  - Contrato del endpoint admin: GET /connections como super_admin → 200 lista.
 *  - Validación: POST /connections con una API key con formato inválido → 400.
 *  - Gate de rol en backend: sin super_admin (token vacío) → 401/403.
 *  - UI: el panel `/admin/integraciones/payment-connections` carga para
 *    super_admin y muestra el form de conexión.
 *
 * El flujo completo conectar→reconciliar→invitar se valida manualmente contra
 * una cuenta Stripe de test (ver PRD en Notion).
 */

const BASE = '/api/v1/modules/payment-connections';

test.describe('mod.payment-connections — contrato admin + render del panel', () => {
  test('GET /connections (super_admin) lista; key inválida → 400; render del panel', async ({
    page,
  }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const apiHeaders = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };

    // 1) Listado vacío o no, pero contrato correcto: 200 + connections array.
    const listRes = await fetch(`${API_URL}${BASE}/connections`, { headers: apiHeaders });
    expect(listRes.status, 'GET /connections como super_admin → 200').toBe(200);
    const listBody = (await listRes.json()) as { connections: unknown };
    expect(Array.isArray(listBody.connections), 'connections es un array').toBe(true);

    // 2) Validación de la API key: formato inválido → 400 (zod), nunca llega a Stripe.
    const badRes = await fetch(`${API_URL}${BASE}/connections`, {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        provider: 'stripe',
        displayName: 'E2E inválida',
        apiKey: 'not-a-key',
      }),
    });
    expect(badRes.status, 'key con formato inválido → 400').toBe(400);

    // 3) Gate de rol: sin bearer → no autorizado.
    const noAuthRes = await fetch(`${API_URL}${BASE}/connections`, {
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403], 'sin token → 401/403').toContain(noAuthRes.status);

    // 4) Render del panel para super_admin.
    const meRes = await fetch(`${API_URL}/api/v1/me`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(meRes.ok, '/api/v1/me devuelve 200').toBe(true);
    const me = (await meRes.json()) as {
      id: string;
      email: string;
      tenantId: string;
      roles: string[];
    };

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: bearer,
      user: {
        id: me.id,
        email: me.email,
        name: 'Admin E2E',
        tenantId: me.tenantId,
        tenantSlug,
        roles: me.roles,
        mfaEnabled: true,
      },
    });

    await page.goto('/admin/integraciones/payment-connections');
    await expect(page.getByRole('heading', { name: 'Conexiones de pago' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Conectar una cuenta de Stripe')).toBeVisible({ timeout: 10_000 });
  });
});
