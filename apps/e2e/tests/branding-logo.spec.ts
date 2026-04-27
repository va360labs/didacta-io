import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Spec del uploader de logo (#154).
 *
 * Cubre:
 * - Sube un PNG válido al endpoint de theming/me/logo.
 * - El theme refleja `logoUploaded: true` y `logoUrl` apunta al endpoint público.
 * - El endpoint público sirve el blob con Content-Type correcto.
 * - DELETE limpia el logo y vuelve a `logoUrl: null`.
 *
 * Es API-driven en lugar de UI por dos motivos:
 *  - Subir un archivo en Playwright requiere `setInputFiles` con un asset real
 *    en disco; preferimos generar el PNG mínimo en memoria y mandarlo en base64.
 *  - El componente `LogoUploader` ya está cubierto por la build green; lo que
 *    nos importa es el contrato API + storage + endpoint público.
 */
test.describe('Branding · uploader de logo del tenant', () => {
  test('upload PNG → endpoint público sirve blob → DELETE limpia', async ({ page, request }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const headers = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    // Mínimo PNG válido 1x1 transparente — base64 estándar.
    const tinyPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    // 1. POST /modules/theming/me/logo
    const upload = await fetch(`${API_URL}/api/v1/modules/theming/me/logo`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        data: tinyPngBase64,
        filename: 'logo.png',
        contentType: 'image/png',
      }),
    });
    expect(upload.ok, `upload OK (got ${upload.status})`).toBe(true);
    const theme = (await upload.json()) as {
      logoUrl: string | null;
      logoUploaded: boolean;
      tenantId: string;
    };
    expect(theme.logoUploaded).toBe(true);
    expect(theme.logoUrl).toMatch(/^\/api\/v1\/modules\/theming\/tenants\/[\w-]+\/logo\?v=\d+$/);

    // 2. El endpoint público (sin auth) devuelve el PNG con Content-Type correcto.
    const publicGet = await request.get(`${API_URL}${theme.logoUrl!.split('?')[0]}`);
    expect(publicGet.ok()).toBe(true);
    expect(publicGet.headers()['content-type']).toContain('image/png');
    const buffer = await publicGet.body();
    expect(buffer.length).toBeGreaterThan(50);

    // 3. El admin abre /admin/branding y ve el preview del logo subido.
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: adminToken,
      user: {
        id: 'admin-stub',
        email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test',
        name: 'Admin',
        tenantId: theme.tenantId,
        tenantSlug,
        roles: ['super_admin', 'tenant_admin'],
        mfaEnabled: true,
      },
    });
    await page.goto('/admin/branding');
    await expect(page.getByRole('heading', { name: 'Branding' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/El logo está subido en el storage del tenant/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByAltText('Logo subido del tenant')).toBeVisible();

    // 4. DELETE del logo vía API (más rápido que UI).
    const remove = await fetch(`${API_URL}/api/v1/modules/theming/me/logo`, {
      method: 'DELETE',
      headers,
    });
    expect(remove.ok).toBe(true);
    const cleared = (await remove.json()) as { logoUrl: string | null; logoUploaded: boolean };
    expect(cleared.logoUploaded).toBe(false);
    expect(cleared.logoUrl).toBeNull();

    // 5. El endpoint público ahora 404.
    const publicGet404 = await request.get(`${API_URL}${theme.logoUrl!.split('?')[0]}`, {
      failOnStatusCode: false,
    });
    expect(publicGet404.status()).toBe(404);
  });
});
