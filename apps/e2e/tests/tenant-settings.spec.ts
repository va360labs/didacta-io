import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';

/**
 * Spec del CRUD de tenant settings (PR #73 — TenantSettings persistente con
 * encryption AES-256-GCM at-rest).
 *
 * Verifica:
 *  - listAll vacío inicialmente / con metadata.
 *  - upsert no-secret y secret.
 *  - getOne con secret oculta el valor.
 *  - delete remueve la fila.
 */

test.describe('Tenant settings (PR #73)', () => {
  test('upsert plano + upsert secreto + getOne diferencia + delete', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };

    const stamp = Date.now();
    const scope = 'e2e-test';
    const plainKey = `plain-${stamp}`;
    const secretKey = `secret-${stamp}`;

    // 1. Upsert plano.
    const setPlain = await fetch(`${API_URL}/api/v1/tenant-settings/${scope}/${plainKey}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ value: { hello: 'world' }, isSecret: false }),
    });
    expect(setPlain.ok, 'upsert plain → 200').toBe(true);

    // 2. Upsert secreto.
    const setSecret = await fetch(`${API_URL}/api/v1/tenant-settings/${scope}/${secretKey}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ value: 'super-secret-token-xyz', isSecret: true }),
    });
    expect(setSecret.ok).toBe(true);

    // 3. GetOne plano devuelve valor.
    const getPlain = await fetch(`${API_URL}/api/v1/tenant-settings/${scope}/${plainKey}`, {
      headers,
    });
    expect(getPlain.ok).toBe(true);
    const plainBody = (await getPlain.json()) as {
      isSecret: boolean;
      value: { hello: string } | null;
    };
    expect(plainBody.isSecret).toBe(false);
    expect(plainBody.value?.hello).toBe('world');

    // 4. GetOne secreto NO devuelve valor.
    const getSecret = await fetch(`${API_URL}/api/v1/tenant-settings/${scope}/${secretKey}`, {
      headers,
    });
    expect(getSecret.ok).toBe(true);
    const secretBody = (await getSecret.json()) as { isSecret: boolean; value: unknown };
    expect(secretBody.isSecret).toBe(true);
    expect(secretBody.value).toBeNull();

    // 5. ListAll incluye ambos.
    const listAll = await fetch(`${API_URL}/api/v1/tenant-settings`, { headers });
    const items = (await listAll.json()) as Array<{ moduleName: string; key: string }>;
    const ours = items.filter((i) => i.moduleName === scope);
    expect(ours.find((i) => i.key === plainKey)).toBeDefined();
    expect(ours.find((i) => i.key === secretKey)).toBeDefined();

    // 6. Delete ambos.
    await fetch(`${API_URL}/api/v1/tenant-settings/${scope}/${plainKey}`, {
      method: 'DELETE',
      headers,
    });
    await fetch(`${API_URL}/api/v1/tenant-settings/${scope}/${secretKey}`, {
      method: 'DELETE',
      headers,
    });

    // 7. GetOne devuelve 404.
    const after = await fetch(`${API_URL}/api/v1/tenant-settings/${scope}/${plainKey}`, {
      headers,
    });
    expect(after.status).toBe(404);
  });
});
