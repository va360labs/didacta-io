import { expect, test } from '@playwright/test';
import { authenticator } from 'otplib';
import { signin } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Flujo MFA del admin: setup + enable end-to-end vía UI.
 *
 * El seed admin ya puede o no tener MFA activado de runs anteriores; este
 * spec ejecuta /auth/mfa/setup que genera un secret NUEVO cada vez,
 * sobreescribiendo el anterior. Es idempotente: se puede correr N veces
 * y siempre rota al admin a un secret fresco.
 *
 * El flujo:
 * 1. Signin del admin via API → obtiene token (mfaRequired=true).
 * 2. Inyecta sesión en el browser.
 * 3. Navega a /mfa/setup → la página llama POST /mfa/setup → muestra QR + URL otpauth.
 * 4. Extrae el secret del otpauthUrl visible en el page (dentro de <details>).
 * 5. Genera código TOTP con otplib + el secret extraído.
 * 6. Rellena el input + click "Confirmar y activar MFA".
 * 7. POST /mfa/enable → success → redirect a /.
 */
test.describe('Auth · MFA admin', () => {
  test('admin completa setup MFA → enable con código TOTP → sesión queda mfaVerified', async ({
    page,
  }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const adminEmail = process.env.E2E_ADMIN_EMAIL;
    const adminPassword = process.env.E2E_ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword) {
      throw new Error('E2E_ADMIN_EMAIL y E2E_ADMIN_PASSWORD requeridos para el spec de MFA');
    }

    // 1) Signin admin → mfaRequired=true
    const session = await signin({ tenantSlug, email: adminEmail, password: adminPassword });
    expect(session.mfaRequired, 'admin debe requerir MFA').toBe(true);

    // 2) Inyectar sesión (todavía sin mfaVerified)
    await page.goto('/signin');
    await injectSession(page, {
      accessToken: session.tokens.accessToken,
      user: session.user,
    });

    // 3) Navegar al setup
    await page.goto('/mfa/setup');
    await expect(page.getByText(/Tu rol exige autenticación en dos pasos/)).toBeVisible({
      timeout: 15_000,
    });

    // 4) Extraer secret del otpauthUrl visible (dentro del <details>)
    // El elemento <code> está en el DOM aunque <details> esté colapsado.
    const otpauthUrlText = await page.locator('code').first().textContent({ timeout: 15_000 });
    expect(otpauthUrlText, 'otpauthUrl debe estar visible').toBeTruthy();
    const secretMatch = otpauthUrlText!.match(/[?&]secret=([A-Z2-7]+)/);
    expect(secretMatch, 'secret debe poder extraerse del otpauthUrl').toBeTruthy();
    const secret = secretMatch![1]!;

    // 5) Generar código TOTP
    const code = authenticator.generate(secret);
    expect(code).toMatch(/^\d{6}$/);

    // 6) Rellenar y enviar
    await page.getByLabel(/Código de la app/).fill(code);
    await page.getByRole('button', { name: /Confirmar y activar MFA/ }).click();

    // 7) Esperar redirect a / (la app monta el dashboard del alumno o landing)
    await page.waitForURL(/\/$/, { timeout: 20_000 });
  });
});
