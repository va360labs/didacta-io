/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { injectSession } from '../helpers/auth';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';

/**
 * Valentín: «Al entrar en una academia aparece del tirón el login. Debería
 * aparecer la página de venta, como en Skool o Circle, con las diferentes
 * opciones de acceder.»
 *
 * Página pública de la academia en la raíz del aula (`/`), para quien entra
 * SIN sesión. Cada caso en su propia aula nueva (la API cachea por aula):
 *
 *  1. Visitante: ve la portada (nombre, descripción, miembros, quién la lleva,
 *     próximo directo) y las opciones con datos reales: el curso a la venta con
 *     su precio y enlace a su ficha, la membresía con su precio y «Entrar»;
 *     los metadatos para compartir llevan el nombre y la portada.
 *  2. Con `?ref=` todos los botones lo conservan.
 *  3. Con sesión, va a su inicio de siempre (la comunidad).
 *  4. Ajuste apagado → acceso; aula del modo completo sin ajuste → acceso.
 *  5. Aula sin nada a la venta: mensaje claro y solo «Entrar».
 *  6. Móvil 390: sin desbordes y con el botón de acceso a la vista.
 */

const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface Aula extends FreshTenant {
  tenantId: string;
  operator: string;
}

async function aula(prefix: string, simple: boolean): Promise<Aula> {
  const slug = `${prefix}-${Date.now().toString(36)}`;
  const ft = await freshTenant(slug, simple);
  const op = await apiAs<{ tokens: { accessToken: string } }>(ft.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: slug, email: `operador@${slug}.test`, password: ft.password },
  });
  const tenantId = sql(`SELECT id FROM tenant WHERE slug='${slug}'`);
  return { ...ft, tenantId, operator: op.tokens.accessToken };
}

/** Curso publicado con una opción de compra (lo que el creador deja a la venta). */
function cursoALaVenta(tenantId: string, slug: string, title: string, cents: number): void {
  const id = randomUUID();
  sql(
    `INSERT INTO mod_courses_course (id, tenant_id, slug, title, description, status, published_at, created_at, updated_at)
     VALUES ('${id}', '${tenantId}', '${slug}', '${title}', '<p>Aprende <b>desde cero</b></p>', 'PUBLISHED', now(), now(), now())`,
  );
  const p = randomUUID();
  sql(
    `INSERT INTO mod_billing_product (id, tenant_id, course_id, stripe_product_id, stripe_price_id, unit_amount, currency, updated_at)
     VALUES ('${p}', '${tenantId}', '${id}', 'prod_e2e_${p.slice(0, 8)}', 'price_e2e_${p.slice(0, 8)}', ${cents}, 'eur', now())`,
  );
}

/** Alumna con el perfil hecho (sin puerta de primer acceso). */
async function alumna(a: Aula, name: string) {
  const email = `alumna-${randomUUID().slice(0, 8)}@example.com`;
  const auth = await apiAs<{
    tokens: { accessToken: string; refreshToken: string };
    user: { id: string; email: string; tenantId: string; tenantSlug: string; roles: string[] };
  }>(a.host, '/api/v1/auth/signup', {
    method: 'POST',
    body: { tenantSlug: a.slug, email, password: 'E2eTestPassword123!', name },
  });
  await apiAs(a.host, '/api/v1/me/profile', {
    method: 'PATCH',
    bearer: auth.tokens.accessToken,
    body: { name, avatarUrl: 'https://cdn.example.com/a.png' },
  });
  await apiAs(a.host, '/api/v1/me/onboarding/complete', {
    method: 'POST',
    bearer: auth.tokens.accessToken,
    body: {},
  });
  return auth;
}

