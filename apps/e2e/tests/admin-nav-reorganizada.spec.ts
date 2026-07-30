import { expect, test } from '@playwright/test';
import { API_URL } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Reordenación del panel de administración.
 *
 * Cubre las cuatro fases de la entrega:
 *   0. "Puntos y retos" (mod.gamification) es alcanzable desde el sidebar — el
 *      item apuntaba a un grupo que solo existía para super_admin y el merge lo
 *      descartaba en silencio.
 *   1. Los grupos nuevos existen, "General" (14 items) desapareció y "Volver a
 *      la app" ya no es un item de lista sino chrome de la cabecera.
 *   2. Las cuatro pantallas fusionadas responden como pestaña, y sus rutas
 *      viejas siguen vivas como redirect.
 *   3. Los badges de trabajo pendiente aparecen cuando hay algo que atender.
 *
 * Sesión REAL de admin (mismo patrón que metricas-negocio.spec.ts).
 */

interface AdminAuth {
  tokens: { accessToken: string; refreshToken: string };
  user: Record<string, unknown>;
}

/**
 * Un ÚNICO signin reutilizado por todos los tests del fichero. Autenticar en
 * cada `beforeEach` agota el rate limit del endpoint de auth y el cuarto test
 * se cae con un 429 que no tiene nada que ver con lo que se está probando.
 */
let cachedAuth: Promise<AdminAuth> | null = null;

function adminAuth(): Promise<AdminAuth> {
  cachedAuth ??= (async () => {
    const res = await fetch(`${API_URL}/api/v1/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantSlug: process.env.E2E_TENANT_SLUG ?? 'va360',
        email: process.env.E2E_ADMIN_EMAIL,
        password: process.env.E2E_ADMIN_PASSWORD,
      }),
    });
    expect(res.ok, `signin admin (${res.status})`).toBe(true);
    return (await res.json()) as AdminAuth;
  })();
  return cachedAuth;
}

async function signInAsAdmin(page: import('@playwright/test').Page): Promise<void> {
  const auth = await adminAuth();
  await page.goto('/signin');
  await injectSession(page, {
    accessToken: auth.tokens.accessToken,
    refreshToken: auth.tokens.refreshToken,
    user: { ...(auth.user as never), onboardingCompletedAt: new Date().toISOString() },
  });
}

test.describe('Panel de administración reordenado', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Panel del tenant' })).toBeVisible();
  });

  test('fase 0 — "Puntos y retos" es alcanzable desde el sidebar', async ({ page }) => {
    const nav = page.locator('aside nav').first();
    const item = nav.getByRole('link', { name: 'Puntos y retos' });
    await expect(item).toBeVisible();
    await item.click();
    await expect(page.getByRole('heading', { name: 'Puntos y retos' })).toBeVisible();
  });

  test('fase 1 — grupos nuevos, sin cajón "General" y con salida en la cabecera', async ({
    page,
  }) => {
    const sidebar = page.locator('aside').first();
    // Los labels de grupo se comprueban dentro de <nav>: la cabecera del
    // sidebar pinta también la palabra "Comunidad" como subtítulo del tenant y
    // un getByText sobre el <aside> entero casaría dos elementos.
    const nav = sidebar.locator('nav').first();

    // Los grupos por trabajo, no por tecnología.
    for (const group of [
      'Resumen',
      'Personas y accesos',
      'Comunidad',
      'Contenido',
      'Ingresos',
      'Comunicación',
      'Marca y ajustes',
      'Integraciones y API',
      'Seguridad',
    ]) {
      await expect(nav.getByText(group, { exact: true })).toBeVisible();
    }

    // El cajón de sastre ya no existe.
    await expect(nav.getByText('General', { exact: true })).toHaveCount(0);
    await expect(nav.getByText('Facturación', { exact: true })).toHaveCount(0);

    // Los items viven donde toca ahora.
    await expect(nav.getByRole('link', { name: 'Membresía' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Emails' })).toBeVisible();

    // "Volver a la app" es chrome, no un item de la lista de secciones.
    const back = sidebar.getByRole('link', { name: 'Volver a la app' });
    await expect(back).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Volver a la app' })).toHaveCount(0);
    await back.click();
    await expect(page).toHaveURL(/\/comunidad$/);
  });

  test('fase 2 — las cuatro fusiones responden y las rutas viejas redirigen', async ({ page }) => {
    // Métricas → pestaña del panel.
    await page.goto('/admin/metricas');
    await expect(page).toHaveURL(/\/admin\?tab=negocio/);
    await expect(page.getByRole('tab', { name: 'Negocio' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // SSO: un destino, tres pestañas.
    await page.goto('/admin/sso');
    await expect(page.getByRole('heading', { name: 'Identidad (SSO)' })).toBeVisible();
    for (const tab of ['OpenID Connect', 'SAML 2.0', 'WordPress']) {
      await expect(page.getByRole('tab', { name: tab })).toBeVisible();
    }
    await page.goto('/admin/sso-saml');
    await expect(page).toHaveURL(/\/admin\/sso\?tab=saml/);
    await expect(page.getByRole('tab', { name: 'SAML 2.0' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.goto('/admin/sso-wordpress');
    await expect(page).toHaveURL(/\/admin\/sso\?tab=wordpress/);

    // Documentación de API → pestaña de Claves API.
    await page.goto('/admin/integraciones/api');
    await expect(page).toHaveURL(/\/admin\/api-keys\?tab=docs/);
    await expect(page.getByRole('heading', { name: 'Claves API' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Integración API' })).toBeVisible();

    // Entregas de Zoom → pestaña de Webhooks.
    await page.goto('/admin/zoom/webhook-events');
    await expect(page).toHaveURL(/\/admin\/webhooks\?tab=zoom/);
    await expect(page.getByRole('heading', { name: 'Eventos webhook · Zoom' })).toBeVisible();
  });

  test('fase 3 — el badge de solicitudes refleja las pendientes reales', async ({ page }) => {
    // El badge sale del MISMO endpoint que alimenta la pantalla, así que la
    // comprobación es: lo que diga la API es lo que pinta el sidebar.
    const token = await page.evaluate(
      () =>
        localStorage.getItem('didacta.access_token') ??
        sessionStorage.getItem('didacta.access_token'),
    );
    expect(token, 'sesión inyectada').toBeTruthy();

    const res = await fetch(`${API_URL}/api/v1/inscripcion-admin/requests`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok, `requests (${res.status})`).toBe(true);
    const { requests } = (await res.json()) as { requests: unknown[] };

    const item = page
      .locator('aside nav')
      .first()
      .getByRole('link', { name: /Solicitudes de inscripción/ });
    await expect(item).toBeVisible();

    if (requests.length > 0) {
      await expect(item).toContainText(String(requests.length));
    } else {
      // Sin pendientes NO se pinta badge: un "0" diría que hay una cifra que mirar.
      await expect(item).toHaveText('Solicitudes de inscripción');
    }
  });
});
