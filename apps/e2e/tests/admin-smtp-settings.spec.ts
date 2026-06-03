import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Spec UI del card SMTP en `/admin/configuracion` (tab Notificaciones) +
 * contrato del endpoint admin-smtp dedicado (#79 / alpha.75 backend, alpha.76
 * UI).
 *
 * Cubre:
 *  - El admin entra a /admin/configuracion → la tab "Notificaciones" carga
 *    el card con el banner de estado.
 *  - Guardar credenciales falsas (smtp.example.test) → banner pasa a
 *    "configurado pero sin verificar" (verifiedAt sigue null porque el
 *    submit del form NO dispara test).
 *  - Click "Enviar email de prueba" → modal con el email del admin
 *    prellenado → click "Enviar" → backend responde 400 (smtp.example.test no
 *    es un MTA real, la conexión falla) → el toast del card muestra el
 *    mensaje de error del MTA, no un mensaje genérico.
 *  - Cleanup: borra las dos rows `notifications.smtp` + `notifications.smtp_meta`.
 *
 * Skip si no hay env globales para el cliente: el spec necesita
 * `E2E_ADMIN_EMAIL` y `E2E_ADMIN_PASSWORD` igual que el resto.
 */

test.describe('Admin SMTP settings — UI + contrato admin-smtp', () => {
  test('guarda config falsa, intenta probar → error del MTA visible, cleanup', async ({ page }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const apiHeaders = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };

    // Limpieza preventiva: borramos cualquier residuo de runs anteriores.
    await fetch(`${API_URL}/api/v1/tenant-settings/notifications/smtp`, {
      method: 'DELETE',
      headers: apiHeaders,
    }).catch(() => {});
    await fetch(`${API_URL}/api/v1/tenant-settings/notifications/smtp_meta`, {
      method: 'DELETE',
      headers: apiHeaders,
    }).catch(() => {});

    // Obtenemos `tenantId` real desde la sesión del admin (lo necesita
    // `injectSession`). Vía /auth/signin o /me; reutilizamos `signin` por
    // ahorrar redondeos.
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

    // Sesión inyectada en el browser para saltar el login UI.
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

    // Navegamos a /admin/configuracion (tab Notificaciones es el default).
    await page.goto('/admin/configuracion');
    await expect(page.getByRole('heading', { name: 'Configuración del tenant' })).toBeVisible({
      timeout: 15_000,
    });

    // Card SMTP visible. Esperamos el banner — primera carga puede ser
    // "fallback" si el host tiene env globales, o "none" si no.
    await expect(page.getByText('Notificaciones · SMTP')).toBeVisible();
    const banner = page
      .getByTestId('smtp-banner-fallback')
      .or(page.getByTestId('smtp-banner-none'))
      .or(page.getByTestId('smtp-banner-verified'))
      .or(page.getByTestId('smtp-banner-unverified'));
    await expect(banner.first()).toBeVisible({ timeout: 10_000 });

    // Llenamos el form con datos falsos.
    await page.getByLabel('Host').fill('smtp.example.test');
    await page.getByLabel('Puerto').fill('587');
    await page.getByLabel('Usuario').fill('e2e-smtp-test');
    await page.getByLabel('Contraseña', { exact: false }).fill('not-a-real-password');
    await page.getByLabel('From email').fill('noreply@example.test');
    await page.getByLabel('From name (opcional)').fill('Didacta E2E');

    // Guardar — el backend acepta cualquier set válido sin probar conexión.
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByTestId('smtp-banner-unverified')).toBeVisible({ timeout: 10_000 });

    // Botón "Enviar email de prueba" ahora debe estar habilitado
    // (hasTenantConfig=true tras el guardado).
    const testButton = page.getByRole('button', { name: 'Enviar email de prueba' });
    await expect(testButton).toBeEnabled();
    await testButton.click();

    // Modal: el email del admin viene prellenado.
    const modalEmailInput = page.getByLabel('Destinatario');
    await expect(modalEmailInput).toBeVisible({ timeout: 5_000 });
    await expect(modalEmailInput).toHaveValue(adminEmail);

    // Click Enviar en el modal — el backend va a fallar porque
    // smtp.example.test no resuelve / no acepta TLS / etc. → 400 con
    // mensaje del MTA. El componente lo muestra textual en el toast.
    await page.getByRole('button', { name: 'Enviar' }).click();
    const toast = page.getByTestId('smtp-toast');
    await expect(toast).toBeVisible({ timeout: 30_000 });
    const toastText = (await toast.textContent()) ?? '';
    // El mensaje incluye "SMTP falló:" (formato del controlador admin-smtp).
    // Si el MTA respondió con un error diferente igualmente esperamos que
    // NO sea el genérico "No pudimos enviar…" — eso sería un fallback que
    // significa que el backend no devolvió mensaje útil.
    expect(toastText.toLowerCase()).toMatch(
      /smtp|host|connection|enotfound|getaddrinfo|timeout|certificate|tls/i,
    );

    // Cleanup: borrar las dos rows. Lo hacemos por API para evitar tener
    // que clickear el botón "Eliminar configuración" y confirmar el modal.
    await fetch(`${API_URL}/api/v1/tenant-settings/notifications/smtp`, {
      method: 'DELETE',
      headers: apiHeaders,
    }).catch(() => {});
    await fetch(`${API_URL}/api/v1/tenant-settings/notifications/smtp_meta`, {
      method: 'DELETE',
      headers: apiHeaders,
    }).catch(() => {});
  });
});
