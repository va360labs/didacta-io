/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { freshTenant } from '../helpers/simple-tenant';
import { startStripeDouble, type StripeDouble } from '../helpers/stripe-double';

/**
 * MODO SENCILLO (Didacta Cloud): de cero a enlace de venta.
 *
 * Una creadora recién llegada define su contraseña, entra, contesta el alta en
 * 3 preguntas, añade una lección de texto, publica y copia su enlace. Un
 * visitante abre el enlace y ve el botón de compra. Cuenta los clics y los
 * campos rellenados desde que entra (el acceso, igual en cualquier modo, se
 * cuenta aparte). Los cobros están conectados con la cuenta de pruebas del
 * arnés; el precio se crea en el doble de Stripe.
 *
 * Objetivo: < 15 clics y < 8 campos hasta tener el enlace de venta con precio.
 */

interface Contador {
  clicks: number;
  fields: number;
  click: (l: Locator) => Promise<void>;
  fill: (l: Locator, v: string) => Promise<void>;
}

function contar(): Contador {
  const c: Contador = {
    clicks: 0,
    fields: 0,
    click: async (l) => {
      c.clicks += 1;
      await l.click();
    },
    fill: async (l, v) => {
      c.fields += 1;
      await l.fill(v);
    },
  };
  return c;
}

let stripe: StripeDouble;
test.beforeAll(async () => {
  stripe = await startStripeDouble();
});
test.afterAll(async () => {
  await stripe?.close();
});

async function acceso(page: Page, url: string, email: string, password: string): Promise<Contador> {
  const a = contar();
  await page.goto(url);
  const pw = page.locator('input[type="password"]');
  await a.fill(pw.nth(0), password);
  await a.fill(pw.nth(1), password);
  await a.click(page.getByRole('button', { name: /contraseña|password/i }).last());
  await page.waitForURL(/\/signin/, { timeout: 20_000 });
  await a.fill(page.locator('input[autocomplete="email"]'), email);
  await a.fill(page.locator('input[autocomplete="current-password"]'), password);
  await a.click(page.locator('button[type="submit"]'));
  return a;
}

test('modo sencillo: de cero a enlace de venta con precio', async ({ browser }) => {
  test.setTimeout(180_000);
  const tenant = await freshTenant(`sencillo${Date.now().toString(36)}`, true);
  const ctx = await browser.newContext({
    locale: 'es-ES',
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  const page = await ctx.newPage();

  const a = await acceso(page, tenant.setPasswordUrl, tenant.creatorEmail, tenant.password);

  // ── Desde que entra: el camino hasta vender ─────────────────────────────
  const c = contar();
  await page.waitForURL(/\/bienvenida/, { timeout: 30_000 });

  // Alta en 3 preguntas.
  await c.fill(page.getByLabel('Nombre de la academia'), 'Taller de Acuarela');
  await c.click(page.getByRole('button', { name: 'Siguiente' }));
  await expect(page.getByRole('radio', { name: /Un curso/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await c.fill(page.getByLabel('¿Cómo se llama el curso?'), 'Acuarela desde cero');
  await c.click(page.getByRole('button', { name: 'Siguiente' }));
  await c.fill(page.getByLabel('Precio'), '49');
  await c.click(page.getByRole('button', { name: 'Crear mi academia' }));
  await page.waitForURL(/\/empieza/, { timeout: 30_000 });
  await expect(page.getByTestId('empieza-aqui')).toBeVisible();
  // Lo que dejó el alta: academia con nombre, precio y enlace aún apagado.
  await expect(page.locator('[data-step="price"][data-done="1"]')).toContainText('49');
  await expect(page.getByTestId('copiar-enlace')).toBeDisabled();

  // Paso 2: una lección de texto.
  await c.click(page.getByRole('link', { name: 'Añadir mi primera lección' }));
  await expect(page.getByTestId('editor-sencillo')).toBeVisible();
  await c.click(page.getByTestId('tipo-TEXT'));
  await c.fill(page.getByLabel('Título de la lección'), 'Bienvenida');
  await c.fill(
    page.getByLabel('Texto de la lección'),
    'Hola. En este curso aprenderás a pintar con acuarela desde cero.',
  );
  await c.click(page.getByTestId('guardar-leccion'));
  await expect(page.getByText('1. Bienvenida')).toBeVisible();

  // Volver a «Empieza aquí», publicar y copiar el enlace.
  await c.click(
    page
      .getByRole('navigation', { name: 'Secciones' })
      .first()
      .getByRole('link', { name: /Empieza aquí/ }),
  );
  await page.waitForURL(/\/empieza/);
  await c.click(page.getByTestId('publicar'));
  await expect(page.getByTestId('copiar-enlace')).toBeEnabled({ timeout: 20_000 });
  await c.click(page.getByTestId('copiar-enlace'));
  const enlace = await page.evaluate(() => navigator.clipboard.readText());
  expect(enlace).toContain('/catalogo/acuarela-desde-cero');

  // El precio salió hacia el doble de Stripe (nunca hacia Stripe real).
  expect(
    stripe.calls.some(
      (x) => x.path === '/v1/prices' && x.body.unit_amount === '4900' && x.body.currency === 'eur',
    ),
  ).toBe(true);

  // ── Un visitante abre el enlace y ve el botón de compra ─────────────────
  const visitante = await browser.newContext({ locale: 'es-ES' });
  const v = await visitante.newPage();
  await v.goto(enlace);
  await expect(v.getByRole('heading', { name: /Acuarela desde cero/ }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(v.getByRole('button', { name: /comprar/i }).first()).toBeVisible();
  await expect(v.getByText(/49/).first()).toBeVisible();

  const resultado = {
    acceso: { clicks: a.clicks, campos: a.fields },
    hastaEnlace: { clicks: c.clicks, campos: c.fields },
  };
  // eslint-disable-next-line no-console
  console.log('[modo sencillo] recuento', JSON.stringify(resultado));
  if (process.env.E2E_RECUENTO_FILE)
    writeFileSync(process.env.E2E_RECUENTO_FILE, JSON.stringify(resultado, null, 2));
  expect(c.clicks).toBeLessThan(15);
  expect(c.fields).toBeLessThan(8);
  await visitante.close();
  await ctx.close();
});
