import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signin } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * «Correo para respuestas» en Configuración → Notificaciones.
 *
 * Es el Reply-To de los correos que el aula manda a sus alumnos (el From lleva
 * el nombre de la academia y la dirección de la plataforma). Cubre:
 *  - Sin configurar, la tarjeta dice adónde van HOY las respuestas: al
 *    administrador principal del aula (el admin del arranque).
 *  - Una entrada con dos direcciones se rechaza sin guardar.
 *  - Guardar una dirección la convierte en el destino efectivo, y el contrato
 *    del endpoint lo confirma.
 *  - Cleanup: se quita (PUT null) y vuelve al administrador.
 */
test.describe('Admin — correo para respuestas', () => {
  test('sin configurar va al admin; guardar lo cambia; cleanup', async ({ page }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'demo';
    const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const apiHeaders = { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' };
    const putSender = (replyToEmail: string | null) =>
      fetch(`${API_URL}/api/v1/admin/tenant-settings/smtp/sender`, {
        method: 'PUT',
        headers: apiHeaders,
        body: JSON.stringify({ replyToEmail }),
      });

    await putSender(null); // residuo de otra pasada

    const session = await signin({
      tenantSlug,
      email: adminEmail,
      password: process.env.E2E_ADMIN_PASSWORD!,
    });
    const me = session.user;
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
        onboardingCompletedAt: new Date().toISOString(),
      },
    });

    await page.goto('/admin/settings?tab=notifications');
    const card = page.getByTestId('reply-to-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText('Correo para respuestas').first()).toBeVisible();
    await expect(card.getByTestId('reply-to-effective')).toHaveText(
      `Ahora mismo las respuestas llegan a ${adminEmail}.`,
    );

    const input = card.getByLabel('Correo para respuestas');
    await input.fill('a@academia.test, b@academia.test');
    await card.getByRole('button', { name: 'Guardar correo' }).click();
    await expect(card.getByRole('status')).toHaveText(/una sola dirección/);
    // Control: no se guardó nada.
    await expect(card.getByTestId('reply-to-effective')).toHaveText(
      `Ahora mismo las respuestas llegan a ${adminEmail}.`,
    );

    await input.fill('contacto@academia-e2e.test');
    await card.getByRole('button', { name: 'Guardar correo' }).click();
    await expect(card.getByRole('status')).toHaveText(/Guardado/);
    await expect(card.getByTestId('reply-to-effective')).toHaveText(
      'Ahora mismo las respuestas llegan a contacto@academia-e2e.test.',
    );

    const dto = (await (
      await fetch(`${API_URL}/api/v1/admin/tenant-settings/smtp/sender`, { headers: apiHeaders })
    ).json()) as { replyToEmail: string | null; effectiveReplyTo: string | null };
    expect(dto.replyToEmail).toBe('contacto@academia-e2e.test');
    expect(dto.effectiveReplyTo).toBe('contacto@academia-e2e.test');

    const cleared = (await (await putSender(null)).json()) as { effectiveReplyTo: string | null };
    expect(cleared.effectiveReplyTo).toBe(adminEmail);
  });
});
