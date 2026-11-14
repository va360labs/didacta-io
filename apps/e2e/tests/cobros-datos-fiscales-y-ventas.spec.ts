/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';
import { startStripeDouble, type StripeDouble } from '../helpers/stripe-double';

/**
 * COBROS Y VENTAS tras el ensayo general de Didacta Cloud.
 *
 * Lo que vio la creadora: «Empieza aquí» marcaba «Conecta tus cobros · Listo
 * para cobrar» y «Ventas» decía «el dinero de cada venta llega a tu banco»,
 * pero sin datos fiscales la transferencia se quedaba retenida y solo se
 * avisaba tras «Ver detalles». Ahora:
 *
 *  1. El paso de cobros sigue PENDIENTE («Falta: datos fiscales»), lo explica
 *     y lleva directo a completarlos. Publicar NO espera (web #39: se cobra
 *     igual y se retiene): se avisa junto al botón y, ya publicado, en la
 *     tarjeta del enlace.
 *  2. «Ventas» lo avisa arriba, con las ventas retenidas y su importe, y el
 *     formulario ahí mismo; lo retenido no se cuenta «en camino».
 *  3. Un NIF mal escrito dice «El NIF no es válido…», no «faltan campos».
 *  4. Tras devolver una venta entera, «Recibido» no sigue diciendo lo que se
 *     envió ni la venta «llega hacia el 23 nov».
 *
 * Todo es real (aula nueva, alta en 3 preguntas, «Empieza aquí», «Ventas»)
 * salvo lo que solo existe con la API en modo plataforma, que el arnés no
 * arranca: las respuestas de `/modules/payouts/*` (las que da Cloud en ese
 * estado) y, en «Empieza aquí», el paso de cobros (la vista REAL del aula con
 * el paso de cobros como lo calcula Cloud sin datos fiscales). Lo que calcula
 * la API lo fijan sus tests (`simple-mode.service.test.ts`,
 * `reports.service.test.ts`, `payouts-losses.integration.test.ts`).
 *
 * `E2E_CAPTURAS=<carpeta>` guarda capturas de cada pantalla.
 */

const CAPTURAS = process.env.E2E_CAPTURAS;

/** Cuenta de cobros lista (Cloud, España, euros, pago semanal). */
const STATUS_READY = {
  platform: true,
  operatorName: 'Didacta',
  mode: 'platform',
  ready: true,
  reason: null,
  account: {
    status: 'READY',
    stripeAccountId: 'acct_e2e',
    country: 'ES',
    entityType: 'individual',
    defaultCurrency: 'eur',
    payoutsEnabled: true,
    pendingRequirement: null,
    requirementsDeadline: null,
    disabledReason: null,
    payoutSchedule: {
      interval: 'weekly',
      weeklyDay: 'monday',
      monthlyDay: null,
      delayDays: 7,
      minimumBalance: null,
    },
    readyAt: '2026-11-14T10:00:00.000Z',
    lastSyncedAt: '2026-11-14T10:00:00.000Z',
  },
  supportedCountries: ['ES', 'PT', 'FR', 'DE', 'IT'],
  feeBps: 500,
  settlementCurrency: 'eur',
  priceCurrencies: ['eur'],
};

/** La venta del ensayo: 49 € → 1,79 € de tarjeta, 2,45 € de Didacta, 44,76 € para ella. */
function venta(over: Record<string, unknown>) {
  return {
    id: '7b0c3f6e-1d2a-4c55-9a0e-2f3b4c5d6e7f',
    chargedAt: '2026-11-14T12:05:00.000Z',
    description: 'Torno para principiantes',
    sourceKind: 'ORDER',
    status: 'HELD',
    reason: 'tax_profile_incomplete',
    presentmentAmount: 4900,
    presentmentCurrency: 'eur',
    currency: 'eur',
    gross: 4900,
    stripeFee: 179,
    feeBpsApplied: 500,
    platformFee: 245,
    creatorNet: 4476,
    debtNetted: 0,
    transferAmount: 4476,
    refundedAmount: 0,
    reversedAmount: 0,
    refundState: 'none',
    disputeOpen: false,
    canRefund: true,
    disputeOutcome: null,
    reinstatedAmount: 0,
    transferredAt: null,
    availableOn: '2026-11-21T00:00:00.000Z',
    estimatedArrival: null,
    ...over,
  };
}

