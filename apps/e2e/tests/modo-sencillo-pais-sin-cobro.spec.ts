/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { apiAs, freshTenant, type FreshTenant } from '../helpers/simple-tenant';
import { startStripeDouble, type StripeDouble } from '../helpers/stripe-double';

/**
 * MODO SENCILLO · CREADORA CON EL BANCO EN UN PAÍS DONDE NO SE LE PUEDE PAGAR.
 *
 * Didacta Cloud cobra por plataforma y solo puede pagar a creadores con el
 * banco en los países de `PAYMENTS_PLATFORM_SUPPORTED_COUNTRIES`. Antes, una
 * creadora de Brasil pulsaba «Conectar cobros» y la tarjeta le preseleccionaba
 * ESPAÑA en silencio: acababa en un alta de Stripe para España que iba a
 * fallar. Y en un ensayo general, a una creadora que en el alta de Cloud dijo
 * tener el banco en «Otro país» también se le preseleccionaba España. Ahora:
 *
 *  1. El paso «Conecta tus cobros» de «Empieza aquí» lo dice ahí mismo en vez
 *     del botón (con el nombre del país, o «otro país»), y deja un enlace a la
 *     tarjeta.
 *  2. La tarjeta de «Ventas» preselecciona el país de la creadora —el que
 *     DECLARÓ en el alta de Cloud y, sin él, el del navegador—, con el aviso a
 *     la vista y el botón apagado; si elige un país admitido, se enciende.
 *
 * Todo es real (aula nueva, alta en 3 preguntas, «Empieza aquí», «Ventas» y la
 * tarjeta) salvo dos respuestas que el arnés no puede dar: el arnés no arranca
 * la API en modo plataforma, así que se fija la de `GET /modules/payouts/status`
 * (la que daría Cloud sin cuenta conectada, con o sin país declarado) y se
 * marca el paso de cobros como sin hacer (el arnés trae los cobros conectados
 * con su cuenta de pruebas).
 *
 * Con `E2E_CAPTURAS_DIR`, guarda ahí capturas de 1440 px de ancho del paso y
 * de la tarjeta (`aula-…png`).
 */

const CAPTURAS = process.env.E2E_CAPTURAS_DIR;

/** Lo que responde la API en modo plataforma a un aula sin cuenta conectada. */
function platformStatus(declaredCountry: string | null) {
  return {
    platform: true,
    operatorName: 'Didacta',
    mode: 'platform',
    ready: false,
    reason: 'not_connected',
    account: null,
    // Los de `DEFAULT_SUPPORTED_COUNTRIES` más habituales; Brasil no está.
    supportedCountries: ['ES', 'PT', 'FR', 'DE', 'IT', 'NL', 'IE', 'GB', 'CH', 'US', 'CA'],
    declaredCountry,
    feeBps: 500,
    settlementCurrency: null,
    priceCurrencies: ['eur', 'usd', 'gbp'],
  };
}

let stripe: StripeDouble;
test.beforeAll(async () => {
  stripe = await startStripeDouble();
});
test.afterAll(async () => {
  await stripe?.close();
});

/** Creadora recién llegada: contraseña, entrada, perfil y alta en 3 preguntas (en español). */
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

/**
 * Aula nueva y creadora en «Empieza aquí», con la interfaz en `ui` (el alta se
 * hace en español y después se cambia) y el navegador en `navegador`. Desde
 * ahí, la instalación «está» en modo plataforma, sin cobros y con
 * `declaredCountry` como país declarado en el alta de Cloud.
 */
async function enEmpiezaAqui(
  browser: Browser,
  opts: { navegador: string; ui: 'es-ES' | 'pt-BR'; declaredCountry: string | null },
): Promise<{ ctx: BrowserContext; page: Page }> {
  const tenant = await freshTenant(`paises${Date.now().toString(36)}`, true);
  const ctx = await browser.newContext({
    locale: opts.navegador,
    viewport: { width: 1440, height: 900 },
  });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  const page = await ctx.newPage();
  await creadoraConCurso(page, tenant);
  expect(await page.evaluate(() => navigator.language)).toBe(opts.navegador);

  await page.route('**/api/v1/modules/payouts/status*', (route) =>
    route.fulfill({ json: platformStatus(opts.declaredCountry) }),
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
  if (opts.ui !== 'es-ES') {
    await ctx.addCookies([{ name: 'didacta_locale', value: opts.ui, url: tenant.base }]);
  }
  await page.reload();
  await expect(page.locator('[data-step="payments"]')).toHaveAttribute('aria-current', 'step', {
    timeout: 20_000,
  });
  return { ctx, page };
}

async function captura(page: Page, nombre: string): Promise<void> {
  if (!CAPTURAS) return;
  mkdirSync(CAPTURAS, { recursive: true });
  // Fuera de la animación del esqueleto y con las fuentes ya cargadas.
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(CAPTURAS, nombre), fullPage: true });
}

/** De «Empieza aquí» a la tarjeta de «Ventas» por el enlace del aviso. */
async function aLaTarjeta(page: Page, enlace: string) {
  await page.locator('[data-step="payments"]').getByRole('link', { name: enlace }).click();
  await page.waitForURL(/\/admin\/payments/, { timeout: 20_000 });
  await expect(page.getByTestId('ventas-sencillo')).toBeVisible({ timeout: 20_000 });
  const card = page.getByTestId('payouts-card');
  await expect(card).toHaveAttribute('data-state', 'not-connected', { timeout: 20_000 });
  return card;
}

