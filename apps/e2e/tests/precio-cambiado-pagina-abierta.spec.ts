/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Venta real del 14-nov-2026: la creadora bajó el precio de 29 € a 1 € y
 *  - una sesión de pago de 29 € siguió abierta 24 h (se podía pagar);
 *  - la página de venta que alguien tenía abierta seguía enseñando 29 € y al
 *    pulsar comprar se le cobró 1 €.
 *
 * Aquí, con el producto entero (web + API + doble de Stripe):
 *  1. Una visitante abre el pago a 29 € (sesión abierta en «Stripe»).
 *  2. Otra tiene la página de venta abierta a 29 €.
 *  3. La creadora baja el precio a 1 € desde la API de precios.
 *     → la sesión abierta se caduca en Stripe y su pedido queda caducado.
 *  4. La segunda pulsa «Comprar ahora» con la página vieja: NO sale al pago;
 *     ve el aviso y el precio de ahora (1,00 €). Al volver a pulsar, paga 1 €.
 *
 * Capturas (escritorio y móvil) con `E2E_CAPTURAS_DIR`.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';
import { startStripeDouble, type StripeDouble } from '../helpers/stripe-double';

const CAPTURAS = process.env.E2E_CAPTURAS_DIR;
/** Como lo pinta la ficha: «29 €» (Intl separa con espacio duro). */
const EUR29 = /^29\s€$/;
const EUR1 = /^1\s€$/;
const EUR2 = /^2\s€$/;
const AVISO =
  'El precio de este curso acaba de cambiar. Ya ves el precio actual: revísalo y vuelve a pulsar para pagar.';

let stripe: StripeDouble;
test.beforeAll(async () => {
  stripe = await startStripeDouble();
});
test.afterAll(async () => {
  await stripe?.close();
});

async function visitante(browser: Browser, tenant: FreshTenant, mobile = false) {
  const ctx = await browser.newContext({
    locale: 'es-ES',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    baseURL: tenant.base,
  });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  return ctx.newPage();
}