function resumen(over: Record<string, unknown>) {
  return {
    currencies: [
      {
        currency: 'eur',
        salesCount: 1,
        gross: 4900,
        stripeFees: 179,
        platformFees: 245,
        received: 0,
        receivedNet: 0,
        pending: 0,
        held: 4476,
        debtNetted: 0,
        debtOutstanding: 0,
        refunded: 0,
        reversed: 0,
        ...over,
      },
    ],
    awaitingFeeCount: 0,
    operatorName: 'Didacta',
    feeBps: 500,
    debts: [],
    disputes: [],
  };
}

/** Datos fiscales sin completar: lo que Stripe ya sabe, sin NIF. */
const FISCALES_FALTAN = {
  status: 'missing',
  required: true,
  profile: null,
  prefill: {
    entityType: 'individual',
    legalName: 'Lucía Ensayo',
    country: 'ES',
    address: { line1: 'Calle del Barro 1', line2: null, postalCode: '28001', city: 'Madrid' },
    birthDate: '1990-01-01',
  },
  missing: ['taxId'],
  heldSales: 1,
};

let stripe: StripeDouble;
test.beforeAll(async () => {
  stripe = await startStripeDouble();
});
test.afterAll(async () => {
  await stripe?.close();
});

async function captura(page: Page, nombre: string): Promise<void> {
  if (!CAPTURAS) return;
  mkdirSync(CAPTURAS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  // Arriba del todo: con la página bajada (el ancla `#tax-profile`) la captura
  // de página completa sale con la cabecera fija en medio.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(CAPTURAS, nombre), fullPage: true });
}

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
  await page.getByLabel(/Nombre de perfil/).fill('Lucía Ensayo');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Tus notificaciones' })).toBeVisible();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Seguir con mi academia' }).click();
  await page.waitForURL(/\/welcome/, { timeout: 30_000 });
  await page.getByLabel('Nombre de la academia').fill('Cerámica con Lucía');
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await page.getByLabel('¿Cómo se llama el curso?').fill('Torno para principiantes');
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await page.getByLabel('Precio').fill('49');
  await page.getByRole('button', { name: 'Crear mi academia' }).click();
  await page.waitForURL(/\/start/, { timeout: 30_000 });
}

/**
 * Aula de Cloud con la cuenta de cobros lista. `fiscales`: si faltan los datos
 * fiscales (como en el ensayo) o están completos (control). `ui`: idioma de la
 * interfaz desde «Empieza aquí» (el alta se hace en español).
 */
