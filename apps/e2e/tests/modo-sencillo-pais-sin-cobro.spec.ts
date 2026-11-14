/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Page } from '@playwright/test';
import { apiAs, freshTenant, type FreshTenant } from '../helpers/simple-tenant';
import { startStripeDouble, type StripeDouble } from '../helpers/stripe-double';

/**
 * MODO SENCILLO · CREADOR CON EL BANCO EN UN PAÍS DONDE NO SE LE PUEDE PAGAR.
 *
 * Didacta Cloud cobra por plataforma y solo puede pagar a creadores con el
 * banco en los países de `PAYMENTS_PLATFORM_SUPPORTED_COUNTRIES`. Antes, una
 * creadora de Brasil pulsaba «Conectar cobros» y la tarjeta le preseleccionaba
 * ESPAÑA en silencio: acababa en un alta de Stripe para España que iba a
 * fallar. Ahora:
 *
 *  1. El paso «Conecta tus cobros» de «Empieza aquí» lo dice ahí mismo (con el
 *     nombre del país) en vez del botón, y deja un enlace por si su banco está
 *     en otro país.
 *  2. Ese enlace lleva a la tarjeta de cobros con BRASIL preseleccionado: el
 *     aviso a la vista y el botón apagado. Si elige un país admitido, el botón
 *     se enciende.
 *
 * Todo es real (aula nueva, alta en 3 preguntas, «Empieza aquí», «Ventas» y la
 * tarjeta) salvo dos respuestas que el arnés no puede dar: el arnés no arranca
 * la API en modo plataforma, así que se fija la de `GET /modules/payouts/status`
 * (la que daría Cloud sin cuenta conectada) y se marca el paso de cobros como
 * sin hacer (el arnés trae los cobros conectados con su cuenta de pruebas).
 *
 * La interfaz va en español (cookie del aula) y el navegador en `pt-BR`: el
 * país sale del idioma del NAVEGADOR, no del de la interfaz.
 */

/** Lo que responde la API en modo plataforma a un aula sin cuenta conectada. */
const PLATFORM_STATUS = {
  platform: true,
  operatorName: 'Didacta',
  mode: 'platform',
  ready: false,
  reason: 'not_connected',
  account: null,
  // Los de `DEFAULT_SUPPORTED_COUNTRIES` más habituales; Brasil no está.
  supportedCountries: ['ES', 'PT', 'FR', 'DE', 'IT', 'NL', 'IE', 'GB', 'CH', 'US', 'CA'],
  feeBps: 500,
  settlementCurrency: null,
  priceCurrencies: ['eur', 'usd', 'gbp'],
};

let stripe: StripeDouble;
test.beforeAll(async () => {
  stripe = await startStripeDouble();
});
test.afterAll(async () => {
  await stripe?.close();
});

/** Creadora recién llegada: contraseña, entrada, perfil y alta en 3 preguntas. */
async function creadoraConCurso(page: Page, tenant: FreshTenant): Promise<void> {
  await page.goto(tenant.setPasswordUrl);
  const pw = page.locator('input[type="password"]');
  await pw.nth(0).fill(tenant.password);
  await pw.nth(1).fill(tenant.password);
  await page
    .getByRole('button', { name: /contraseña|password/i })
    .last()
    .click();
  await page.waitForURL(/\/signin/, { timeout: 20_000 });
  await page.locator('input[autocomplete="email"]').fill(tenant.creatorEmail);
  await page.locator('input[autocomplete="current-password"]').fill(tenant.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Dejar para luego' }).click();
  await page.getByLabel(/Nombre de perfil/).fill('Ana Aquarela');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Tus notificaciones' })).toBeVisible();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Seguir con mi academia' }).click();
  await page.waitForURL(/\/welcome/, { timeout: 30_000 });
  await page.getByLabel('Nombre de la academia').fill('Escola de Aquarela');
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await page.getByLabel('¿Cómo se llama el curso?').fill('Aquarela do zero');
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await page.getByLabel('Precio').fill('49');
  await page.getByRole('button', { name: 'Crear mi academia' }).click();
  await page.waitForURL(/\/start/, { timeout: 30_000 });
}

test('modo sencillo: banco en Brasil → el paso de cobros lo dice y la tarjeta no preselecciona España', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const tenant = await freshTenant(`paises${Date.now().toString(36)}`, true);
  const ctx = await browser.newContext({ locale: 'pt-BR', viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  const page = await ctx.newPage();
  await creadoraConCurso(page, tenant);
  expect(await page.evaluate(() => navigator.language)).toBe('pt-BR');

  // Desde aquí, la instalación «está» en modo plataforma y sin cobros.
  await page.route('**/api/v1/modules/payouts/status*', (route) =>
    route.fulfill({ json: PLATFORM_STATUS }),
  );
  await page.route('**/api/v1/admin/simple-mode/start-here', async (route) => {
    // La vista REAL del aula (por la API, con el Host del aula: desde Node
    // `*.localhost` no resuelve y `route.fetch` no llega).
    const bearer = (route.request().headers()['authorization'] ?? '').replace(/^Bearer /, '');
    const view = await apiAs<{
      steps: Array<{ id: string; done: boolean }>;
      paymentsSetupPath: string;
    }>(tenant.host, '/api/v1/admin/simple-mode/start-here', { bearer });
    // Academia, curso y precio hechos; cobros (y lo que va detrás) sin hacer.
    const before = new Set(['academy', 'course', 'price']);
    view.steps = view.steps.map((s) => ({ ...s, done: before.has(s.id) }));
    view.paymentsSetupPath = '/admin/payments';
    await route.fulfill({ json: view });
  });
  await page.reload();

  // 1. El paso abierto es el de cobros, y en vez del botón, el aviso.
  const step = page.locator('[data-step="payments"]');
  await expect(step).toHaveAttribute('aria-current', 'step', { timeout: 20_000 });
  const notice = page.getByTestId('cobros-pais-no-admitido');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('data-country', 'BR');
  await expect(notice).toContainText(
    'Todavía no podemos pagar a creadores con el banco en Brasil. Mientras tanto puedes montar tu academia y tu comunidad; te avisaremos cuando se pueda cobrar desde tu país.',
  );
  await expect(step.getByRole('link', { name: 'Conectar cobros' })).toHaveCount(0);

  // 2. «¿Tu banco está en otro país?» → la tarjeta, con Brasil preseleccionado.
  await step.getByRole('link', { name: '¿Tu banco está en otro país?' }).click();
  await page.waitForURL(/\/admin\/payments/, { timeout: 20_000 });
  await expect(page.getByTestId('ventas-sencillo')).toBeVisible({ timeout: 20_000 });
  const card = page.getByTestId('payouts-card');
  await expect(card).toHaveAttribute('data-state', 'not-connected', { timeout: 20_000 });
  const country = card.getByLabel('País');
  await expect(country).toHaveValue('BR');
  await expect(card.getByTestId('payouts-country-unsupported')).toContainText(
    'Todavía no podemos pagar a cuentas de Brasil.',
  );
  const connect = card.getByRole('button', { name: 'Conectar cobros' });
  await expect(connect).toBeDisabled();

  // Con el banco en un país admitido, el botón se enciende (no se pulsa: el
  // arnés no tiene el alta de Stripe de plataforma).
  await country.selectOption('ES');
  await expect(card.getByTestId('payouts-country-unsupported')).toHaveCount(0);
  await expect(connect).toBeEnabled();

  await ctx.close();
});
