import { expect, test } from '@playwright/test';
import { adminTokenForBootstrap, API_URL, signin } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Spec UI de la sección `/admin/emails` (alpha.83): personalización de los
 * emails de la plataforma sobre el catálogo completo (transaccionales + hub).
 *
 * Cubre:
 *  - El admin entra a /admin/emails → ve el catálogo agrupado con los emails
 *    transaccionales (reset de contraseña, membresía…) y los del hub.
 *  - El contrato del endpoint `GET /admin/notifications/templates/catalog`
 *    (keys transaccionales presentes, defaults y variables).
 *  - Personalizar «Restablecer contraseña»: el editor viene prefilleado con
 *    el default del producto, se guarda un override, aparece el badge
 *    "Personalizado" y persiste tras recargar.
 *  - Restaurar por defecto: el override se borra y el badge desaparece.
 *  - Cleanup por API en cualquier caso.
 */

const KEY = 'auth.password_reset';

test.describe('Admin · Emails de la plataforma — /admin/emails', () => {
  test('catálogo visible, personalizar y restaurar «Restablecer contraseña»', async ({ page }) => {
    const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'va360';
    const bearer = await adminTokenForBootstrap(tenantSlug);
    const apiHeaders = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };
    const deleteOverride = () =>
      fetch(`${API_URL}/api/v1/admin/notifications/templates/${KEY}?channel=EMAIL&locale=es-ES`, {
        method: 'DELETE',
        headers: apiHeaders,
      }).catch(() => {});

    // Limpieza preventiva de runs anteriores.
    await deleteOverride();

    // Contrato del catálogo: keys transaccionales presentes con default y variables.
    const catRes = await fetch(`${API_URL}/api/v1/admin/notifications/templates/catalog`, {
      headers: apiHeaders,
    });
    expect(catRes.ok, 'GET /templates/catalog devuelve 200').toBe(true);
    const catalog = (await catRes.json()) as Array<{
      key: string;
      name: string;
      source: string;
      defaultSubject: string | null;
      defaultBody: string;
      variables: Array<{ name: string }>;
    }>;
    const resetEntry = catalog.find((e) => e.key === KEY);
    expect(resetEntry, `el catálogo incluye ${KEY}`).toBeTruthy();
    expect(resetEntry!.source).toBe('transactional');
    expect(resetEntry!.defaultSubject).toContain('{{tenantName}}');
    expect(resetEntry!.variables.map((v) => v.name)).toContain('resetUrl');
    for (const key of ['membership.welcome', 'inscripcion.otp_code', 'community.broadcast']) {
      expect(
        catalog.some((e) => e.key === key),
        `el catálogo incluye ${key}`,
      ).toBe(true);
    }

    // Sesión de admin inyectada en el browser (el user viene del signin).
    const session = await signin({
      tenantSlug,
      email: process.env.E2E_ADMIN_EMAIL!,
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
        // Salta el gate de onboarding (el seed deja onboardingCompletedAt=null).
        onboardingCompletedAt: new Date().toISOString(),
      },
    });

    try {
      // La sección carga con el catálogo agrupado.
      await page.goto('/admin/emails');
      await expect(page.getByRole('heading', { name: 'Emails de la plataforma' })).toBeVisible({
        timeout: 15_000,
      });
      const row = page.getByTestId(`email-template-${KEY}`);
      await expect(row).toBeVisible({ timeout: 10_000 });
      await expect(row.getByText('Restablecer contraseña')).toBeVisible();
      // También hay emails del hub y de membresía en el listado.
      await expect(page.getByTestId('email-template-membership.welcome')).toBeVisible();
      await expect(page.getByTestId('email-template-lesson.unlocked')).toBeVisible();

      // Personalizar: el editor viene prefilleado con el default del producto.
      await row.getByRole('button', { name: 'Personalizar' }).click();
      const editor = page.getByTestId('email-template-editor');
      await expect(editor).toBeVisible();
      await expect(editor.getByLabel('Asunto')).toHaveValue(
        'Restablecer tu contraseña en {{tenantName}}',
      );
      await expect(editor.getByLabel('Cuerpo')).toHaveValue(/Recibimos una solicitud/);

      // Editamos asunto y cuerpo y guardamos.
      await editor.getByLabel('Asunto').fill('[E2E] Recupera tu acceso a {{tenantName}}');
      await editor
        .getByLabel('Cuerpo')
        .fill(
          '{{greeting}}\n\nPide una contraseña nueva con el botón (caduca en {{ttlMinutes}} minutos).',
        );
      await editor.getByRole('button', { name: 'Guardar' }).click();

      // Badge "Personalizado" visible y override persistido en el backend.
      await expect(row.getByText('Personalizado')).toBeVisible({ timeout: 10_000 });
      const listRes = await fetch(`${API_URL}/api/v1/admin/notifications/templates?key=${KEY}`, {
        headers: apiHeaders,
      });
      const rows = (await listRes.json()) as Array<{ subject: string | null; body: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.subject).toBe('[E2E] Recupera tu acceso a {{tenantName}}');

      // Persiste tras recargar la página.
      await page.reload();
      await expect(
        page.getByTestId(`email-template-${KEY}`).getByText('Personalizado'),
      ).toBeVisible({ timeout: 15_000 });

      // Restaurar por defecto desde el listado (confirm nativo → aceptar).
      page.once('dialog', (dialog) => void dialog.accept());
      await page
        .getByTestId(`email-template-${KEY}`)
        .getByRole('button', { name: 'Restaurar' })
        .click();
      await expect(page.getByTestId(`email-template-${KEY}`).getByText('Personalizado')).toBeHidden(
        { timeout: 10_000 },
      );
      const afterRes = await fetch(`${API_URL}/api/v1/admin/notifications/templates?key=${KEY}`, {
        headers: apiHeaders,
      });
      expect(((await afterRes.json()) as unknown[]).length).toBe(0);
    } finally {
      // Cleanup incondicional.
      await deleteOverride();
    }
  });
});