/** Enlaces internos de la portada (botones y tarjetas). */
async function enlacesInternos(page: Page): Promise<string[]> {
  return page
    .getByTestId('portada-aula')
    .locator('a[href^="/"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
}

test.describe('Página pública de la academia', () => {
  test.setTimeout(120_000);

  test('visitante: portada con sus opciones reales; ?ref= en todos los botones; móvil 390', async ({
    page,
  }) => {
    const a = await aula('portada', true);
    sql(`UPDATE "user" SET name='Clara Barista', avatar_url=NULL WHERE email='${a.creatorEmail}'`);
    cursoALaVenta(a.tenantId, 'latte-art', 'Latte art', 4900);
    await apiAs(a.host, '/api/v1/modules/theming/me', {
      method: 'PUT',
      bearer: a.operator,
      body: { about: 'Café de especialidad en casa.' },
    });
    await apiAs(a.host, '/api/v1/modules/theming/me/cover', {
      method: 'POST',
      bearer: a.operator,
      body: { data: PNG_1x1, filename: 'portada.png', contentType: 'image/png' },
    });
    await apiAs(a.host, '/api/v1/membership/admin/config', {
      method: 'PUT',
      bearer: a.operator,
      body: { active: true },
    });
    await apiAs(a.host, '/api/v1/membership/admin/plans', {
      method: 'POST',
      bearer: a.operator,
      body: { name: 'Mensual', intervalMonths: 1, amountCents: 1900, trialDays: 7 },
    });
    await alumna(a, 'Lucía Prueba');
    const inicio = new Date(Date.now() + 3 * 86_400_000);
    sql(
      `INSERT INTO mod_zoom_live_session (id, tenant_id, topic, start_time, duration_minutes, timezone, host_email, join_url, updated_at)
       VALUES (gen_random_uuid(), '${a.tenantId}', 'Directo de prueba', '${inicio.toISOString()}', 60, 'Europe/Madrid', 'h@example.com', 'https://zoom.example.com/j/secreto', now())`,
    );

    await page.goto(`${a.base}/`);
    const portada = page.getByTestId('portada-aula');
    await expect(portada).toBeVisible();
    await expect(page).toHaveURL(`${a.base}/`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(a.slug);
    await expect(page.getByTestId('portada-descripcion')).toHaveText(
      'Café de especialidad en casa.',
    );
    // operador + creadora + alumna: 3 miembros (solo el número).
    await expect(page.getByTestId('portada-miembros')).toContainText('3');
    await expect(page.getByTestId('portada-creadora')).toContainText('Clara Barista');
    await expect(page.getByTestId('portada-creadora')).toContainText('CB');
    await expect(portada).not.toContainText('Lucía Prueba');
    await expect(page.getByTestId('portada-directo')).toContainText('Directo de prueba');
    await expect(portada.locator('a[href*="zoom.example.com"]')).toHaveCount(0);

    const curso = page.getByTestId('portada-curso');
    await expect(curso).toHaveCount(1);
    await expect(curso).toContainText('Latte art');
    await expect(curso).toContainText('49');
    await expect(curso).toHaveAttribute('href', '/catalog/latte-art');
    await expect(page.getByTestId('portada-membresia')).toContainText('19');
    await expect(page.getByTestId('portada-membresia-cta')).toHaveAttribute('href', '/join');
    await expect(page.getByTestId('portada-cta')).toHaveAttribute('href', '/join');
    await expect(page.getByTestId('portada-entrar')).toHaveAttribute('href', '/signin');

    // Metadatos para compartir: el nombre del aula y su portada, con URL absoluta.
    await expect(page).toHaveTitle(a.slug);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', a.slug);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      new RegExp(`^http://${a.host}:\\d+/api/v1/modules/theming/tenants/${a.tenantId}/cover`),
    );
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
      'content',
      'summary_large_image',
    );

    // Con ?ref= todos los botones lo conservan.
    await page.goto(`${a.base}/?ref=amigo123`);
    await expect(page.getByTestId('portada-cta')).toHaveAttribute('href', '/join?ref=amigo123');
    const enlaces = (await enlacesInternos(page)).filter((h) => h !== '/');
    expect(enlaces.length).toBeGreaterThanOrEqual(4);
    for (const href of enlaces) expect(href, href).toContain('ref=amigo123');

    // Móvil 390: sin desbordes y con el botón principal a la vista.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${a.base}/`);
    await expect(page.getByTestId('portada-cta')).toBeInViewport();
    await expect(page.getByTestId('portada-entrar')).toBeInViewport();
    const desborde = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(desborde).toBeLessThanOrEqual(0);
  });

  test('con sesión va a su inicio de siempre; con el ajuste apagado, al acceso', async ({
    page,
  }) => {
    const a = await aula('portada-sesion', true);
    const auth = await alumna(a, 'Ana Miembro');

    await page.goto(`${a.base}/signin`);
    await injectSession(page, {
      accessToken: auth.tokens.accessToken,
      refreshToken: auth.tokens.refreshToken,
      user: {
        ...auth.user,
        name: 'Ana Miembro',
        mfaEnabled: false,
        onboardingCompletedAt: new Date().toISOString(),
      },
    });
    await page.goto(`${a.base}/`);
    await expect(page).toHaveURL(/\/community/);
    await expect(page.getByTestId('portada-aula')).toHaveCount(0);

    // Sin sesión, la portada; apagada en Ajustes, directo al acceso.
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.clear();
    });
    await page.goto(`${a.base}/`);
    await expect(page.getByTestId('portada-aula')).toBeVisible();
    const academia = await apiAs<{ publicHome: boolean; publicHomeSource: string }>(
      a.host,
      '/api/v1/admin/tenant-settings/academy',
      { method: 'PUT', bearer: a.operator, body: { publicHome: false } },
    );
    expect(academia).toMatchObject({ publicHome: false, publicHomeSource: 'setting' });
    await page.goto(`${a.base}/`);
    await expect(page).toHaveURL(/\/signin/);
  });

  test('aula sin nada a la venta: mensaje claro y solo «Entrar»; modo completo: al acceso', async ({
    page,
  }) => {
    const vacia = await aula('portada-vacia', true);
    await page.goto(`${vacia.base}/`);
    await expect(page.getByTestId('portada-sin-venta')).toBeVisible();
    await expect(page.getByTestId('portada-cta')).toHaveCount(0);
    await expect(page.getByTestId('portada-curso')).toHaveCount(0);
    await expect(page.getByTestId('portada-acceso-entrar')).toHaveAttribute('href', '/signin');
    await expect(page.getByTestId('portada-entrar')).toBeVisible();
    // Sin alumnos no presume de miembros.
    await expect(page.getByTestId('portada-miembros')).toHaveCount(0);

    // Un aula del modo completo sin tocar el ajuste: la entrada de siempre.
    const completa = await aula('portada-completa', false);
    await page.goto(`${completa.base}/`);
    await expect(page).toHaveURL(/\/signin/);
  });
});
