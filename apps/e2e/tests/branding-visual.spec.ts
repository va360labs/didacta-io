import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Verificación VISUAL + funcional del branding (alpha.83). El operador reportó:
 *  - "no deja subir imagen"
 *  - al guardar dice "Introduce una url" y no se guarda
 *  - "los colores no se guardan"
 *
 * Causa raíz única: el form de /admin/branding es UN solo <form>. El input de
 * "URL del logo" era type="url"; al subir un logo se rellenaba con una ruta
 * RELATIVA (/api/v1/modules/theming/...), inválida para HTML5 type="url" → el
 * navegador bloqueaba el submit del form ENTERO → no se guardaba NADA (ni logo
 * ni colores). Fix: type="text" (el backend ya valida https://|/api/v1/...).
 *
 * Este spec reproduce el flujo completo: subir logo + cambiar color + GUARDAR +
 * verificar por API que AMBOS persistieron. Screenshots en branding-shots/.
 */

const SHOTS = 'branding-shots';
const RED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIklEQVR42mNk+M9Qz0BkYBxVSF' +
  'BQUFD4z0AEYBxVSFAAAB6mB/0nQXp9AAAAAElFTkSuQmCC';

test.describe('Branding · guardar logo + colores (regresión "no se guarda")', () => {
  test.setTimeout(90_000);

  test('subir logo + cambiar color + GUARDAR → ambos persisten', async ({ page, request }) => {
    mkdirSync(SHOTS, { recursive: true });
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'didacta-dev';
    const adminToken = await adminTokenForBootstrap(tenantSlug);
    const authHeaders = { Authorization: `Bearer ${adminToken}` };

    // Estado inicial del theme → para elegir un brandHue DISTINTO y probar que cambió.
    const before = (await (
      await fetch(`${API_URL}/api/v1/modules/theming/me`, { headers: authHeaders })
    ).json()) as { tenantId: string; brandHue: number };
    const targetHue = before.brandHue === 200 ? 120 : 200; // garantizado distinto

    await page.goto('/signin');
    await injectSession(page, {
      accessToken: adminToken,
      user: {
        id: 'admin-stub',
        email: process.env.E2E_ADMIN_EMAIL ?? 'admin@didacta.io',
        name: 'Admin',
        tenantId: before.tenantId,
        tenantSlug,
        roles: ['super_admin', 'tenant_admin'],
        mfaEnabled: true,
        // Sin esto el gate de onboarding secuestra la navegación a /admin/branding.
        onboardingCompletedAt: new Date().toISOString(),
      },
    });

    await page.goto('/admin/branding');
    await expect(page.getByRole('heading', { name: /Branding/i })).toBeVisible({ timeout: 15_000 });

    // 1. Subir logo por el FORMULARIO (rellena el input logoUrl con ruta relativa).
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: 'logo-test.png',
        mimeType: 'image/png',
        buffer: Buffer.from(RED_PNG_BASE64, 'base64'),
      });
    await expect(page.getByAltText(/Logo subido del tenant/i)).toBeVisible({ timeout: 20_000 });

    // 2. Cambiar el color (slider brandHue) a un valor conocido.
    const hue = page.locator('#brandHue');
    await hue.fill(String(targetHue));
    await hue.dispatchEvent('change');

    await page.screenshot({ path: `${SHOTS}/05-before-save.png`, fullPage: true });

    // 3. GUARDAR — aquí estaba el bloqueo original. Click en submit.
    // Sincronizamos contra la respuesta REAL del PUT, no contra un sleep fijo:
    // un margen arbitrario es la misma carrera que se encontró y arregló en
    // golden-path.spec.ts (ver memoria didacta-consistencia-eventual-me-enrollments)
    // frente a la verificación externa por API que sigue justo debajo.
    const [saveResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/modules/theming/me') && res.request().method() === 'PUT',
      ),
      page
        .getByRole('button', { name: /Guardar/i })
        .first()
        .click(),
    ]);
    expect(saveResponse.ok(), 'PUT /modules/theming/me debe responder 2xx').toBe(true);
    await page.screenshot({ path: `${SHOTS}/06-after-save.png`, fullPage: true });

    // 5. VERIFICACIÓN DURA por API: el theme persistió color + logo.
    const after = (await (
      await fetch(`${API_URL}/api/v1/modules/theming/me`, { headers: authHeaders })
    ).json()) as { brandHue: number; logoUploaded: boolean; logoUrl: string | null };

    expect(after.brandHue, `color persistió (esperado ${targetHue})`).toBe(targetHue);
    expect(after.logoUploaded, 'logo persistió').toBe(true);
    expect(after.logoUrl, 'logoUrl apunta al endpoint del tenant').toMatch(
      /\/api\/v1\/modules\/theming\/tenants\/[\w-]+\/logo/,
    );

    // 6. El endpoint público sirve el logo.
    const pub = await request.get(`${API_URL}${String(after.logoUrl).split('?')[0]}`);
    expect(pub.ok(), 'endpoint público sirve el logo').toBe(true);

    // cleanup: restaurar hue original + borrar logo de prueba.
    await fetch(`${API_URL}/api/v1/modules/theming/me`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ brandHue: before.brandHue }),
    });
    await fetch(`${API_URL}/api/v1/modules/theming/me/logo`, {
      method: 'DELETE',
      headers: authHeaders,
    });
  });
});