async function aulaCloud(
  browser: Browser,
  opts: {
    fiscales: 'faltan' | 'completos';
    ui?: 'es-ES' | 'pt-BR';
    /** Añade de verdad una lección de texto (para poder publicar). */
    leccion?: boolean;
    resumen?: object;
    ventas?: object[];
  },
): Promise<{ ctx: BrowserContext; page: Page; posts: Array<Record<string, unknown>> }> {
  const tenant = await freshTenant(`fiscales${Date.now().toString(36)}`, true);
  const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  const page = await ctx.newPage();
  await creadoraConCurso(page, tenant);
  if (opts.leccion) {
    await page.getByRole('link', { name: 'Añadir mi primera lección' }).click();
    await expect(page.getByTestId('editor-sencillo')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('tipo-TEXT').click();
    await page.getByLabel('Título de la lección').fill('Bienvenida al torno');
    await page.getByLabel('Texto de la lección').fill('Hoy centramos el barro en el torno.');
    await page.getByTestId('guardar-leccion').click();
    await expect(page.getByText('1. Bienvenida al torno')).toBeVisible({ timeout: 20_000 });
  }
  const faltan = opts.fiscales === 'faltan';
  const posts: Array<Record<string, unknown>> = [];

  await page.route('**/api/v1/admin/simple-mode/start-here', async (route) => {
    const bearer = (route.request().headers()['authorization'] ?? '').replace(/^Bearer /, '');
    const view = await apiAs<{
      steps: Array<{ id: string; done: boolean }>;
      paymentsSetupPath: string;
      taxProfilePending?: boolean;
      taxProfilePath?: string;
    }>(tenant.host, '/api/v1/admin/simple-mode/start-here', { bearer });
    // Como lo calcula Cloud: academia, curso y precio hechos; la cuenta de
    // cobros lista y, si faltan los datos fiscales, el paso SIN hacer.
    // Publicar e invitar, los de verdad del aula.
    const done = new Set(['academy', 'course', 'price', ...(faltan ? [] : ['payments'])]);
    view.steps = view.steps.map((s) => ({
      ...s,
      done: done.has(s.id) || ((s.id === 'publish' || s.id === 'invite') && s.done),
    }));
    view.paymentsSetupPath = '/admin/payments';
    view.taxProfilePending = faltan;
    view.taxProfilePath = '/admin/payments#tax-profile';
    await route.fulfill({ json: view });
  });
  await page.route('**/api/v1/modules/payouts/status*', (route) =>
    route.fulfill({ json: STATUS_READY }),
  );
  await page.route('**/api/v1/modules/payouts/summary', (route) =>
    route.fulfill({
      json: opts.resumen ?? (faltan ? resumen({}) : resumen({ held: 0, pending: 4476 })),
    }),
  );
  await page.route('**/api/v1/modules/payouts/sales*', (route) =>
    route.fulfill({
      json: {
        items: opts.ventas ?? [
          faltan
            ? venta({})
            : venta({ status: 'READY', reason: null, estimatedArrival: '2026-11-23' }),
        ],
        page: 1,
        pageSize: 6,
        total: 1,
      },
    }),
  );
  await page.route('**/api/v1/modules/payouts/tax-profile', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: faltan
          ? FISCALES_FALTAN
          : { ...FISCALES_FALTAN, status: 'complete', heldSales: 0, missing: [] },
      });
    }
    const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    posts.push(body);
    // La API valida el NIF con su letra de control: «123456789» no lo es.
    return route.fulfill({
      status: 422,
      json: {
        statusCode: 422,
        code: 'PAYOUTS_TAX_PROFILE_INVALID',
        message: 'Datos fiscales no válidos',
        detail: 'taxId:format',
      },
    });
  });
  if (opts.ui && opts.ui !== 'es-ES') {
    // El idioma de su perfil (lo sincroniza la web con la cookie al entrar).
    sql(`UPDATE "user" SET locale = '${opts.ui}' WHERE email = '${tenant.creatorEmail}'`);
    await ctx.addCookies([{ name: 'didacta_locale', value: opts.ui, url: tenant.base }]);
  }
  await page.goto(`${tenant.base}/start`);
  await expect(page.getByTestId('empieza-aqui')).toBeVisible({ timeout: 20_000 });
  return { ctx, page, posts };
}

