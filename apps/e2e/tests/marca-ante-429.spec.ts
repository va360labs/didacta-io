/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';

/**
 * La marca del aula en las páginas públicas cuando la API contesta 429.
 *
 * Probando en ráfaga en producción (14-nov-2026), al pasar de ~30 peticiones
 * por minuto desde una IP el acceso del aula salió con «Tu academia» y las
 * iniciales neutras. El cupo público es por visitante (su IP), así que el 429
 * le toca a quien lo agota; lo que estaba mal es cómo se caía: el primer fallo
 * de `GET /auth/tenant-context` se guardaba como «sin aula» para el resto de la
 * pestaña, sin reintentar.
 *
 * El 429 se simula en el navegador (`page.route`) porque el arnés corre con el
 * límite alto (`global-setup.ts`): lo que se prueba es la reacción de la web.
 *
 *  1. Con la marca ya vista en la pestaña, un 429 al recargar no la quita: ni
 *     en el acceso, ni en el 404, ni en la portada ni en la ficha de venta.
 *  2. Visitante nuevo cuyo primer intento es un 429: la marca llega sola con
 *     el reintento (cuando dice `Retry-After`), con UNA llamada más, no un
 *     bombardeo.
 */

const NOMBRE = 'Taller de Cerámica Lúa';
const INICIALES = 'TL';
const NEUTRO = 'Tu academia';
const TENANT_CONTEXT = '**/api/v1/auth/tenant-context';

interface Aula extends FreshTenant {
  tenantId: string;
}

async function aulaNueva(prefix: string): Promise<Aula> {
  const ft = await freshTenant(`${prefix}${Date.now().toString(36)}`, true);
  const operador = await apiAs<{ tokens: { accessToken: string } }>(
    ft.host,
    '/api/v1/auth/signin',
    {
      method: 'POST',
      body: { tenantSlug: ft.slug, email: `operador@${ft.slug}.test`, password: ft.password },
    },
  );
  const T = operador.tokens.accessToken;
  await apiAs(ft.host, '/api/v1/admin/tenant-settings/academy', {
    method: 'PUT',
    bearer: T,
    body: { name: NOMBRE },
  });
  await apiAs(ft.host, '/api/v1/modules/theming/me', {
    method: 'PUT',
    bearer: T,
    body: { brandHue: 200, brandSaturation: 80 },
  });
  const tenantId = sql(`SELECT id FROM tenant WHERE slug='${ft.slug}'`);
  const curso = randomUUID();
  sql(
    `INSERT INTO mod_courses_course (id, tenant_id, slug, title, description, status, published_at, created_at, updated_at)
     VALUES ('${curso}', '${tenantId}', 'torno', 'Torno desde cero', '<p>Barro</p>', 'PUBLISHED', now(), now(), now())`,
  );
  const p = randomUUID();
  sql(
    `INSERT INTO mod_billing_product (id, tenant_id, course_id, stripe_product_id, stripe_price_id, unit_amount, currency, updated_at)
     VALUES ('${p}', '${tenantId}', '${curso}', 'prod_e2e_${p.slice(0, 8)}', 'price_e2e_${p.slice(0, 8)}', 3900, 'eur', now())`,
  );
  return { ...ft, tenantId };
}

async function visitante(browser: Browser, a: Aula): Promise<Page> {
  const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: a.base }]);
  return ctx.newPage();
}

/** Las iniciales y el nombre del aula, nunca la marca neutra. */
async function conSuMarca(scope: Locator): Promise<void> {
  const mark = scope.getByTestId('academy-mark').first();
  await expect(mark).toBeVisible({ timeout: 20_000 });
  await expect(mark).toHaveAttribute('data-initials', INICIALES);
  await expect(scope).not.toContainText(NEUTRO);
}

/** La API del aula contesta 429 a la marca, como con el cupo agotado. */
async function marcaLimitada(page: Page, retryAfter: string): Promise<{ llamadas: () => number }> {
  let n = 0;
  await page.route(TENANT_CONTEXT, (route) => {
    n += 1;
    return route.fulfill({
      status: 429,
      contentType: 'application/json',
      headers: { 'Retry-After': retryAfter },
      body: JSON.stringify({ statusCode: 429, code: 'rate_limit_exceeded', message: 'límite' }),
    });
  });
  return { llamadas: () => n };
}

test.describe('Marca del aula ante un 429 de la API', () => {
  test.setTimeout(180_000);

  test('con la marca ya vista, un 429 al recargar no la quita en ninguna página pública', async ({
    browser,
  }) => {
    const a = await aulaNueva('m429a');
    const page = await visitante(browser, a);

    // Control: sin límite, el acceso con su marca.
    await page.goto(`${a.base}/signin`);
    await conSuMarca(page.locator('aside'));
    await expect(page.locator('aside')).toContainText(NOMBRE);

    // A partir de aquí, la API contesta 429 a la marca (cupo agotado ~1 min).
    const limitada = await marcaLimitada(page, '45');

    await page.reload();
    await conSuMarca(page.locator('aside'));
    await expect(page.locator('aside')).toContainText(NOMBRE);

    const r404 = await page.goto(`${a.base}/esto-no-existe-${Date.now()}`);
    expect(r404?.status()).toBe(404);
    await conSuMarca(page.getByTestId('not-found-brand'));
    await expect(page.getByTestId('not-found-brand')).toContainText(NOMBRE);

    await page.goto(`${a.base}/`);
    await conSuMarca(page.getByTestId('portada-marca'));

    await page.goto(`${a.base}/catalog/torno`);
    await expect(page.getByRole('heading', { name: 'Torno desde cero' })).toBeVisible();
    await conSuMarca(page.locator('aside'));

    // De verdad pasó por el 429 (si no, la prueba no prueba nada).
    expect(limitada.llamadas()).toBeGreaterThan(0);
    await page.context().close();
  });

  test('visitante nuevo con el primer intento en 429: la marca llega con el reintento', async ({
    browser,
  }) => {
    const a = await aulaNueva('m429b');
    const page = await visitante(browser, a);

    // Solo el PRIMER intento es un 429 (Retry-After: 2 s); luego, la API real.
    let llamadas = 0;
    await page.route(TENANT_CONTEXT, async (route) => {
      llamadas += 1;
      if (llamadas === 1) {
        await route.fulfill({
          status: 429,
          contentType: 'application/json',
          headers: { 'Retry-After': '2' },
          body: JSON.stringify({ statusCode: 429, code: 'rate_limit_exceeded' }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`${a.base}/signin`);
    // Sin nada guardado aún, el primer pintado no tiene de dónde sacar la marca…
    await expect(page.locator('aside')).toContainText(NEUTRO);
    // …pero llega sola, sin recargar, cuando la API lo permite.
    await expect(page.locator('aside')).toContainText(NOMBRE, { timeout: 10_000 });
    await conSuMarca(page.locator('aside'));
    // Un único reintento compartido por todo lo que pinta la marca.
    expect(llamadas).toBe(2);
    await page.context().close();
  });
});