test('banco en Brasil (por el navegador) → el paso lo dice y la tarjeta no preselecciona España', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { ctx, page } = await enEmpiezaAqui(browser, {
    navegador: 'pt-BR',
    ui: 'es-ES',
    declaredCountry: null,
  });
  const step = page.locator('[data-step="payments"]');
  const notice = page.getByTestId('cobros-pais-no-admitido');
  await expect(notice).toHaveAttribute('data-country', 'BR');
  await expect(notice.getByRole('status')).toHaveText(
    'Todavía no podemos pagar a creadores con el banco en Brasil. Mientras tanto puedes montar tu academia y tu comunidad.',
  );
  await expect(step.getByRole('link', { name: 'Conectar cobros' })).toHaveCount(0);

  const card = await aLaTarjeta(page, '¿Tu banco está en otro país?');
  const country = card.getByLabel('País');
  await expect(country).toHaveValue('BR');
  await expect(card.getByTestId('payouts-country-unsupported')).toHaveText(
    'Todavía no podemos pagar a cuentas de Brasil. Mientras tanto puedes montar tu academia y tu comunidad.',
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

test('declaró «Otro país» en el alta de Cloud (es) → «otro país» en el paso y en la tarjeta, nunca España', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  // Navegador en España: sin lo declarado, aquí saldría el botón y España.
  const { ctx, page } = await enEmpiezaAqui(browser, {
    navegador: 'es-ES',
    ui: 'es-ES',
    declaredCountry: 'OTHER',
  });
  const step = page.locator('[data-step="payments"]');
  const notice = page.getByTestId('cobros-pais-no-admitido');
  await expect(notice).toHaveAttribute('data-country', 'OTHER');
  await expect(notice.getByRole('status')).toHaveText(
    'Al darte de alta nos dijiste que tu banco está en otro país, y todavía no podemos pagar a creadores con el banco fuera de los países admitidos. Mientras tanto puedes montar tu academia y tu comunidad.',
  );
  await expect(step.getByRole('link', { name: 'Conectar cobros' })).toHaveCount(0);
  await captura(page, 'aula-otro-pais-es-empieza-aqui.png');

  const card = await aLaTarjeta(page, 'Elegir el país de mi banco');
  const country = card.getByLabel('País');
  await expect(country).toHaveValue('OTHER');
  await expect(country.locator('option:checked')).toHaveText('Otro país');
  await expect(card.getByTestId('payouts-country-unsupported')).toHaveText(
    'Al darte de alta nos dijiste que tu banco está en otro país. Todavía no podemos pagar a creadores con el banco fuera de los países admitidos; si ahora lo tienes en uno de ellos, elígelo en la lista. Mientras tanto puedes montar tu academia y tu comunidad.',
  );
  const connect = card.getByRole('button', { name: 'Conectar cobros' });
  await expect(connect).toBeDisabled();
  await captura(page, 'aula-otro-pais-es-ventas.png');

  // Si ahora tiene banco en un país admitido, lo elige y puede seguir.
  await country.selectOption('ES');
  await expect(card.getByTestId('payouts-country-unsupported')).toHaveCount(0);
  await expect(connect).toBeEnabled();
  await ctx.close();
});

test('declaró Brasil en el alta de Cloud (pt-BR) → «Comece aqui» y «Vendas» con Brasil, aunque el navegador diga EE. UU.', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  // Navegador en inglés de EE. UU. (país admitido): lo que manda es lo declarado.
  const { ctx, page } = await enEmpiezaAqui(browser, {
    navegador: 'en-US',
    ui: 'pt-BR',
    declaredCountry: 'BR',
  });
  await expect(page.getByRole('link', { name: /Comece aqui/ }).first()).toBeVisible();
  const step = page.locator('[data-step="payments"]');
  const notice = page.getByTestId('cobros-pais-no-admitido');
  await expect(notice).toHaveAttribute('data-country', 'BR');
  await expect(notice.getByRole('status')).toHaveText(
    'Ainda não conseguimos pagar criadores com banco neste país (Brasil). Enquanto isso, você pode montar sua escola e sua comunidade.',
  );
  await expect(step.getByRole('link', { name: 'Conectar recebimentos' })).toHaveCount(0);
  await captura(page, 'aula-brasil-pt-comece-aqui.png');

  const card = await aLaTarjeta(page, 'Seu banco está em outro país?');
  await expect(page.getByRole('heading', { name: 'Vendas', level: 1 })).toBeVisible();
  const country = card.getByLabel('País');
  await expect(country).toHaveValue('BR');
  await expect(card.getByTestId('payouts-country-unsupported')).toHaveText(
    'Ainda não conseguimos fazer pagamentos para contas no país que você informou (Brasil). Enquanto isso, você pode montar sua escola e sua comunidade.',
  );
  await expect(card.getByRole('button', { name: 'Conectar recebimentos' })).toBeDisabled();
  await captura(page, 'aula-brasil-pt-vendas.png');
  await ctx.close();
});