test('ensayo general: sin datos fiscales «Conecta tus cobros» sigue pendiente y lleva a completarlos; «Ventas» lo avisa', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { ctx, page, posts } = await aulaCloud(browser, { fiscales: 'faltan', leccion: true });

  // ── «Empieza aquí» ──────────────────────────────────────────────────────
  const paso = page.locator('[data-step="payments"]');
  await expect(paso).not.toHaveAttribute('data-done', '1');
  await expect(paso.getByTestId('cobros-pendiente-fiscales')).toHaveText('Falta: datos fiscales');
  await expect(paso).toContainText(
    'Tu cuenta de cobros ya está conectada. Te falta un paso: tus datos fiscales (tu NIF y tu dirección). Sin ellos, el dinero de tus ventas se queda retenido y no te llega.',
  );
  await expect(page.getByText('Listo para cobrar')).toHaveCount(0);
  await expect(paso.getByTestId('completar-fiscales')).toHaveText('Completar mis datos fiscales');

  // ── Publicar NO espera a los datos fiscales (web #39), pero lo avisa ─────
  await expect(page.locator('[data-step="publish"]')).toHaveAttribute('aria-current', 'step');
  await expect(page.getByTestId('publicar')).toBeEnabled();
  await expect(page.getByTestId('publicar-aviso-retenido')).toHaveText(
    'Puedes publicar ya: tus alumnos podrán comprar, pero el dinero de tus ventas se quedará retenido hasta que completes tus datos fiscales.',
  );
  await captura(page, 'despues-empieza-aqui-faltan-fiscales.png');
  await page.getByTestId('publicar').click();
  await expect(page.getByTestId('copiar-enlace')).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator('[data-step="publish"][data-done="1"]')).toBeVisible();
  await expect(page.getByTestId('enlace-aviso-retenido')).toContainText(
    'Ya está a la venta, pero el dinero de tus ventas se queda retenido hasta que completes tus datos fiscales.',
  );
  // El paso de cobros sigue marcado, con su botón.
  await expect(paso.getByTestId('cobros-pendiente-fiscales')).toBeVisible();
  await captura(page, 'despues-empieza-aqui-publicado-sin-fiscales.png');

  // ── El botón lleva DIRECTO al formulario, en «Ventas» ───────────────────
  await paso.getByTestId('completar-fiscales').click();
  await page.waitForURL(/\/admin\/payments#tax-profile$/, { timeout: 20_000 });
  const aviso = page.getByTestId('ventas-faltan-fiscales');
  await expect(aviso).toBeVisible({ timeout: 20_000 });
  await expect(aviso.getByRole('heading', { level: 2 })).toHaveText(
    'Falta un paso para que te llegue el dinero: tus datos fiscales.',
  );
  await expect(aviso.getByRole('status').first()).toHaveText(
    /^Tienes 1 venta retenida \(44,76\s€\) porque faltan tus datos fiscales\. El dinero está a salvo: te lo enviamos en cuanto los completes aquí abajo\.$/,
  );
  // Ya no promete que el dinero llega al banco.
  await expect(
    page.getByText('Cobros conectados: el dinero de cada venta llega a tu banco.'),
  ).toHaveCount(0);
  // Lo retenido no está «en camino» ni «llega en los próximos días».
  const cifras = page.getByTestId('ventas-resumen');
  await expect(page.getByTestId('ventas-retenido')).toContainText('Retenido');
  await expect(page.getByTestId('ventas-retenido')).toContainText(/44,76\s€/);
  await expect(page.getByTestId('ventas-retenido')).toContainText(
    'Hasta que completes tus datos fiscales',
  );
  await expect(cifras).not.toContainText('En camino');
  await expect(cifras).not.toContainText('Llega en los próximos días');
  // El formulario está ahí mismo, a la vista.
  const tarjeta = page.getByTestId('payouts-tax-profile');
  await expect(tarjeta).toBeInViewport();
  await captura(page, 'despues-ventas-faltan-fiscales.png');

  // ── Un NIF mal escrito: el motivo concreto ─────────────────────────────
  await tarjeta.getByLabel('NIF', { exact: true }).fill('123456789');
  await tarjeta.getByRole('button', { name: 'Guardar datos fiscales' }).click();
  await expect(tarjeta.getByRole('alert').last()).toHaveText(
    'El NIF no es válido. Revisa el formato.',
  );
  await expect(tarjeta).not.toContainText('hay campos que faltan o no son válidos');
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ taxId: '123456789', country: 'ES' });
  await captura(page, 'despues-nif-no-valido.png');
  await ctx.close();
});

test('control: con los datos fiscales completos, el paso está hecho y «Ventas» dice que el dinero llega', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { ctx, page } = await aulaCloud(browser, { fiscales: 'completos' });
  await expect(page.locator('[data-step="payments"][data-done="1"]')).toContainText(
    'Listo para cobrar',
  );
  await expect(page.getByTestId('cobros-pendiente-fiscales')).toHaveCount(0);
  await page.goto(page.url().replace(/\/start.*$/, '/admin/payments'));
  await expect(page.getByTestId('ventas-sencillo')).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText('Cobros conectados: el dinero de cada venta llega a tu banco.'),
  ).toBeVisible();
  await expect(page.getByTestId('ventas-faltan-fiscales')).toHaveCount(0);
  await expect(page.getByTestId('ventas-retenido')).toHaveCount(0);
  await expect(page.getByTestId('ventas-resumen')).toContainText('Llega en los próximos días');
  await ctx.close();
});

