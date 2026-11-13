/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHmac } from 'node:crypto';
import http from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { apiAs, freshTenant, sql } from '../helpers/simple-tenant';
import { startStripeDouble, type StripeDouble } from '../helpers/stripe-double';

/**
 * Referidos en TODAS las ventas, de punta a punta en un aula en modo sencillo:
 *
 *  1. La creadora pone un curso suelto a la venta y enciende «Tus alumnos
 *     venden por ti» desde Ventas (un botón).
 *  2. Una alumna copia SU enlace en «Invita y gana».
 *  3. Otra persona, sin cuenta, abre el enlace del curso con `?ref=`, marca la
 *     renuncia y pulsa «Comprar ahora»: el checkout sale hacia el doble de
 *     Stripe con el código en la metadata.
 *  4. Stripe confirma el pago (webhook firmado, como en `catalogo-publico`).
 *  5. La comisión aparece PENDIENTE en «Invita y gana» de la alumna (con la
 *     persona invitada en su lista) y en Ventas de la creadora.
 *
 * Cobra con las claves de pruebas de la instancia (`STRIPE_ALLOW_GLOBAL_FALLBACK`)
 * contra el doble (`STRIPE_TEST_API_URL`): nunca toca Stripe.
 */

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

/** Webhook de billing firmado como Stripe, al dominio del aula (así se resuelve el tenant). */
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

