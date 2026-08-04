import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signup } from '../helpers/api';

/**
 * Contrato de `/admin/license` (B1 de `work/migracion-env-a-panel.md` +
 * L0 de `work/motor-licencias-propuesta.md`): activar/leer/borrar la
 * licencia desde el panel, con validación en vivo y recarga en caliente.
 *
 * Lo que este spec NO puede cubrir contra un host de desarrollo compartido:
 * el camino "clave válida → active" requiere un JWT firmado ES256 cuya
 * clave pública esté embebida en `packages/license-sdk/src/public-keys/`.
 * Esas claves NO son secretas, pero la privada correspondiente sí lo es
 * (vive en AWS KMS de VA360) — no hay forma de firmar un JWT válido desde
 * este spec sin ella. Ese camino se cubre con un fake `LicenseService` en
 * `apps/api/tests/license-admin.service.test.ts` (unit) y se verificó
 * manualmente en local con un par de claves efímero (ver handoff de sesión).
 *
 * Si el host de e2e corre con `DIDACTA_LICENSE_KEY` seteada por env, el
 * panel pasa a solo lectura (`managedByEnv=true`) — el spec detecta esto y
 * ajusta las aserciones en vez de asumir un estado fijo.
 */

test.describe('Admin License — contrato de /admin/license', () => {
  test('super_admin: rechaza clave inválida sin tocar el estado guardado; sin clave → community', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' };

    const before = await fetch(`${API_URL}/api/v1/admin/license`, { headers }).then((r) =>
      r.json(),
    );
    expect(before).toHaveProperty('status');
    expect(before).toHaveProperty('capabilities');
    expect(before).toHaveProperty('warnings');

    const putRes = await fetch(`${API_URL}/api/v1/admin/license`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ key: 'no-soy-un-jwt-valido' }),
    });

    if (before.managedByEnv) {
      // El operador fijó la key por env: el panel es solo lectura, cualquier
      // intento de escritura se rechaza con conflicto ANTES de validar la firma.
      expect(putRes.status).toBe(409);
    } else {
      // Sin env: la key se valida antes de persistir. Un JWT malformado
      // nunca pasa la verificación ES256 → 400, y el estado no cambia.
      expect(putRes.status).toBe(400);
      const body = await putRes.json();
      expect(body.message).toMatch(/inválida/i);

      const after = await fetch(`${API_URL}/api/v1/admin/license`, { headers }).then((r) =>
        r.json(),
      );
      expect(after.status).toBe(before.status);
      expect(after.hasKeyConfigured).toBe(before.hasKeyConfigured);
    }
  });

  test('sin sesión de super_admin: 403', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const stamp = Date.now();
    const regular = await signup({
      tenantSlug,
      email: `e2e-no-admin-${stamp}@example.test`,
      password: 'E2eTestPassword123!',
      name: 'Sin Admin E2E',
    });
    const headers = {
      Authorization: `Bearer ${regular.tokens.accessToken}`,
      'Content-Type': 'application/json',
    };

    const getRes = await fetch(`${API_URL}/api/v1/admin/license`, { headers });
    expect(getRes.status).toBe(403);

    const putRes = await fetch(`${API_URL}/api/v1/admin/license`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ key: 'da-igual' }),
    });
    expect(putRes.status).toBe(403);
  });

  test('DELETE sobre licencia no configurada es no-op (no revienta)', async () => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const headers = { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' };

    const before = await fetch(`${API_URL}/api/v1/admin/license`, { headers }).then((r) =>
      r.json(),
    );

    const delRes = await fetch(`${API_URL}/api/v1/admin/license`, { method: 'DELETE', headers });
    if (before.managedByEnv) {
      expect(delRes.status).toBe(409);
    } else {
      expect(delRes.ok).toBe(true);
      const after = await delRes.json();
      expect(after.hasKeyConfigured).toBe(false);
    }
  });
});