test('pt-BR: o mesmo aviso em português, sem espanhol, e o NIF inválido com o motivo', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { ctx, page } = await aulaCloud(browser, { fiscales: 'faltan', ui: 'pt-BR' });
  const paso = page.locator('[data-step="payments"]');
  await expect(paso.getByTestId('cobros-pendiente-fiscales')).toHaveText('Falta: dados fiscais');
  await expect(paso.getByTestId('completar-fiscales')).toHaveText('Completar meus dados fiscais');
  await expect(page.getByTestId('publicar-aviso-retenido')).toHaveText(
    'Você já pode publicar: seus alunos poderão comprar, mas o dinheiro das suas vendas ficará retido até você completar seus dados fiscais.',
  );
  await captura(page, 'despues-comece-aqui-pt-br.png');
  await paso.getByTestId('completar-fiscales').click();
  const aviso = page.getByTestId('ventas-faltan-fiscales');
  await expect(aviso.getByRole('heading', { level: 2 })).toHaveText(
    'Falta um passo para o dinheiro chegar até você: seus dados fiscais.',
  );
  await expect(aviso.getByRole('status').first()).toContainText('Você tem 1 venda retida');
  await expect(page.getByTestId('ventas-retenido')).toContainText('Retido');
  const tarjeta = page.getByTestId('payouts-tax-profile');
  await tarjeta.getByLabel('NIF', { exact: true }).fill('123456789');
  await tarjeta.getByRole('button', { name: 'Salvar dados fiscais' }).click();
  await expect(tarjeta.getByRole('alert').last()).toHaveText(
    'O NIF não é válido. Confira o formato.',
  );
  const texto = await page.getByTestId('ventas-sencillo').innerText();
  for (const es of ['venta retenida', 'Retenido', 'datos fiscales', 'no es válido', 'En camino']) {
    expect(texto, es).not.toContain(es);
  }
  await captura(page, 'despues-ventas-pt-br.png');
  await ctx.close();
});

test('tras devolver una venta entera: «Recibido» no sigue diciendo 44,76 € ni la venta «llega hacia el 23 nov»', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  // Lo que había tras el reembolso del ensayo: enviada, devuelta entera y
  // retirada de su saldo. (Una API anterior aún mandaba la fecha estimada.)
  const { ctx, page } = await aulaCloud(browser, {
    fiscales: 'completos',
    resumen: resumen({
      received: 4476,
      receivedNet: 0,
      held: 0,
      refunded: 4900,
      reversed: 4476,
      debtOutstanding: 179,
    }),
    ventas: [
      venta({
        status: 'TRANSFERRED',
        reason: null,
        transferredAt: '2026-11-14T12:08:00.000Z',
        refundedAmount: 4900,
        reversedAmount: 4476,
        refundState: 'full',
        canRefund: false,
        estimatedArrival: '2026-11-23',
      }),
    ],
  });
  await page.goto(page.url().replace(/\/start.*$/, '/admin/payments'));
  await expect(page.getByTestId('ventas-resumen')).toBeVisible({ timeout: 20_000 });
  // «Ya en tu banco» del modo sencillo: lo que de verdad le queda.
  await expect(page.getByTestId('ventas-resumen')).toContainText(/Ya en tu banco\s*0,00\s€/);

  await page.goto(page.url().replace(/\/admin\/payments.*$/, '/admin/payments?full=1'));
  const resumenCard = page.getByTestId('payouts-summary');
  await expect(resumenCard).toBeVisible({ timeout: 20_000 });
  await expect(resumenCard.locator('dl > div').filter({ hasText: 'Recibido' })).toContainText(
    /0,00\s€/,
  );
  await expect(resumenCard).not.toContainText(/Recibido\s*44,76/);
  const fila = page.getByTestId('payouts-sales-table').locator('tbody tr').first();
  await expect(fila).toContainText('Reembolsada');
  await expect(fila).not.toContainText('hacia el');
  await captura(page, 'despues-ventas-tras-reembolso.png');
  await ctx.close();
});
