/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHmac } from 'node:crypto';
import http from 'node:http';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { mailsTo, smtpForMailpit, waitForMail } from '../helpers/mailpit';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';
import { startStripeDouble, type StripeDouble } from '../helpers/stripe-double';

/**
 * CORREOS DE VENTA con aspecto de recibo, de punta a punta en un aula nueva
 * del modo sencillo («Primer Sorbo»), con el correo de verdad en el buzón de
 * pruebas (Mailpit) y Stripe en el doble del arnés:
 *
 *  1. Alguien sin cuenta compra el curso. Le llega UN correo (no recibo +
 *     bienvenida): el recibo, con el pedido, el importe, la tarjeta, quién vende,
 *     la renuncia al desistimiento y el botón para elegir contraseña, que le
 *     lleva a SU curso.
 *  2. La creadora abre Ajustes → «Correos», cambia el asunto y el mensaje con
 *     los datos de la compra, lo ve en la vista previa (ordenador y móvil), lo
 *     guarda y se manda una prueba: le llega.
 *  3. La siguiente compra sale con su texto… y con el recibo entero debajo.
 *  4. «Volver al original» lo deja como estaba.
 */

const WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET ?? process.env.E2E_WEBHOOK_SECRET ?? 'whsec_e2e_local_secret';
const API_PORT = Number(process.env.API_PORT ?? 4000);
const COURSE = 'Iniciación al café de especialidad';

let stripe: StripeDouble;
test.beforeAll(async () => {
  stripe = await startStripeDouble();
});
test.afterAll(async () => {
  await stripe?.close();
});

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

/** Referencia corta del pedido (la misma regla que el recibo). */
function orderRef(id: string): string {
  return id
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-8)
    .toUpperCase();
}

async function context(browser: Browser, tenant: FreshTenant) {
  const ctx = await browser.newContext({
    locale: 'es-ES',
    viewport: { width: 1280, height: 900 },
    baseURL: tenant.base,
  });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  return ctx;
}

/** Una persona sin cuenta compra el curso: casilla, «Comprar ahora» y Stripe confirma. */
async function comprar(
  page: Page,
  tenant: FreshTenant,
  salePath: string,
  buyer: { email: string; name: string },
): Promise<{ sessionId: string; orderId: string }> {
  await page.goto(salePath);
  await expect(page.getByRole('heading', { name: COURSE })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Comprar ahora' }).click();
  await page.waitForURL(/127\.0\.0\.1:\d+\/pagar\//, { timeout: 30_000 });
  const sessionId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
  const call = stripe.calls
    .filter((c) => c.method === 'POST' && c.path === '/v1/checkout/sessions')
    .at(-1)!;
  const metadata = Object.fromEntries(
    Object.entries(call.body)
      .filter(([k]) => k.startsWith('metadata['))
      .map(([k, v]) => [k.slice('metadata['.length, -1), v]),
  );
  const status = await sendBillingWebhook(tenant.host, {
    id: `evt_${sessionId}`,
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'paid',
        status: 'complete',
        metadata,
        customer_email: null,
        customer_details: { email: buyer.email, name: buyer.name },
        amount_subtotal: 4900,
        amount_total: 4900,
        total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
        currency: 'eur',
        payment_intent: `pi_${sessionId}`,
        created: Math.floor(Date.now() / 1000),
      },
    },
  });
  expect(status, 'webhook checkout.session.completed').toBe(200);
  const orderId = sql(
    `SELECT order_id FROM purchase_consent WHERE stripe_checkout_session_id = '${sessionId}'`,
  );
  expect(orderId, 'la compra guardó su consentimiento con la orden').toMatch(/^[0-9a-f-]{36}$/);
  return { sessionId, orderId };
}