/** Persona del aula con contraseña puesta por su enlace (como el correo de acceso). */
async function entrar(page: Page, url: string, email: string, password: string) {
  await page.goto(url);
  const pw = page.locator('input[type="password"]');
  await pw.nth(0).fill(password);
  await pw.nth(1).fill(password);
  await page
    .getByRole('button', { name: /contraseña|password/i })
    .last()
    .click();
  await page.waitForURL(/\/signin/, { timeout: 20_000 });
  await page.locator('input[autocomplete="email"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.locator('button[type="submit"]').click();
}

async function signinPage(page: Page, email: string, password: string) {
  await page.goto('/signin');
  await page.locator('input[autocomplete="email"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.locator('button[type="submit"]').click();
}

test('referidos: una alumna invita, otra persona compra un curso suelto y la comisión sale pendiente', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const tenant = await freshTenant(`referidos${Date.now().toString(36)}`, true);
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

  // ── 1. Un curso suelto a la venta (alta en 3 preguntas + lección + publicar)
  const alta = await apiAs<{ offer: { courseId: string } }>(
    tenant.host,
    '/api/v1/admin/simple-mode/quick-start',
    {
      method: 'POST',
      bearer,
      body: {
        academyName: 'Taller de Acuarela',
        offer: 'course',
        title: 'Acuarela desde cero',
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
      title: 'Materiales',
      type: 'TEXT',
      orderIndex: 0,
      content: { text: 'Papel, pinceles y tres colores.' },
      durationSec: 60,
    },
  });
  const { salePath } = await apiAs<{ salePath: string }>(
    tenant.host,
    '/api/v1/admin/simple-mode/publish',
    { method: 'POST', bearer, body: {} },
  );
  expect(salePath).toBe('/catalog/acuarela-desde-cero');

  // La alumna que invitará: alta por el panel y enlace de contraseña.
  const alumnaEmail = `alumna@${tenant.slug}.test`;
  await apiAs(tenant.host, '/api/v1/admin/users', {
    method: 'POST',
    bearer,
    body: { email: alumnaEmail, role: 'alumno' },
  });
  sql(
    `UPDATE "user" SET name = 'Alumna Que Invita', onboarding_completed_at = now() WHERE email = '${alumnaEmail}'`,
  );
  const token = `${Date.now().toString(36)}${'a'.repeat(40)}`;
  const { createHash } = await import('node:crypto');
  sql(
    `INSERT INTO password_reset_token (id, user_id, tenant_id, token_hash, expires_at, created_at) ` +
      `SELECT gen_random_uuid(), u.id, u.tenant_id, '${createHash('sha256').update(token).digest('hex')}', now() + interval '1 day', now() ` +
      `FROM "user" u WHERE u.email = '${alumnaEmail}'`,
  );

  const nuevo = async () => {
    const ctx = await browser.newContext({
      locale: 'es-ES',
      viewport: { width: 1440, height: 900 },
      baseURL: tenant.base,
    });
    await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
    return ctx;
  };

  // ── 2. La creadora enciende los referidos desde Ventas ──────────────────
  const creadoraCtx = await nuevo();
  const creadora = await creadoraCtx.newPage();
  await signinPage(creadora, operador, tenant.password);
  await creadora.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
  await creadora.goto('/admin/membership');
  const seccion = creadora.locator('section#referrals');
  await expect(seccion).toBeVisible({ timeout: 30_000 });
  // Con el módulo ya activo en el aula el botón es «Encender»; sin él, «Activar los referidos».
  await seccion.getByRole('button', { name: /^(Encender|Activar los referidos)$/ }).click();
  await expect(seccion.getByText('Programa activo', { exact: true })).toBeVisible({
    timeout: 20_000,
  });

  // ── 3. La alumna copia su enlace del curso en «Invita y gana» ──────────
  const alumnaCtx = await nuevo();
  const alumna = await alumnaCtx.newPage();
  await entrar(
    alumna,
    `${tenant.base}/reset-password?token=${token}`,
    alumnaEmail,
    'AlumnaInvita123!',
  );
  await alumna.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
  await alumna.goto('/referrals');
  // Primera vez: declara ser mayor de 18 y acepta las condiciones del programa.
  const casilla = alumna.getByTestId('referidos-casilla');
  await expect(casilla).toBeVisible({ timeout: 30_000 });
  await casilla.getByRole('checkbox').check();
  await casilla.getByRole('button', { name: 'Activar mi enlace' }).click();
  const enlace = alumna.getByTestId('referidos-enlace');
  await expect(enlace).toContainText('ref=', { timeout: 30_000 });
  const code = /ref=([a-z0-9]+)/i.exec((await enlace.textContent()) ?? '')?.[1];
  expect(code, 'código de referido de la alumna').toBeTruthy();
  // Con un solo curso a la venta, el enlace general ya lleva a él.
  await expect(enlace).toContainText(`/catalog`);

  // ── 4. Otra persona, sin cuenta, compra con el enlace ──────────────────
  const compradoraCtx = await nuevo();
  const compradora = await compradoraCtx.newPage();
  await compradora.goto(`${salePath}?ref=${code}`);
  await expect(compradora.getByRole('heading', { name: 'Acuarela desde cero' })).toBeVisible({
    timeout: 30_000,
  });
  await compradora.getByRole('checkbox').check();
  await compradora.getByRole('button', { name: 'Comprar ahora' }).click();
  await compradora.waitForURL(/127\.0\.0\.1:\d+\/pagar\//, { timeout: 30_000 });

  const sesion = stripe.calls
    .filter((c) => c.method === 'POST' && c.path === '/v1/checkout/sessions')
    .at(-1);
  expect(sesion, 'el checkout salió hacia el doble de Stripe').toBeTruthy();
  expect(sesion!.body['metadata[referralCode]']).toBe(code!.toLowerCase());
  const metadata = Object.fromEntries(
    Object.entries(sesion!.body)
      .filter(([k]) => k.startsWith('metadata['))
      .map(([k, v]) => [k.slice('metadata['.length, -1), v]),
  );
  const sessionId = decodeURIComponent(new URL(compradora.url()).pathname.split('/').pop()!);

  // ── 5. Stripe confirma el pago ─────────────────────────────────────────
  const compradoraEmail = `compradora@${tenant.slug}.test`;
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
        customer_details: { email: compradoraEmail, name: 'Compradora Invitada' },
        amount_total: 4900,
        currency: 'eur',
        payment_intent: `pi_${sessionId}`,
      },
    },
  });
  expect(status, 'webhook checkout.session.completed').toBe(200);

  // La comisión (30 % por defecto de 49 €) queda PENDIENTE hasta pasar la garantía.
  await expect
    .poll(
      () =>
        sql(
          `SELECT c.status || '|' || c.amount_cents FROM mod_referrals_commission c ` +
            `JOIN tenant t ON t.id = c.tenant_id WHERE t.slug = '${tenant.slug}'`,
        ),
      { timeout: 90_000 },
    )
    .toBe('PENDING|1470');

  // En «Invita y gana» de la alumna: la persona invitada y lo pendiente.
  await alumna.reload();
  await expect(alumna.getByText(/14,70\s€ pendiente de confirmar/)).toBeVisible({
    timeout: 30_000,
  });
  const invitados = alumna.getByTestId('referidos-invitados');
  await expect(invitados.getByText('Compró un curso')).toBeVisible();
  await expect(invitados).toContainText('14,70');

  // En Ventas de la creadora: la venta traída por referidos, pendiente.
  await creadora.reload();
  const ventas = creadora.locator('section#referrals');
  await expect(ventas).toContainText(/Pago de 49\s€/, { timeout: 30_000 });
  await expect(ventas).toContainText(/14,70\s€ para quien invitó/);
  await expect(ventas.getByText('Pendiente', { exact: true })).toBeVisible();

  await Promise.all([creadoraCtx.close(), alumnaCtx.close(), compradoraCtx.close()]);
});
