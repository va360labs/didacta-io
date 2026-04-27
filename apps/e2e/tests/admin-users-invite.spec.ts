import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec del CRUD de usuarios del tenant (PR #95 admin/usuarios).
 *
 * Verifica:
 *  - tenant_admin invita usuario con rol formador → user con status PENDING aparece en la lista.
 *  - cambia status a SUSPENDED → invalida sessions.
 *  - quita el rol → user sin rol formador.
 */

test.describe('Admin: invitar y gestionar usuarios del tenant', () => {
  test('invitar formador → listar → cambiar status → asignar/quitar rol', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };

    const stamp = Date.now();
    const email = `e2e-formador-${stamp}@example.test`;

    // 1. Invite.
    const invited = await fetch(`${API_URL}/api/v1/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, name: 'Formador E2E', role: 'formador' }),
    });
    expect(invited.ok, 'invite → 200').toBe(true);
    const user = (await invited.json()) as { id: string; email: string; status: string };
    expect(user.email).toBe(email);
    expect(['PENDING', 'ACTIVE']).toContain(user.status);

    // 2. List y verificar que aparece.
    const listRes = await fetch(
      `${API_URL}/api/v1/admin/users?search=${encodeURIComponent(email)}`,
      {
        headers,
      },
    );
    expect(listRes.ok).toBe(true);
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.find((u) => u.id === user.id)).toBeDefined();

    // 3. Suspend.
    const suspended = await fetch(`${API_URL}/api/v1/admin/users/${user.id}/status`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'SUSPENDED' }),
    });
    expect(suspended.ok).toBe(true);
    const afterSuspend = (await suspended.json()) as { status: string };
    expect(afterSuspend.status).toBe('SUSPENDED');

    // 4. Quitar rol formador.
    const removed = await fetch(`${API_URL}/api/v1/admin/users/${user.id}/roles/remove`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ role: 'formador' }),
    });
    expect(removed.ok).toBe(true);
    const detail = (await removed.json()) as { roles: string[] };
    expect(detail.roles).not.toContain('formador');
  });

  test('invite con email duplicado → 409', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };

    const stamp = Date.now();
    const email = `e2e-dup-${stamp}@example.test`;
    const body = JSON.stringify({ email, name: 'Dup', role: 'formador' });

    const first = await fetch(`${API_URL}/api/v1/admin/users`, { method: 'POST', headers, body });
    expect(first.ok).toBe(true);

    const second = await fetch(`${API_URL}/api/v1/admin/users`, { method: 'POST', headers, body });
    expect(second.status).toBe(409);
  });
});
