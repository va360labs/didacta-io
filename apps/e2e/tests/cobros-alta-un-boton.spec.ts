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
 * COBROS · UN SOLO BOTÓN, CON ESTADO DE CARGA, Y NO PREGUNTAR DOS VECES.
 *
 * Prueba real del 14-nov-2026 (primera venta de 1 € en Didacta Cloud):
 *
 *  1. «Empieza aquí» llevaba a «Ventas», donde había otro formulario y otro
 *     botón igual: «Conectar cobros» se pulsaba dos veces. Ahora el paso abre
 *     el alta de Stripe él solo, con UN botón (y particular/empresa al lado).
 *  2. «Abriendo Stripe…» tardaba 8 s sin más señal. Ahora el botón se apaga
 *     con un indicador, debajo sale «puede tardar unos segundos» y un doble
 *     clic no hace una segunda petición.
 *  3. Stripe pidió un teléfono de atención y el móvil personal quedó a la
 *     vista de los alumnos: antes de ir se avisa.
 *  4. «Tus datos fiscales» volvía a preguntar particular/empresa y hablaba de
 *     «normativa DAC7»: ahora lo enseña con «Cambiar» y lo explica en llano.
 *
 * Real: aula nueva, alta en 3 preguntas, «Empieza aquí», «Ventas» y las
 * tarjetas. Lo que el arnés no puede dar se fija en la red (el arnés no
 * arranca la API en modo plataforma ni hay alta de Stripe): el estado de
 * cobros de Cloud, la respuesta de `POST /modules/payouts/connect` (con un
 * retraso como el de Stripe) y la página del alta, y los datos fiscales que
 * propone Stripe.
 *
 * Con `E2E_CAPTURAS_DIR`, capturas en escritorio (1440) y móvil (390):
 * `cobros-un-boton-*.png`.
 */

const CAPTURAS = process.env.E2E_CAPTURAS_DIR;

const SUPPORTED = ['ES', 'PT', 'FR', 'DE', 'IT', 'NL', 'IE', 'GB', 'CH', 'US', 'CA'];

/** La API en modo plataforma: sin cuenta, o con el alta empezada. */
function platformStatus(account: 'none' | 'onboarding') {
  return {
    platform: true,
    operatorName: 'Didacta',
    mode: 'platform',
    ready: false,
    reason: 'not_connected',
    account:
      account === 'none'
        ? null
        : {
            status: 'ONBOARDING',
            stripeAccountId: 'acct_e2eAltaUnBoton',
            country: 'ES',
            entityType: 'individual',
            defaultCurrency: null,
            payoutsEnabled: false,
            pendingRequirement: 'bank_account',
            requirementsDeadline: null,
            disabledReason: null,
            payoutSchedule: null,
            readyAt: null,
            lastSyncedAt: null,
          },
    supportedCountries: SUPPORTED,
    declaredCountry: 'ES',
    feeBps: 500,
    settlementCurrency: null,
    priceCurrencies: ['eur', 'usd', 'gbp'],
  };
}

