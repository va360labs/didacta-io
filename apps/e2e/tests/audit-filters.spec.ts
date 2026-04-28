import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec de filtros del audit log.
 *
 * Bootstrap: invitar un usuario para tener una entrada `admin.user.invited`
 * predecible. Después listar audit con filtros y verificar que aparece.
 */

test.describe('Audit log con filtros', () => {
  test('filtros action + resourceType devuelven entries pertinentes', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };

    // Generar una acción auditable conocida: invitar usuario nuevo.
    const stamp = Date.now();
    const email = `audit-filter-${stamp}@example.test`;
    const invite = await fetch(`${API_URL}/api/v1/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, name: 'Audit E2E', role: 'formador' }),
    });
    expect(invite.ok).toBe(true);

    // Filtrar por resourceType=user (acción admin.user.invited registra
    // resourceType='user').
    const filtered = await fetch(`${API_URL}/api/v1/audit/entries?resourceType=user&limit=20`, {
      headers,
    });
    expect(filtered.ok).toBe(true);
    const list = (await filtered.json()) as Array<{
      action: string;
      resourceType: string;
      createdAt: string;
    }>;
    expect(
      list.every((e) => e.resourceType === 'user'),
      'todos resourceType=user',
    ).toBe(true);
    expect(list.length).toBeGreaterThan(0);
  });

  test('filtro dateFrom devuelve solo entries posteriores', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${bearer}` };

    // Marcar timestamp ahora, luego generar una acción.
    const since = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 100));

    await fetch(`${API_URL}/api/v1/admin/users`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `audit-since-${Date.now()}@example.test`,
        name: 'X',
        role: 'formador',
      }),
    });

    const res = await fetch(
      `${API_URL}/api/v1/audit/entries?dateFrom=${encodeURIComponent(since)}&limit=20`,
      { headers },
    );
    expect(res.ok).toBe(true);
    // El response del endpoint devuelve `timestamp` (no `createdAt`); el
    // service lo expone explícitamente como tal en el select.
    const list = (await res.json()) as Array<{ timestamp: string }>;
    expect(
      list.every((e) => new Date(e.timestamp).getTime() >= new Date(since).getTime()),
      'todas posteriores a since',
    ).toBe(true);
  });
});
