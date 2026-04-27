import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec super_admin CRUD de tenants (HU-SA-001 / LMS-110).
 *
 * Verifica que el super_admin puede:
 *  - Listar tenants.
 *  - Crear un tenant nuevo (DRY-RUN — solo si el seed user es super_admin).
 *  - Suspenderlo y reactivarlo.
 *
 * NOTA: requiere que E2E_ADMIN_EMAIL apunte a un usuario con rol
 * super_admin. Si solo es tenant_admin, el primer GET ya devolverá 403 y
 * el spec se skipea (no falla).
 */

test.describe('Super_admin tenants CRUD (HU-SA-001)', () => {
  test('flow completo: list → create → suspend → reactivate', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };

    const probe = await fetch(`${API_URL}/api/v1/admin/tenants`, { headers });
    test.skip(
      probe.status === 403,
      'E2E_ADMIN_EMAIL no es super_admin — spec irrelevante para este seed',
    );
    expect(probe.ok, 'list → 200 si el user es super_admin').toBe(true);
    const list = (await probe.json()) as Array<{ id: string; slug: string }>;
    expect(Array.isArray(list)).toBe(true);

    const stamp = Date.now();
    const newSlug = `e2e-tenant-${stamp}`;
    const newHostname = `e2e-${stamp}.localhost`;

    // Create.
    const created = await fetch(`${API_URL}/api/v1/admin/tenants`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        slug: newSlug,
        name: `E2E Tenant ${stamp}`,
        adminEmail: `admin-${stamp}@example.test`,
        primaryHostname: newHostname,
      }),
    });
    expect(created.ok, 'create → 200').toBe(true);
    const tenant = (await created.json()) as { id: string; slug: string; status: string };
    expect(tenant.slug).toBe(newSlug);
    expect(tenant.status).toBe('ACTIVE');

    // Suspend.
    const suspend = await fetch(`${API_URL}/api/v1/admin/tenants/${tenant.id}/status`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'SUSPENDED' }),
    });
    expect(suspend.ok).toBe(true);

    // Reactivate.
    const reactivate = await fetch(`${API_URL}/api/v1/admin/tenants/${tenant.id}/status`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'ACTIVE' }),
    });
    expect(reactivate.ok).toBe(true);
    const final = (await reactivate.json()) as { status: string };
    expect(final.status).toBe('ACTIVE');
  });

  test('rechaza slug inválido (no DNS-safe)', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };

    const probe = await fetch(`${API_URL}/api/v1/admin/tenants`, { headers });
    test.skip(probe.status === 403, 'no super_admin');

    const bad = await fetch(`${API_URL}/api/v1/admin/tenants`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        slug: 'INVALID_UPPERCASE',
        name: 'X',
        adminEmail: 'x@example.test',
        primaryHostname: 'invalid.test',
      }),
    });
    expect(bad.status).toBe(400);
  });
});