/** Lo que propone Stripe tras conectar como particular (aún sin datos guardados). */
const TAX_FROM_STRIPE = {
  status: 'missing',
  required: true,
  profile: null,
  prefill: {
    entityType: 'individual',
    legalName: 'Ana Aquarela',
    country: 'ES',
    address: {
      line1: 'Calle Ancha 1',
      line2: null,
      postalCode: '11001',
      city: 'Cádiz',
      region: 'Cádiz',
    },
    birthDate: '1990-02-28',
  },
  missing: ['taxId'],
  heldSales: 0,
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
  await page.waitForURL((u) => !u.pathname.startsWith('/reset-password'), { timeout: 30_000 });
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

interface Escenario {
  ctx: BrowserContext;
  page: Page;
  tenant: FreshTenant;
  /** Cuerpos de cada `POST /modules/payouts/connect` que salió del navegador. */
  connects: unknown[];
  /** `POST /modules/payouts/connect/link` que salieron. */
  links: number;
}

/**
 * Aula nueva, creadora en «Empieza aquí» con el paso de cobros abierto y la
 * instalación «en modo plataforma». `connect` y `connect/link` responden tras
 * `retrasoMs` con una URL de alta del propio aula (`/__alta-stripe`), que se
 * sirve como una página cualquiera: así se ve la navegación sin salir del arnés.
 */
async function escenario(
  browser: Browser,
  opts: { account: 'none' | 'onboarding'; viewport: { width: number; height: number } },
  retrasoMs = 2500,
): Promise<Escenario> {
  const tenant = await freshTenant(`unboton${Date.now().toString(36)}`, true);
  const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  const page = await ctx.newPage();
  await creadoraConCurso(page, tenant);

  const state: Escenario = { ctx, page, tenant, connects: [], links: 0 };
  const altaUrl = `${tenant.base}/__alta-stripe`;
  await page.route('**/api/v1/modules/payouts/status*', (route) =>
    route.fulfill({ json: platformStatus(opts.account) }),
  );
  await page.route('**/api/v1/modules/payouts/tax-profile', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: TAX_FROM_STRIPE })
      : route.fallback(),
  );
  await page.route('**/api/v1/modules/payouts/connect', async (route) => {
    state.connects.push(route.request().postDataJSON());
    await new Promise((resolve) => setTimeout(resolve, retrasoMs));
    await route.fulfill({
      json: { account: platformStatus('onboarding').account, onboardingUrl: altaUrl },
    });
  });
  await page.route('**/api/v1/modules/payouts/connect/link', async (route) => {
    state.links += 1;
    await new Promise((resolve) => setTimeout(resolve, retrasoMs));
    await route.fulfill({ json: { url: altaUrl } });
  });
  await page.route('**/__alta-stripe', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>Alta de Stripe</title><h1>Alta de Stripe (doble del arnés)</h1>',
    }),
  );
  await page.route('**/api/v1/admin/simple-mode/start-here', async (route) => {
    const bearer = (route.request().headers()['authorization'] ?? '').replace(/^Bearer /, '');
    const view = await apiAs<{
      steps: Array<{ id: string; done: boolean }>;
      paymentsSetupPath: string;
    }>(tenant.host, '/api/v1/admin/simple-mode/start-here', { bearer });
    const before = new Set(['academy', 'course', 'price']);
    view.steps = view.steps.map((s) => ({ ...s, done: before.has(s.id) }));
    view.paymentsSetupPath = '/admin/payments';
    await route.fulfill({ json: view });
  });
  await page.setViewportSize(opts.viewport);
  await page.reload();
  await expect(page.locator('[data-step="payments"]')).toHaveAttribute('aria-current', 'step', {
    timeout: 20_000,
  });
  return state;
}

async function captura(page: Page, nombre: string): Promise<void> {
  if (!CAPTURAS) return;
  mkdirSync(CAPTURAS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(CAPTURAS, nombre), fullPage: true });
}

const ESCRITORIO = { width: 1440, height: 900 };
const MOVIL = { width: 390, height: 844 };

for (const [nombre, viewport] of [
  ['escritorio', ESCRITORIO],
  ['movil', MOVIL],
] as const) {
  test(`«Empieza aquí» (${nombre}): un botón abre Stripe, se ve que trabaja y el doble clic no repite`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const s = await escenario(browser, { account: 'none', viewport });
    const step = s.page.locator('[data-step="payments"]');

    // Un solo camino: el botón del paso (ya no hay enlace a «Ventas» que
    // lleve a otro formulario), con particular/empresa al lado.
    const button = step.getByTestId('conectar-cobros');
    await expect(button).toHaveText('Conectar cobros');
    await expect(step.getByRole('link', { name: 'Conectar cobros' })).toHaveCount(0);
    await expect(step.getByRole('radio', { name: 'Particular o autónomo' })).toBeChecked();
    await expect(step.getByRole('radio', { name: 'Empresa' })).not.toBeChecked();
    await expect(step.getByTestId('aviso-telefono')).toHaveText(
      'Stripe te pedirá un teléfono de atención al cliente: tus alumnos lo verán en sus recibos. Si no quieres dar tu móvil personal, pon uno de trabajo.',
    );
    await captura(s.page, `cobros-un-boton-empieza-${nombre}.png`);

    await button.dblclick();
    await expect(button).toBeDisabled();
    await expect(button).toHaveText('Abriendo Stripe…');
    await expect(step.getByTestId('cobros-alta-espera')).toHaveText(
      'Estamos preparando tu alta en Stripe. Puede tardar unos segundos: no cierres esta página.',
    );
    await captura(s.page, `cobros-un-boton-cargando-${nombre}.png`);

    await s.page.waitForURL(/\/__alta-stripe$/, { timeout: 20_000 });
    expect(s.connects).toEqual([{ country: 'ES', entityType: 'individual' }]);
    await s.ctx.close();
  });
}