async function abrirFicha(page: Page, salePath: string, precio: RegExp) {
  await page.goto(salePath);
  await expect(page.getByRole('heading', { name: 'Curso de prueba de precio' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(precio).first()).toBeVisible();
}

async function captura(page: Page, nombre: string) {
  if (!CAPTURAS) return;
  await page.screenshot({ path: `${CAPTURAS}/${nombre}.png`, fullPage: false });
}

test('precio cambiado con la página abierta: se caduca la sesión vieja y no se cobra otro importe', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const tenant = await freshTenant(`precio${Date.now().toString(36)}`, true);
  const { tokens } = await apiAs<{ tokens: { accessToken: string } }>(
    tenant.host,
    '/api/v1/auth/signin',
    {
      method: 'POST',
      body: {
        tenantSlug: tenant.slug,
        email: `operador@${tenant.slug}.test`,
        password: tenant.password,
      },
    },
  );
  const bearer = tokens.accessToken;

  // Un curso suelto a 29 € (alta en 3 preguntas + una lección + publicar).
  const alta = await apiAs<{ offer: { courseId: string } }>(
    tenant.host,
    '/api/v1/admin/simple-mode/quick-start',
    {
      method: 'POST',
      bearer,
      body: {
        academyName: 'Academia del precio',
        offer: 'course',
        title: 'Curso de prueba de precio',
        amountCents: 2900,
        currency: 'eur',
        locale: 'es',
      },
    },
  );
  const courseId = alta.offer.courseId;
  const moduleId = sql(
    `SELECT id FROM mod_courses_module WHERE course_id = '${courseId}' ORDER BY created_at LIMIT 1`,
  );
  await apiAs(tenant.host, `/api/v1/modules/courses/modules/${moduleId}/lessons`, {
    method: 'POST',
    bearer,
    body: {
      title: 'Primera clase',
      type: 'TEXT',
      orderIndex: 0,
      content: { text: 'Bienvenida.' },
      durationSec: 60,
    },
  });
  const { salePath } = await apiAs<{ salePath: string }>(
    tenant.host,
    '/api/v1/admin/simple-mode/publish',
    { method: 'POST', bearer, body: {} },
  );
  const productId = sql(
    `SELECT id FROM mod_billing_product WHERE course_id = '${courseId}' AND active LIMIT 1`,
  );
  expect(productId).not.toBe('');

  // ── 1. Una visitante abre el pago a 29 €: sesión abierta en «Stripe».
  const primera = await visitante(browser, tenant);
  await abrirFicha(primera, salePath, EUR29);
  await primera.getByRole('checkbox').check();
  await primera.getByRole('button', { name: 'Comprar ahora' }).click();
  await primera.waitForURL(/127\.0\.0\.1:\d+\/pagar\//, { timeout: 30_000 });
  const sesionVieja = decodeURIComponent(new URL(primera.url()).pathname.split('/').pop()!);
  expect(
    sql(`SELECT status FROM mod_billing_order WHERE stripe_session_id = '${sesionVieja}'`),
  ).toBe('PENDING');

  // ── 2. Otra tiene la página de venta abierta, a 29 €.
  const segunda = await visitante(browser, tenant);
  await abrirFicha(segunda, salePath, EUR29);

  // ── 3. La creadora baja el precio a 1 €.
  const caducadasAntes = stripe.calls.filter((c) => c.path.endsWith('/expire')).length;
  await apiAs(tenant.host, `/api/v1/modules/billing/products/${productId}`, {
    method: 'PATCH',
    bearer,
    body: { amountCents: 100 },
  });
  const caducadas = stripe.calls.filter((c) => c.path.endsWith('/expire')).slice(caducadasAntes);
  expect(caducadas.map((c) => decodeURIComponent(c.path.split('/')[4]!))).toEqual([sesionVieja]);
  expect(
    sql(`SELECT status FROM mod_billing_order WHERE stripe_session_id = '${sesionVieja}'`),
  ).toBe('CANCELLED');

  // ── 4. La segunda pulsa con la página vieja: aviso y precio de ahora.
  const pedidosAntes = Number(
    sql(`SELECT count(*) FROM mod_billing_order WHERE course_id = '${courseId}'`),
  );
  await segunda.getByRole('checkbox').check();
  await segunda.getByRole('button', { name: 'Comprar ahora' }).click();
  await expect(segunda.getByText(AVISO)).toBeVisible({ timeout: 20_000 });
  await expect(segunda.getByText(EUR1).first()).toBeVisible();
  await expect(segunda.getByText(EUR29)).toHaveCount(0);
  expect(new URL(segunda.url()).pathname).toBe(salePath);
  // Ni pedido ni sesión con un precio que no ha visto.
  expect(
    Number(sql(`SELECT count(*) FROM mod_billing_order WHERE course_id = '${courseId}'`)),
  ).toBe(pedidosAntes);
  await captura(segunda, 'precio-cambiado-ficha-escritorio');

  // Con el precio nuevo delante, sí sale al pago (y con el precio nuevo).
  await segunda.getByRole('button', { name: 'Comprar ahora' }).click();
  await segunda.waitForURL(/127\.0\.0\.1:\d+\/pagar\//, { timeout: 30_000 });
  const nueva = stripe.calls
    .filter((c) => c.method === 'POST' && c.path === '/v1/checkout/sessions')
    .at(-1)!;
  const precioNuevo = sql(
    `SELECT stripe_price_id FROM mod_billing_product WHERE id = '${productId}'`,
  );
  expect(nueva.body['line_items[0][price]']).toBe(precioNuevo);

  // ── Móvil: misma situación (página abierta a 1 €, la creadora lo sube a 2 €).
  const movil = await visitante(browser, tenant, true);
  await abrirFicha(movil, salePath, EUR1);
  await apiAs(tenant.host, `/api/v1/modules/billing/products/${productId}`, {
    method: 'PATCH',
    bearer,
    body: { amountCents: 200 },
  });
  await movil.getByRole('checkbox').check();
  await movil.getByRole('button', { name: 'Comprar ahora' }).click();
  await expect(movil.getByText(AVISO)).toBeVisible({ timeout: 20_000 });
  await expect(movil.getByText(EUR2).first()).toBeVisible();
  await movil.getByText(AVISO).scrollIntoViewIfNeeded();
  await captura(movil, 'precio-cambiado-ficha-movil');
});