test('correos de venta: recibo al comprar, la creadora lo personaliza en Ajustes y su texto sale con el recibo debajo', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const tenant = await freshTenant(`correos${Date.now().toString(36)}`, true);
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

  // ── Primer Sorbo vende su curso y manda sus correos al buzón de pruebas ──
  const alta = await apiAs<{ offer: { courseId: string } }>(
    tenant.host,
    '/api/v1/admin/simple-mode/quick-start',
    {
      method: 'POST',
      bearer,
      body: {
        academyName: 'Primer Sorbo',
        offer: 'course',
        title: COURSE,
        amountCents: 4900,
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
      title: 'Del grano a la taza',
      type: 'TEXT',
      orderIndex: 0,
      content: { text: 'Origen, tueste y molienda.' },
      durationSec: 60,
    },
  });
  const { salePath } = await apiAs<{ salePath: string }>(
    tenant.host,
    '/api/v1/admin/simple-mode/publish',
    { method: 'POST', bearer, body: {} },
  );
  const courseSlug = salePath.split('/').pop()!;
  await apiAs(tenant.host, '/api/v1/admin/tenant-settings/smtp', {
    method: 'PUT',
    bearer,
    body: smtpForMailpit(`hola@${tenant.slug}.example.com`, 'Primer Sorbo'),
  });

  // ── 1. Una persona sin cuenta compra: UN correo, el recibo ─────────────
  const ana = { email: `ana.${tenant.slug}@example.com`, name: 'Ana García' };
  const anaCtx = await context(browser, tenant);
  const anaPage = await anaCtx.newPage();
  const compra = await comprar(anaPage, tenant, salePath, ana);
  const ref = orderRef(compra.orderId);

  const recibo = await waitForMail(ana.email);
  expect(recibo.Subject).toBe(`Recibo de tu compra en Primer Sorbo (pedido ${ref})`);
  expect(recibo.From.Name).toBe('Primer Sorbo');
  for (const dato of [
    'Recibo de Primer Sorbo',
    `Pedido: ${ref}`,
    'Método de pago: Visa ···· 4242',
    'Hola, Ana:',
    `Ya tienes acceso a «${COURSE}».`,
    'Curso · pago único',
    'Precio final, impuestos incluidos.',
    'VENDIDO POR',
    `Contacto: hola@${tenant.slug}.example.com`,
    'Quiero acceder al curso ahora mismo.',
    'no hay plazo de 14 días para desistir de esta compra',
    'no una factura',
  ]) {
    expect(recibo.Text, dato).toContain(dato);
  }
  expect(recibo.Text).toMatch(/Total pagado: 49,00\s€/);
  expect(recibo.HTML).toContain('<html lang="es">');
  expect(recibo.HTML).toContain('Elige tu contraseña y entra');
  const enlace = /Elige tu contraseña y entra: (\S+)/.exec(recibo.Text)?.[1];
  expect(enlace, 'el recibo lleva el enlace para elegir contraseña').toContain(
    '/reset-password?token=',
  );
  expect(decodeURIComponent(enlace!)).toContain(`next=/courses/${courseSlug}`);
  // Ni rastro de la bienvenida suelta: el recibo la sustituye.
  await anaPage.waitForTimeout(2_000);
  expect((await mailsTo(ana.email)).map((m) => m.Subject)).toEqual([recibo.Subject]);

  // El botón del recibo la deja dentro de su curso.
  await anaPage.goto(enlace!.replace(/^https?:\/\/[^/]+/, ''));
  const pw = anaPage.locator('input[type="password"]');
  await pw.nth(0).fill('CafeDeOrigen123!');
  await pw.nth(1).fill('CafeDeOrigen123!');
  await anaPage
    .getByRole('button', { name: /contraseña/i })
    .last()
    .click();
  await anaPage.waitForURL((u) => !u.pathname.startsWith('/reset-password'), {
    timeout: 30_000,
  });
  // Primer acceso: si pide el perfil, se completa y sigue hacia su curso.
  if (anaPage.url().includes('/onboarding')) {
    sql(`UPDATE "user" SET onboarding_completed_at = now() WHERE email = '${ana.email}'`);
    await anaPage.goto(`/courses/${courseSlug}`);
  }
  await expect(anaPage).toHaveURL(new RegExp(`/courses/${courseSlug}`), { timeout: 30_000 });
  await anaCtx.close();

  // ── 2. La creadora personaliza el recibo en Ajustes → «Correos» ────────
  sql(
    `UPDATE "user" SET name = 'Lucía Martín', onboarding_completed_at = now() WHERE email = '${tenant.creatorEmail}'`,
  );
  const creadoraCtx = await context(browser, tenant);
  const creadora = await creadoraCtx.newPage();
  await creadora.goto(tenant.setPasswordUrl);
  const cpw = creadora.locator('input[type="password"]');
  await cpw.nth(0).fill(tenant.password);
  await cpw.nth(1).fill(tenant.password);
  await creadora
    .getByRole('button', { name: /contraseña/i })
    .last()
    .click();
  await creadora.waitForURL((u) => !u.pathname.startsWith('/reset-password'), {
    timeout: 30_000,
  });
  await creadora.goto('/admin/settings');
  const correos = creadora.getByTestId('correos-venta');
  await expect(correos.getByRole('heading', { name: 'Correos' })).toBeVisible({
    timeout: 30_000,
  });
  const fila = correos.getByTestId('correo-purchase.receipt');
  await expect(fila.getByText('Original', { exact: true })).toBeVisible();
  await fila.getByRole('button', { name: /Recibo de compra/ }).click();

  const editor = correos.getByTestId('editor-correo');
  const asunto = editor.getByLabel('Asunto');
  const mensaje = editor.getByLabel('Mensaje');
  await expect(asunto).toHaveValue('Recibo de tu compra en {academia} (pedido {pedido})');
  // El asunto se escribe y el nombre se añade con su botón, donde está el cursor.
  await asunto.fill('Tu café ya está listo, ');
  await asunto.press('End');
  await editor.getByRole('button', { name: /\{nombre\}/ }).click();
  await expect(asunto).toHaveValue('Tu café ya está listo, {nombre}');
  await mensaje.fill(
    'Gracias por apoyar a {academia}. Empieza por la primera lección de {producto}.',
  );

  // Vista previa con datos de ejemplo: el texto nuevo y el recibo debajo.
  await expect(editor.getByTestId('vista-previa-asunto')).toContainText(
    'Tu café ya está listo, Ana',
    { timeout: 20_000 },
  );
  const previa = editor.frameLocator('[data-testid="vista-previa-correo"]');
  await expect(previa.getByText(`Empieza por la primera lección de ${COURSE}.`)).toBeVisible({
    timeout: 20_000,
  });
  await expect(previa.getByText('A1B2C3D4').first()).toBeVisible();
  await expect(previa.getByText('Vendido por', { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Móvil' }).click();
  await expect(editor.getByTestId('vista-previa-correo')).toHaveCSS('width', '375px');
  await editor.getByRole('button', { name: 'Ordenador' }).click();

  await editor.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(editor.getByText('Guardado. Los próximos correos saldrán así.')).toBeVisible({
    timeout: 20_000,
  });
  await expect(fila.getByText('Personalizado', { exact: true })).toBeVisible();

  // «Enviarme una prueba»: le llega a ella, con su texto y el recibo de ejemplo.
  await editor.getByRole('button', { name: 'Enviarme una prueba' }).click();
  await expect(
    editor.getByText(`Te hemos enviado una prueba a ${tenant.creatorEmail}`),
  ).toBeVisible({
    timeout: 30_000,
  });
  const prueba = await waitForMail(tenant.creatorEmail);
  expect(prueba.Subject).toBe('Tu café ya está listo, Ana');
  expect(prueba.Text).toContain('Gracias por apoyar a Primer Sorbo.');
  expect(prueba.Text).toContain('A1B2C3D4');

  // ── 3. La siguiente compra sale con su texto y el recibo entero ────────
  const bea = { email: `bea.${tenant.slug}@example.com`, name: 'Beatriz Souza' };
  const beaCtx = await context(browser, tenant);
  const beaPage = await beaCtx.newPage();
  const segunda = await comprar(beaPage, tenant, salePath, bea);
  const segundo = await waitForMail(bea.email);
  expect(segundo.Subject).toBe('Tu café ya está listo, Beatriz');
  expect(segundo.Text).toContain(
    `Gracias por apoyar a Primer Sorbo. Empieza por la primera lección de ${COURSE}.`,
  );
  expect(segundo.Text).not.toContain('¡Gracias por tu compra!');
  for (const dato of [
    `Pedido: ${orderRef(segunda.orderId)}`,
    'Visa ···· 4242',
    'VENDIDO POR',
    'Quiero acceder al curso ahora mismo.',
    'Elige tu contraseña y entra',
  ]) {
    expect(segundo.Text, dato).toContain(dato);
  }
  expect(segundo.Text).toMatch(/Total pagado: 49,00\s€/);
  await beaCtx.close();

  // ── 4. «Volver al original» ────────────────────────────────────────────
  creadora.once('dialog', (d) => void d.accept());
  await editor.getByRole('button', { name: 'Volver al original' }).click();
  await expect(editor.getByText('Vuelve a salir el texto original.')).toBeVisible({
    timeout: 20_000,
  });
  await expect(asunto).toHaveValue('Recibo de tu compra en {academia} (pedido {pedido})');
  await expect(fila.getByText('Original', { exact: true })).toBeVisible();
  expect(
    sql(
      `SELECT count(*) FROM notification_template nt JOIN tenant t ON t.id = nt.tenant_id ` +
        `WHERE t.slug = '${tenant.slug}' AND nt.key = 'purchase.receipt'`,
    ),
  ).toBe('0');
  await creadoraCtx.close();
});
