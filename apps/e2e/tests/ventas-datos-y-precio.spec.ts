/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';
import { startStripeDouble, type StripeDouble } from '../helpers/stripe-double';

/**
 * Lo que pidió Valentín tras la primera venta real:
 *
 *  (3) «En el panel del creador solo ve que ha vendido pero no ve el nombre,
 *      email… Debería también poder exportar esos datos.»
 *  (4) «He tenido que buscar el precio. ¿Por qué no lo ponemos dentro del
 *      propio curso?»
 *  Y lo que se vio en esa venta: se publicó a un precio que nadie volvió a
 *  mirar, no se veía cuánto llega de cada venta y «Ventas» no se actualizaba
 *  sola.
 *
 * De punta a punta en un aula NUEVA en modo sencillo («Primer Sorbo»), con las
 * claves de pruebas de la instancia contra el doble de Stripe:
 *
 *  1. El precio del alta queda «por confirmar»; publicar enseña el precio y
 *     lo que llega, y publica A ESE precio.
 *  2. El precio se cambia DENTRO del curso («Precio y venta») y es el mismo
 *     que el de «Empieza aquí» y el de la página de venta.
 *  3. Una persona sin cuenta compra (webhook firmado como Stripe) y la venta
 *     aparece en «Ventas» SIN recargar, con nombre, correo, país y estado.
 *  4. El detalle de la venta: recibo, escribir al comprador y ver su ficha.
 *  5. Exportar a CSV (y Excel): el fichero de verdad, con BOM, cabeceras en
 *     español y la venta; y queda en la auditoría.
 *  6. Un alumno no puede leer las ventas (403).
 *
 * `E2E_CAPTURAS=<carpeta>` guarda capturas de cada pantalla.
 */

const CAPTURAS = process.env.E2E_CAPTURAS;
const WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET ?? process.env.E2E_WEBHOOK_SECRET ?? 'whsec_e2e_local_secret';
const API_PORT = Number(process.env.API_PORT ?? 4000);

let stripe: StripeDouble;
test.beforeAll(async () => {
  stripe = await startStripeDouble();
});
test.afterAll(async () => {
  await stripe?.close();
});

async function captura(page: Page, nombre: string, fullPage = true): Promise<void> {
  if (!CAPTURAS) return;
  mkdirSync(CAPTURAS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(CAPTURAS, nombre), fullPage });
}