test('«Empieza aquí»: empresa se elige una vez, aquí, y viaja en la petición', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const s = await escenario(browser, { account: 'none', viewport: ESCRITORIO }, 300);
  const step = s.page.locator('[data-step="payments"]');
  await step.getByRole('radio', { name: 'Empresa' }).check();
  await step.getByTestId('conectar-cobros').click();
  await s.page.waitForURL(/\/__alta-stripe$/, { timeout: 20_000 });
  expect(s.connects).toEqual([{ country: 'ES', entityType: 'company' }]);
  await s.ctx.close();
});

test('«Empieza aquí» con el alta empezada: el mismo botón la retoma sin preguntar nada', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const s = await escenario(browser, { account: 'onboarding', viewport: ESCRITORIO }, 1500);
  const step = s.page.locator('[data-step="payments"]');
  await expect(step.getByRole('radio')).toHaveCount(0);
  const resume = step.getByTestId('seguir-alta-stripe');
  await expect(resume).toHaveText('Seguir con el alta en Stripe');
  await captura(s.page, 'cobros-un-boton-retomar-escritorio.png');
  await resume.click();
  await expect(resume).toHaveText('Abriendo Stripe…');
  await s.page.waitForURL(/\/__alta-stripe$/, { timeout: 20_000 });
  expect(s.links).toBe(1);
  expect(s.connects).toHaveLength(0);
  await s.ctx.close();
});

for (const [nombre, viewport] of [
  ['escritorio', ESCRITORIO],
  ['movil', MOVIL],
] as const) {
  test(`«Ventas» (${nombre}): la tarjeta de cobros también enseña que trabaja y avisa del teléfono`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const s = await escenario(browser, { account: 'none', viewport });
    await s.page.goto(`${s.tenant.base}/admin/payments`);
    const card = s.page.getByTestId('payouts-card');
    await expect(card).toHaveAttribute('data-state', 'not-connected', { timeout: 20_000 });
    await expect(card.getByTestId('payouts-support-phone-note')).toBeVisible();
    const connect = card.getByTestId('payouts-connect');
    await connect.dblclick();
    await expect(connect).toBeDisabled();
    await expect(connect).toHaveText('Abriendo Stripe…');
    await expect(card.getByTestId('payouts-opening-notice')).toHaveText(
      'Estamos preparando tu alta en Stripe. Puede tardar unos segundos: no cierres esta página.',
    );
    await captura(s.page, `cobros-un-boton-ventas-cargando-${nombre}.png`);
    await s.page.waitForURL(/\/__alta-stripe$/, { timeout: 20_000 });
    expect(s.connects).toHaveLength(1);
    await s.ctx.close();
  });

  test(`«Tus datos fiscales» (${nombre}): particular/empresa no se vuelve a preguntar y el porqué va en llano`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const s = await escenario(browser, { account: 'none', viewport });
    await s.page.goto(`${s.tenant.base}/admin/payments?full=1`);
    const tax = s.page.getByTestId('payouts-tax-profile');
    await expect(tax).toBeVisible({ timeout: 20_000 });
    await expect(
      tax.getByText(
        'La ley obliga a las plataformas a informar a Hacienda de lo que venden los creadores; con estos datos te hacemos también la factura de nuestra comisión.',
      ),
    ).toBeVisible();
    await expect(tax).not.toContainText('DAC7');
    // Ya elegido al conectar: se enseña con «Cambiar», sin las dos opciones.
    const known = tax.getByTestId('tax-entity-known');
    await expect(known).toContainText('Particular o autónomo');
    await expect(tax.getByRole('radio')).toHaveCount(0);
    await captura(s.page, `cobros-un-boton-fiscales-${nombre}.png`);
    // Y si hace falta cambiarlo, se puede.
    await known.getByRole('button', { name: 'Cambiar' }).click();
    await expect(tax.getByRole('radio')).toHaveCount(2);
    await s.ctx.close();
  });
}