/** Webhook de billing firmado como Stripe, al dominio del aula. */
function sendBillingWebhook(host: string, event: Record<string, unknown>): Promise<number> {
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: API_PORT,
        path: '/api/v1/modules/billing/webhook',
        method: 'POST',
        headers: {
          Host: host,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'stripe-signature': `t=${ts},v1=${v1}`,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** Status de una petición a la API (sin lanzar con 4xx). */
function statusOf(host: string, p: string, bearer: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: API_PORT,
        path: p,
        headers: { Host: host, authorization: `Bearer ${bearer}` },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function signinPage(page: Page, email: string, password: string) {
  await page.goto('/signin');
  await page.locator('input[autocomplete="email"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
}

async function contexto(browser: Browser, tenant: FreshTenant) {
  const ctx = await browser.newContext({
    locale: 'es-ES',
    viewport: { width: 1440, height: 900 },
    baseURL: tenant.base,
    acceptDownloads: true,
  });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  return ctx;
}

test('Ventas con los datos del comprador, exportación y el precio dentro del curso', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const tenant = await freshTenant(`primersorbo${Date.now().toString(36)}`, true);
  const operador = `operador@${tenant.slug}.test`;
  const { tokens } = await apiAs<{ tokens: { accessToken: string } }>(
    tenant.host,
    '/api/v1/auth/signin',
    {
      method: 'POST',
      body: { tenantSlug: tenant.slug, email: operador, password: tenant.password },
    },
  );
  const bearer = tokens.accessToken;
  sql(`UPDATE "user" SET name = 'Marta Primer Sorbo' WHERE email = '${operador}'`);

  // Alta en 3 preguntas (por la API: la UI del alta la recorre `modo-sencillo-de-cero`).
  const alta = await apiAs<{ offer: { courseId: string } }>(
    tenant.host,
    '/api/v1/admin/simple-mode/quick-start',
    {
      method: 'POST',
      bearer,
      body: {
        academyName: 'Primer Sorbo',
        offer: 'course',
        title: 'Espresso en casa',
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
      title: 'Tu primer espresso',
      type: 'TEXT',
      orderIndex: 0,
      content: { text: 'Molienda fina, 18 gramos y 25 segundos.' },
      durationSec: 60,
    },
  });

  const ctx = await contexto(browser, tenant);
  const page = await ctx.newPage();
  await signinPage(page, operador, tenant.password);

  // ── 1. El precio del alta, por confirmar; publicar lo enseña ───────────
  await page.goto('/start');
  await expect(page.getByTestId('empieza-aqui')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('precio-por-confirmar')).toHaveText(/29\s€ · por confirmar/);
  await expect(page.locator('[data-step="price"]')).not.toHaveAttribute('data-done', '1');
  const panel = page.getByTestId('publicar-precio');
  await expect(panel).toContainText(/Vas a publicar «Espresso en casa» a 29\s€\./);
  // Con claves propias no hay comisión de Didacta: solo la de la tarjeta, aproximada.
  // 29 € − tarjeta (1,5 % = 0,44 € + 0,25 €) = 28,31 €.
  await expect(panel.getByTestId('te-llega')).toContainText(/Con 29\s€ te llegan ~28,31\s€/);
  await expect(panel.getByTestId('te-llega')).toContainText('Aproximado');
  await expect(page.getByTestId('publicar')).toHaveText(/Publicar a 29\s€/);
  await captura(page, '01-empieza-aqui-precio-por-confirmar.png');

  // ── 2. El precio, dentro del curso: el mismo que «Empieza aquí» ────────
  await page.goto(`/studio/courses/${courseId}`);
  const bloque = page.getByTestId('precio-venta-curso');
  await expect(bloque).toBeVisible({ timeout: 30_000 });
  await expect(bloque.getByTestId('precio-venta-importe')).toContainText(/29\s€/);
  await expect(bloque.getByTestId('precio-venta-estado')).toHaveText('Sin publicar');
  await expect(bloque).toContainText('Es el mismo precio que en Empieza aquí');
  await bloque.getByTestId('precio-venta-cambiar').click();
  const editor = bloque.getByTestId('precio-venta-editor');
  await editor.getByLabel('Precio', { exact: true }).fill('34,90');
  await expect(editor.getByTestId('te-llega')).toContainText(/Con 34,90\s€ te llegan ~34,13\s€/);
  await captura(page, '02-editor-curso-precio-editando.png');
  await editor.getByRole('button', { name: 'Guardar precio' }).click();
  await expect(bloque.getByText('Precio guardado')).toBeVisible();
  await expect(bloque.getByTestId('precio-venta-importe')).toContainText(/34,90\s€/);

  // «Empieza aquí» ve el mismo precio, ya confirmado, y publica A ÉL.
  await page.goto('/start');
  await expect(page.locator('[data-step="price"][data-done="1"]')).toContainText(/34,90\s€/);
  await expect(page.getByTestId('precio-por-confirmar')).toHaveCount(0);
  await expect(page.getByTestId('publicar')).toHaveText(/Publicar a 34,90\s€/);
  await page.getByTestId('publicar').click();
  await expect(page.getByTestId('copiar-enlace')).toBeEnabled({ timeout: 30_000 });
  expect(
    stripe.calls.some(
      (c) => c.path === '/v1/prices' && c.body.unit_amount === '3490' && c.body.currency === 'eur',
    ),
  ).toBe(true);

  // Ya a la venta: se cambia desde el curso y lo ve quien compra.
  await page.goto(`/studio/courses/${courseId}`);
  await expect(bloque.getByTestId('precio-venta-estado')).toHaveText('A la venta', {
    timeout: 30_000,
  });
  await expect(bloque.getByTestId('precio-venta-enlace')).toContainText(`${tenant.host}`);
  await expect(bloque.getByTestId('precio-venta-enlace')).toContainText(
    '/catalog/espresso-en-casa',
  );
  await bloque.getByTestId('precio-venta-cambiar').click();
  await bloque.getByTestId('precio-venta-editor').getByLabel('Precio', { exact: true }).fill('39');
  await bloque.getByRole('button', { name: 'Guardar precio' }).click();
  await expect(bloque.getByTestId('precio-venta-importe')).toContainText(/39\s€/);
  await captura(page, '03-editor-curso-precio-y-venta.png');
  expect(stripe.calls.some((c) => c.path === '/v1/prices' && c.body.unit_amount === '3900')).toBe(
    true,
  );

  // ── «Ventas» abierta ANTES de la compra (para ver que se actualiza sola) ─
  await page.goto('/admin/membership');
  await expect(page.getByTestId('ventas-sencillo')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('ventas-propias-cuenta')).toHaveText('0');
  // Sin ventas no se pinta la lista (ya lo dice la tarjeta de arriba).
  const ventas = page.getByTestId('ventas-datos');
  await expect(ventas).toHaveCount(0);

  // ── 3. Una persona sin cuenta compra en la página de venta ─────────────
  const visitaCtx = await browser.newContext({ locale: 'es-ES', baseURL: tenant.base });
  const visita = await visitaCtx.newPage();
  await visita.goto('/catalog/espresso-en-casa');
  await expect(visita.getByRole('heading', { name: 'Espresso en casa' })).toBeVisible({
    timeout: 30_000,
  });
  // El precio que puso la creadora en el curso, en la ficha de venta.
  await expect(visita.getByText(/39\s€/).first()).toBeVisible();
  await visita.getByRole('checkbox').check();
  await visita.getByRole('button', { name: 'Comprar ahora' }).click();
  await visita.waitForURL(/127\.0\.0\.1:\d+\/pagar\//, { timeout: 30_000 });
  const sesion = stripe.calls
    .filter((c) => c.method === 'POST' && c.path === '/v1/checkout/sessions')
    .at(-1)!;
  const metadata = Object.fromEntries(
    Object.entries(sesion.body)
      .filter(([k]) => k.startsWith('metadata['))
      .map(([k, v]) => [k.slice('metadata['.length, -1), v]),
  );
  const sessionId = decodeURIComponent(new URL(visita.url()).pathname.split('/').pop()!);
  const compradora = `lucia.compradora+${tenant.slug}@example.com`;
  const status = await sendBillingWebhook(tenant.host, {
    id: `evt_${sessionId}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        payment_status: 'paid',
        status: 'complete',
        metadata,
        customer_email: null,
        customer_details: {
          email: compradora,
          name: 'Lucía Compradora',
          address: { country: 'PT' },
        },
        amount_total: 3900,
        total_details: { amount_discount: 0 },
        currency: 'eur',
        payment_intent: `pi_${sessionId}`,
      },
    },
  });
  expect(status, 'webhook checkout.session.completed').toBe(200);
  await visitaCtx.close();

  // La venta aparece SIN recargar: al volver a la pestaña se vuelve a pedir.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const fila = ventas.getByTestId('venta-fila').first();
  await expect(fila).toBeVisible({ timeout: 30_000 });
  await expect(fila.getByTestId('venta-comprador')).toHaveText('Lucía Compradora');
  await expect(fila.getByTestId('venta-correo')).toHaveText(compradora);
  await expect(fila).toContainText('Portugal');
  await expect(fila).toContainText('Espresso en casa');
  await expect(fila).toContainText(/39,00\s€/);
  await expect(fila.getByTestId('venta-estado')).toHaveText('Pagada');
  await expect(ventas.getByTestId('ventas-total')).toContainText(/1 venta · 39,00\s€/);
  // Y la cuenta de arriba también, sin recargar.
  await expect(page.getByTestId('ventas-propias-cuenta')).toHaveText('1');
  await captura(page, '04-ventas-con-datos-del-comprador.png');

  // Filtros: por estado (ninguna devuelta) y por nombre.
  await ventas.getByTestId('ventas-estado').selectOption('refunded');
  await expect(ventas).toContainText('Ninguna venta con estos filtros.');
  await ventas.getByTestId('ventas-estado').selectOption('');
  await ventas.getByTestId('ventas-buscar').fill('lucía');
  await expect(ventas.getByTestId('venta-fila')).toHaveCount(1);
  await ventas.getByTestId('ventas-buscar').fill('nadie-se-llama-asi');
  await expect(ventas).toContainText('Ninguna venta con estos filtros.');
  await ventas.getByTestId('ventas-buscar').fill('');
  await expect(ventas.getByTestId('venta-fila')).toHaveCount(1);

  // ── 4. El detalle de la venta ─────────────────────────────────────────
  await fila.getByTestId('venta-comprador').click();
  const detalle = page.getByTestId('venta-detalle');
  await expect(detalle.getByTestId('detalle-nombre')).toHaveText('Lucía Compradora');
  await expect(detalle.getByTestId('detalle-correo')).toHaveText(compradora);
  await expect(detalle).toContainText('País: Portugal');
  await expect(detalle.getByTestId('detalle-recibo')).toContainText(/Pagó\s*39,00\s€/);
  await expect(detalle.getByTestId('detalle-escribir')).toHaveAttribute(
    'href',
    /^mailto:lucia\.compradora%2B.*@example\.com\?subject=Tu%20compra%20de%20Espresso%20en%20casa$/,
  );
  const buyerId = sql(`SELECT id FROM "user" WHERE email = '${compradora}'`);
  await expect(detalle.getByTestId('detalle-ver-alumno')).toHaveAttribute('href', `/u/${buyerId}`);
  // Cobrada con la cuenta propia del aula: se reembolsa desde su Stripe.
  await expect(detalle).toContainText('para devolverla, hazlo desde tu panel de Stripe');
  await captura(page, '05-detalle-de-la-venta.png', false);
  await page.keyboard.press('Escape');

  // ── 5. Exportar: el fichero de verdad ──────────────────────────────────
  await ventas.getByTestId('ventas-exportar').locator('summary').click();
  await captura(page, '06-exportar.png', false);
  const [descarga] = await Promise.all([
    page.waitForEvent('download'),
    ventas.getByTestId('exportar-csv').click(),
  ]);
  expect(descarga.suggestedFilename()).toMatch(/^ventas-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await descarga.path())!);
  expect([...csv.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const lineas = csv.toString('utf8').slice(1).trimEnd().split('\r\n');
  expect(lineas).toHaveLength(2);
  const cab = lineas[0]!.split(';');
  const val = lineas[1]!.split(';');
  const col = (n: string) => val[cab.indexOf(n)];
  expect(cab).toContain('Fecha (ISO 8601, UTC)');
  expect(col('Nombre')).toBe('Lucía Compradora');
  expect(col('Correo')).toBe(compradora);
  expect(col('País')).toBe('PT');
  expect(col('Producto')).toBe('Espresso en casa');
  expect(col('Importe pagado')).toBe('39,00');
  expect(col('Moneda')).toBe('EUR');
  expect(col('Estado')).toBe('Pagada');
  expect(col('Fecha (ISO 8601, UTC)')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  if (CAPTURAS) {
    // El CSV tal cual se descargó, junto a las capturas.
    mkdirSync(CAPTURAS, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(CAPTURAS, '07-ventas-exportadas.csv'), csv);
  }
  // Excel también (un .xlsx es un zip: empieza por «PK»).
  await ventas.getByTestId('ventas-exportar').locator('summary').click();
  const [xlsx] = await Promise.all([
    page.waitForEvent('download'),
    ventas.getByTestId('exportar-xlsx').click(),
  ]);
  expect(xlsx.suggestedFilename()).toMatch(/\.xlsx$/);
  expect(
    readFileSync((await xlsx.path())!)
      .subarray(0, 2)
      .toString(),
  ).toBe('PK');
  // Quién exportó, con qué y cuántas filas: en la auditoría (datos personales).
  const auditado = sql(
    `SELECT (a.metadata->>'format') || '|' || (a.metadata->>'rows') FROM audit_log a ` +
      `JOIN tenant t ON t.id = a.tenant_id WHERE t.slug = '${tenant.slug}' ` +
      `AND a.action = 'sales.exported' ORDER BY a.id`,
  );
  expect(auditado.split('\n')).toEqual(['csv|1', 'xlsx|1']);

  // ── 6. Un alumno no lee las ventas de nadie ────────────────────────────
  const alumna = `alumna@${tenant.slug}.test`;
  await apiAs(tenant.host, '/api/v1/admin/users', {
    method: 'POST',
    bearer,
    body: { email: alumna, role: 'alumno' },
  });
  sql(
    `UPDATE "user" SET password_hash = (SELECT password_hash FROM "user" WHERE email = '${operador}') ` +
      `WHERE email = '${alumna}'`,
  );
  const deAlumna = await apiAs<{ tokens: { accessToken: string } }>(
    tenant.host,
    '/api/v1/auth/signin',
    { method: 'POST', body: { tenantSlug: tenant.slug, email: alumna, password: tenant.password } },
  );
  expect(await statusOf(tenant.host, '/api/v1/admin/sales', deAlumna.tokens.accessToken)).toBe(403);
  expect(
    await statusOf(tenant.host, '/api/v1/admin/sales/export', deAlumna.tokens.accessToken),
  ).toBe(403);
  // Control: quien administra, sí.
  expect(await statusOf(tenant.host, '/api/v1/admin/sales', bearer)).toBe(200);

  await ctx.close();
});

/**
 * Cobros de PLATAFORMA (Didacta Cloud): las columnas del reparto (tarjeta,
 * comisión de Didacta, lo que llega) y el recibo de cada venta. El arnés no
 * arranca la API en modo plataforma: las respuestas de `/modules/payouts/*` y
 * de `/admin/sales` son las que da Cloud (como en `cobros-datos-fiscales-y-
 * ventas`). Lo que calcula la API lo fijan `sales-ledger.integration.test.ts`
 * (Postgres real como `didacta_app`) y `reports.service.test.ts`.
 */
test('modo plataforma: comisiones, neto, estados y recibo de cada venta', async ({ browser }) => {
  test.setTimeout(180_000);
  const tenant = await freshTenant(`sorbocloud${Date.now().toString(36)}`, true);
  const operador = `operador@${tenant.slug}.test`;
  const { tokens } = await apiAs<{ tokens: { accessToken: string } }>(
    tenant.host,
    '/api/v1/auth/signin',
    {
      method: 'POST',
      body: { tenantSlug: tenant.slug, email: operador, password: tenant.password },
    },
  );
  await apiAs(tenant.host, '/api/v1/admin/simple-mode/quick-start', {
    method: 'POST',
    bearer: tokens.accessToken,
    body: {
      academyName: 'Primer Sorbo',
      offer: 'course',
      title: 'Espresso en casa',
      amountCents: 3900,
      currency: 'eur',
      locale: 'es',
    },
  });
  const ctx = await contexto(browser, tenant);
  const page = await ctx.newPage();

  const reparto = (over: Record<string, unknown> = {}) => ({
    currency: 'eur',
    gross: 3900,
    cardFee: 84,
    platformFee: 195,
    net: 3621,
    debtNetted: 0,
    refunded: 0,
    ...over,
  });
  const fila = (
    n: number,
    nombre: string,
    correo: string,
    pais: string,
    over: Record<string, unknown> = {},
  ) => ({
    id: `order:7b0c3f6e-1d2a-4c55-9a0e-2f3b4c5d6e7${n}`,
    kind: 'order',
    at: `2026-11-1${n}T10:15:00.000Z`,
    buyer: {
      userId: null,
      name: nombre,
      email: correo,
      checkoutEmail: null,
      country: pais,
      deleted: false,
    },
    product: {
      kind: 'course',
      ref: 'course:7b0c3f6e-1d2a-4c55-9a0e-2f3b4c5d6e70',
      title: 'Espresso en casa',
      option: null,
      intervalMonths: null,
    },
    amount: 3900,
    currency: 'eur',
    coupon: null,
    referralCredit: null,
    referral: null,
    settlement: reparto(),
    status: 'transferred',
    refundState: 'none',
    payoutSaleId: null,
    ...over,
  });
  const items = [
    fila(4, 'Lucía Compradora', 'lucia@example.com', 'PT', {
      status: 'paid',
      referral: {
        referrerUserId: 'r1',
        referrerName: 'Pablo Alumno',
        code: 'pablo',
        commission: 1170,
        commissionCurrency: 'eur',
        commissionStatus: 'PENDING',
      },
    }),
    fila(3, 'Jorge Barista', 'jorge@example.com', 'ES', { status: 'held' }),
    fila(2, 'Emma Taylor', 'emma@example.com', 'GB', {
      status: 'refunded',
      refundState: 'full',
      settlement: reparto({ net: 0, refunded: 3900 }),
    }),
    fila(1, 'Ana Torres', 'ana@example.com', 'FR'),
  ];
  await page.route('**/api/v1/admin/sales?*', (route) =>
    route.fulfill({
      json: {
        items,
        page: 1,
        pageSize: 25,
        total: items.length,
        totals: [{ currency: 'eur', count: 4, amount: 15600 }],
        products: [
          {
            ref: 'course:7b0c3f6e-1d2a-4c55-9a0e-2f3b4c5d6e70',
            kind: 'course',
            title: 'Espresso en casa',
          },
        ],
        platform: { operatorName: 'Didacta', feeBps: 500 },
      },
    }),
  );
  await page.route('**/api/v1/admin/sales/order*', (route) =>
    route.fulfill({
      json: {
        sale: items[0],
        // La venta como la da «Tus ventas» (`mod.payouts`): se puede reembolsar.
        payout: {
          id: 'p-lucia',
          chargedAt: '2026-11-14T10:15:00.000Z',
          description: 'Espresso en casa',
          sourceKind: 'ORDER',
          status: 'READY',
          reason: null,
          presentmentAmount: 3900,
          presentmentCurrency: 'eur',
          currency: 'eur',
          gross: 3900,
          stripeFee: 84,
          feeBpsApplied: 500,
          platformFee: 195,
          creatorNet: 3621,
          debtNetted: 0,
          transferAmount: 3621,
          refundedAmount: 0,
          reversedAmount: 0,
          refundState: 'none',
          disputeOpen: false,
          canRefund: true,
          disputeOutcome: null,
          reinstatedAmount: 0,
          transferredAt: null,
          availableOn: '2026-11-21T00:00:00.000Z',
          estimatedArrival: '2026-11-23',
        },
        events: [{ type: 'paid', at: '2026-11-14T10:15:00.000Z', amount: 3900, currency: 'eur' }],
        hostedInvoiceUrl: null,
        period: null,
        platform: { operatorName: 'Didacta', feeBps: 500 },
      },
    }),
  );
  await page.route('**/api/v1/modules/payouts/status*', (route) =>
    route.fulfill({
      json: {
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
          readyAt: '2026-11-10T10:00:00.000Z',
          lastSyncedAt: '2026-11-14T10:00:00.000Z',
        },
        supportedCountries: ['ES'],
        feeBps: 500,
        settlementCurrency: 'eur',
        priceCurrencies: ['eur'],
      },
    }),
  );
  await page.route('**/api/v1/modules/payouts/summary', (route) =>
    route.fulfill({
      json: {
        currencies: [
          {
            currency: 'eur',
            salesCount: 4,
            gross: 15600,
            stripeFees: 336,
            platformFees: 780,
            received: 7242,
            receivedNet: 7242,
            pending: 3621,
            held: 3621,
            debtNetted: 0,
            debtOutstanding: 0,
            refunded: 3900,
            reversed: 0,
          },
        ],
        awaitingFeeCount: 0,
        operatorName: 'Didacta',
        feeBps: 500,
        debts: [],
        disputes: [],
      },
    }),
  );
  await page.route('**/api/v1/modules/payouts/tax-profile', (route) =>
    route.fulfill({
      json: {
        status: 'complete',
        required: true,
        profile: null,
        prefill: null,
        missing: [],
        heldSales: 0,
      },
    }),
  );

  await signinPage(page, operador, tenant.password);
  await page.goto('/admin/payments');
  const ventas = page.getByTestId('ventas-datos');
  await expect(ventas).toBeVisible({ timeout: 30_000 });
  const filas = ventas.getByTestId('venta-fila');
  await expect(filas).toHaveCount(4);
  await expect(filas.nth(0)).toContainText('Lucía Compradora');
  await expect(filas.nth(0)).toContainText(/36,21\s€/);
  await expect(filas.nth(0)).toContainText(/Tarjeta 0,84\s€ · Didacta 1,95\s€/);
  await expect(filas.nth(0)).toContainText('Traída por Pablo Alumno');
  await expect(filas.nth(1).getByTestId('venta-estado')).toHaveText('Retenida');
  await expect(filas.nth(2).getByTestId('venta-estado')).toHaveText('Reembolsada');
  await expect(filas.nth(3).getByTestId('venta-estado')).toHaveText('Transferida');
  await captura(page, '08-ventas-modo-plataforma.png');
  await filas.nth(0).getByTestId('venta-comprador').click();
  const recibo = page.getByTestId('detalle-recibo');
  await expect(recibo).toContainText(/Comisión de la tarjeta\s*−0,84\s€/);
  await expect(recibo).toContainText(/Comisión de Didacta \(5\s?%\)\s*−1,95\s€/);
  await expect(recibo.getByTestId('detalle-neto')).toHaveText(/36,21\s€/);
  await expect(page.getByTestId('detalle-referido')).toContainText('Traída por Pablo Alumno');
  // Cobrada por la plataforma: se reembolsa desde aquí, no «desde tu Stripe».
  await expect(page.getByTestId('detalle-reembolsar')).toBeVisible();
  await expect(page.getByTestId('venta-detalle')).not.toContainText('panel de Stripe');
  await captura(page, '09-detalle-con-reparto.png', false);
  await ctx.close();
});
