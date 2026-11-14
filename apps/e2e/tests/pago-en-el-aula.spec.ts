/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * EL PAGO DENTRO DEL AULA, contra Stripe de PRUEBA de verdad.
 *
 * Quien compra ya no sale a la página de Stripe sin ver nada del aula: paga en
 * la ficha de venta, con la cabecera, el logo, el color, la portada y quién
 * vende (Checkout embebido). Aquí se compra de verdad con las tarjetas de
 * prueba de Stripe, en los dos modos de cobro:
 *
 *  - PLATAFORMA (cobro y transferencia separados, `on_behalf_of` de la cuenta
 *    conectada): curso con `?ref=`, curso con 3-D Secure, un pago rechazado
 *    que vuelve bien y la membresía. Además, la marca del aula llega a su
 *    cuenta conectada (logo, color, descriptor del extracto).
 *  - CLAVES PROPIAS del aula: curso y membresía.
 *
 * Los webhooks: Stripe no llega a localhost, así que el test lee los eventos
 * REALES de la cuenta de prueba (`GET /v1/events`) y los entrega al webhook
 * local firmados con el secreto con el que arrancó la API. El contenido es el
 * de Stripe, sin tocar.
 *
 * Solo corre con `E2E_STRIPE_REAL=1` y una API arrancada en modo plataforma
 * contra la cuenta de prueba (ver la cabecera de `pagoReal()` abajo). La suite
 * normal (con el doble de Stripe) lo salta. Nunca con claves de producción:
 * se para si la clave no es `sk_test_`.
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';

const REAL = process.env.E2E_STRIPE_REAL === '1';
const SHOTS = process.env.E2E_SHOTS_DIR ?? null;
const ASSETS = process.env.E2E_BRAND_ASSETS_DIR ?? null;

function readSecretFile(name: string): string {
  const file = process.env[name];
  if (!file) throw new Error(`Falta ${name}`);
  return readFileSync(file, 'utf8').trim();
}

/** La clave de prueba de la cuenta de Stripe (la del operador). Nunca se imprime. */
const SK = REAL ? readSecretFile('E2E_STRIPE_TEST_KEY_FILE') : '';
const PK = REAL ? readSecretFile('E2E_STRIPE_TEST_PK_FILE') : '';
if (REAL && (!SK.startsWith('sk_test_') || !PK.startsWith('pk_test_'))) {
  throw new Error('PARADA: este spec solo corre con claves de PRUEBA de Stripe');
}
const PLATFORM_WHSEC = process.env.E2E_PLATFORM_WEBHOOK_SECRET ?? '';
const CONNECTED = process.env.E2E_STRIPE_CONNECTED_ACCOUNT ?? '';
const OWN_WHSEC = 'whsec_e2e_aula_con_claves_propias';
const API = process.env.E2E_API_DIRECT_URL ?? 'http://localhost:4000';

test.skip(!REAL, 'Solo con Stripe de prueba de verdad (E2E_STRIPE_REAL=1)');
test.describe.configure({ mode: 'serial' });

// ── Stripe (lectura con la clave de prueba) ──────────────────────────────────

async function stripeGet<T>(p: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`https://api.stripe.com${p}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.append(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${SK}` } });
  const body = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Stripe ${p}: ${body.error?.message ?? res.status}`);
  return body;
}

interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

/**
 * Entrega al webhook local los eventos reales de Stripe que tocan una sesión
 * (y su suscripción y facturas, si las hay), en orden, firmados con `secret`.
 * Espera a que aparezca el `checkout.session.completed` de la sesión.
 */
async function relay(opts: {
  sessionId: string;
  since: number;
  secret: string;
  endpoints: string[];
  host?: string;
}): Promise<string[]> {
  const deadline = Date.now() + 60_000;
  let completed: StripeEvent | undefined;
  while (Date.now() < deadline) {
    const page = await stripeGet<{ data: StripeEvent[] }>('/v1/events', {
      'created[gte]': String(opts.since - 5),
      limit: '100',
    });
    completed = page.data.find(
      (e) => e.type === 'checkout.session.completed' && e.data.object['id'] === opts.sessionId,
    );
    if (completed) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!completed)
    throw new Error(`Stripe no emitió checkout.session.completed de ${opts.sessionId}`);
  // Un respiro para que lleguen los de la suscripción y la factura.
  await new Promise((r) => setTimeout(r, 4000));
  const events = (
    await stripeGet<{ data: StripeEvent[] }>('/v1/events', {
      'created[gte]': String(opts.since - 5),
      limit: '100',
    })
  ).data;
  const subscription = completed.data.object['subscription'];
  const related = events
    .filter((e) => {
      const o = e.data.object;
      if (o['id'] === opts.sessionId) return true;
      if (subscription && (o['id'] === subscription || o['subscription'] === subscription)) {
        return true;
      }
      return false;
    })
    .sort((a, b) => a.created - b.created);
  const delivered: string[] = [];
  for (const event of related) {
    const payload = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', opts.secret).update(`${t}.${payload}`).digest('hex');
    for (const endpoint of opts.endpoints) {
      const res = await fetch(`${API}${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': `t=${t},v1=${v1}`,
          ...(opts.host ? { 'x-forwarded-host': opts.host } : {}),
        },
        body: payload,
      });
      expect(res.status, `${endpoint} ${event.type}`).toBeLessThan(300);
    }
    delivered.push(event.type);
  }
  return delivered;
}

// ── El formulario de Stripe (dentro de su iframe) ────────────────────────────

function stripeFrame(page: Page): FrameLocator {
  return page.frameLocator('[data-testid="pago-embebido"] iframe').first();
}

async function payWithCard(page: Page, opts: { email: string; card: string }) {
  const frame = stripeFrame(page);
  await frame.locator('#email').fill(opts.email, { timeout: 60_000 });
  // Con varios métodos activos, la tarjeta va plegada bajo «Tarjeta».
  // Con varios métodos activos, la tarjeta va plegada: se abre su acordeón.
  // (su botón de acordeón es un área de clic transparente: se le manda el clic).
  const cardNumber = frame.locator('#cardNumber');
  const cardTab = frame.locator('[data-testid="card-accordion-item-button"]').first();
  await cardTab.or(cardNumber).first().waitFor({ state: 'attached', timeout: 30_000 });
  if (!(await cardNumber.isVisible())) await cardTab.dispatchEvent('click');
  await cardNumber.fill(opts.card, { timeout: 15_000 });
  await frame.locator('#cardExpiry').fill('12 / 34');
  await frame.locator('#cardCvc').fill('123');
  await frame.locator('#billingName').fill('Compradora Prueba');
  const postal = frame.locator('#billingPostalCode');
  if (await postal.isVisible().catch(() => false)) await postal.fill('28001');
  const saveInfo = frame.locator('#enableStripePass');
  if (await saveInfo.isChecked().catch(() => false)) await saveInfo.uncheck();
  await frame
    .locator('[data-testid="hosted-payment-submit-button"], .SubmitButton')
    .first()
    .click();
}

/** El reto 3-D Secure de prueba (iframes anidados dentro del de Stripe). */
async function complete3ds(page: Page) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const button = frame.locator('#test-source-authorize-3ds');
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        return;
      }
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('No apareció el reto 3-D Secure');
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

// ── Siembra ───────────────────────────────────────────────────────────────────

interface Aula {
  tenant: FreshTenant;
  bearer: string;
  courseSlug: string;
  productId: string;
  planId: string;
}

function b64(file: string): string {
  return readFileSync(file).toString('base64');
}

async function seedAula(opts: {
  name: string;
  hue: number;
  saturation: number;
  course: string;
  coverFile: string | null;
  logoFile: string | null;
  amountCents: number;
  plan: { name: string; amountCents: number };
  /** Conecta los cobros del aula (antes de publicar: sin ellos no se publica). */
  connect: (tenant: FreshTenant, bearer: string) => Promise<void>;
}): Promise<Aula> {
  const tenant = await freshTenant(
    `${opts.name.toLowerCase().replace(/[^a-z]/g, '')}${Date.now().toString(36)}`,
    true,
  );
  // En local el dominio del aula no lleva el puerto de la web: sin dominio
  // primario, la URL del aula (vuelta del pago, logo) sale de la petición.
  sql(`UPDATE tenant_domain SET is_primary = false WHERE hostname = '${tenant.host}'`);
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
  const alta = await apiAs<{ offer: { courseId: string } }>(
    tenant.host,
    '/api/v1/admin/simple-mode/quick-start',
    {
      method: 'POST',
      bearer,
      body: {
        academyName: opts.name,
        offer: 'course',
        title: opts.course,
        amountCents: opts.amountCents,
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
      title: 'Bienvenida',
      type: 'TEXT',
      orderIndex: 0,
      content: { text: 'Lo que vas a necesitar.' },
      durationSec: 60,
    },
  });
  await opts.connect(tenant, bearer);
  const { salePath } = await apiAs<{ salePath: string }>(
    tenant.host,
    '/api/v1/admin/simple-mode/publish',
    { method: 'POST', bearer, body: {} },
  );
  // Marca del aula: nombre, logo y color.
  sql(`UPDATE tenant SET name = '${opts.name.replace(/'/g, "''")}' WHERE slug = '${tenant.slug}'`);
  if (opts.logoFile) {
    await apiAs(tenant.host, '/api/v1/modules/theming/me/logo', {
      method: 'POST',
      bearer,
      body: { data: b64(opts.logoFile), filename: 'logo.png', contentType: 'image/png' },
    });
  }
  await apiAs(tenant.host, '/api/v1/modules/theming/me', {
    method: 'PUT',
    bearer,
    body: {
      brandHue: opts.hue,
      brandSaturation: opts.saturation,
      logoDisplayMode: 'logo_and_name',
    },
  });
  if (opts.coverFile) {
    const up = await apiAs<{ url: string }>(tenant.host, '/api/v1/storage/upload', {
      method: 'POST',
      bearer,
      body: { data: b64(opts.coverFile), filename: 'portada.jpg', contentType: 'image/jpeg' },
    });
    sql(`UPDATE mod_courses_course SET thumbnail_url = '${up.url}' WHERE id = '${courseId}'`);
  }
  // Quien la lleva, con nombre (lo enseñan la ficha y el pago).
  sql(`UPDATE "user" SET name = 'Lucía Prieto' WHERE email = 'creadora@${tenant.slug}.test'`);
  // Correo de contacto del aula.
  await apiAs(tenant.host, '/api/v1/admin/tenant-settings/smtp/sender', {
    method: 'PUT',
    bearer,
    body: { replyToEmail: `hola@${tenant.slug}.test` },
  }).catch(() => undefined);
  // Membresía con un plan mensual.
  await apiAs(tenant.host, '/api/v1/membership/admin/config', {
    method: 'PUT',
    bearer,
    body: { active: true },
  });
  const plan = await apiAs<{ id: string }>(tenant.host, '/api/v1/membership/admin/plans', {
    method: 'POST',
    bearer,
    body: { name: opts.plan.name, intervalMonths: 1, amountCents: opts.plan.amountCents },
  });
  const productId = sql(
    `SELECT id FROM mod_billing_product WHERE course_id = '${courseId}' ORDER BY created_at LIMIT 1`,
  );
  return {
    tenant,
    bearer,
    courseSlug: salePath.replace('/catalog/', ''),
    productId,
    planId: plan.id,
  };
}

/** Abre la ficha, marca la casilla, pulsa «Comprar» y espera el pago dentro del aula. */
async function openCheckout(page: Page, url: string): Promise<string> {
  await page.goto(url);
  await page.getByTestId('withdrawal-waiver').getByRole('checkbox').check();
  const response = page.waitForResponse(
    (r) => r.url().includes('/checkout') && r.request().method() === 'POST',
  );
  await page.getByTestId(url.includes('/join') ? 'unete-pagar' : 'ficha-comprar').click();
  const body = (await (await response).json()) as { mode: string; sessionId: string };
  expect(body.mode, 'el servidor concede el pago embebido').toBe('embedded');
  await expect(page.getByTestId('pago-en-el-aula')).toBeVisible();
  await expect(page.getByTestId('pago-embebido')).toHaveAttribute('data-state', 'ready', {
    timeout: 60_000,
  });
  return body.sessionId;
}

// ═════════════════════════════════════════════════════════════════════════════

let platform: Aula;
let own: Aula;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const dir = ASSETS;
  platform = await seedAula({
    name: 'Primer Sorbo',
    hue: 18,
    saturation: 82,
    course: 'Espresso en casa',
    coverFile: dir ? path.join(dir, 'portada-espresso-at-home.jpg') : null,
    logoFile: dir ? path.join(dir, 'logo-primer-sorbo.png') : null,
    amountCents: 2900,
    plan: { name: 'Club del café', amountCents: 1900 },
    // Cuenta conectada YA dada de alta en Stripe (las de prueba piden aceptar
    // las condiciones a mano): se enlaza al aula y se sincroniza con Stripe.
    connect: async (tenant, bearer) => {
      const tid = sql(`SELECT id FROM tenant WHERE slug = '${tenant.slug}'`);
      // La cuenta de prueba es una sola: la de una pasada anterior se cierra.
      sql(
        `UPDATE mod_payouts_account SET closed_at = now(), status = 'DISCONNECTED', ` +
          `stripe_account_id = stripe_account_id || '_cerrada_' || substr(id::text, 1, 8) ` +
          `WHERE stripe_account_id = '${CONNECTED}'`,
      );
      sql(
        `INSERT INTO mod_payouts_account (id, tenant_id, stripe_account_id, country, entity_type, status, payout_schedule, livemode, created_at, updated_at) ` +
          `VALUES (gen_random_uuid(), '${tid}', '${CONNECTED}', 'ES', 'individual', 'ONBOARDING', '{}', false, now(), now())`,
      );
      const status = await apiAs<{ account: { status: string } | null }>(
        tenant.host,
        '/api/v1/modules/payouts/status?sync=1',
        { bearer },
      );
      expect(status.account?.status).toBe('READY');
    },
  });

  own = await seedAula({
    name: 'Café de Origen',
    hue: 152,
    saturation: 45,
    course: 'Cata para principiantes',
    coverFile: ASSETS ? path.join(ASSETS, 'portada-coffee-tasting-101.jpg') : null,
    logoFile: ASSETS ? path.join(ASSETS, 'logo-morning-pour.png') : null,
    amountCents: 1500,
    plan: { name: 'Suscripción catadora', amountCents: 900 },
    // Claves PROPIAS del aula (la misma cuenta de prueba, sin plataforma).
    connect: async (tenant, bearer) => {
      await apiAs(tenant.host, '/api/v1/admin/tenant-settings/stripe', {
        method: 'PUT',
        bearer,
        body: { secretKey: SK, webhookSecret: OWN_WHSEC, publishableKey: PK },
      });
    },
  });
});

test('plataforma · la marca del aula llega a su cuenta conectada (logo, color, extracto)', async () => {
  test.setTimeout(120_000);
  let account: {
    metadata?: Record<string, string>;
    settings?: {
      branding?: Record<string, string | null>;
      payments?: { statement_descriptor?: string };
      card_payments?: { statement_descriptor_prefix?: string };
    };
  } = {};
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    account = await stripeGet(`/v1/accounts/${CONNECTED}`);
    if (
      account.metadata?.['didacta_branding'] &&
      account.settings?.payments?.statement_descriptor === 'PRIMER SORBO'
    )
      break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  expect(account.settings?.payments?.statement_descriptor).toBe('PRIMER SORBO');
  expect(account.settings?.card_payments?.statement_descriptor_prefix).toBe('PRIMER');
  expect(account.settings?.branding?.['primary_color']).toMatch(/^#[0-9a-f]{6}$/);
  if (ASSETS) expect(account.settings?.branding?.['icon']).toMatch(/^file_/);
  // Logo sin el nombre dentro («logo y nombre»): Stripe pinta el nombre.
  expect(account.settings?.branding?.['logo'] ?? null).toBeNull();
});

test('plataforma · curso con ?ref=: se paga DENTRO de la ficha y da acceso', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  for (const [label, width, height] of [
    ['escritorio', 1440, 900],
    ['movil', 390, 844],
  ] as const) {
    const ctx = await browser.newContext({
      locale: 'es-ES',
      viewport: { width, height },
      baseURL: platform.tenant.base,
    });
    await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: platform.tenant.base }]);
    const page = await ctx.newPage();
    const ficha = `/catalog/${platform.courseSlug}?ref=ana123`;
    await page.goto(ficha);
    await expect(
      page
        .getByText('Pago único · Precio final')
        .or(page.getByText('Pago seguro con Stripe. Precio final.')),
    ).toBeVisible();
    // Sin la casilla, «Comprar» dice por qué no avanza y señala la casilla.
    await page.getByTestId('ficha-comprar').click({ force: true });
    await expect(page.getByTestId('withdrawal-waiver')).toHaveAttribute('data-nudge', 'true');
    await expect(page.getByTestId('withdrawal-waiver-hint')).toBeVisible();
    await shot(page, `01-ficha-casilla-sin-marcar-${label}`);

    const since = Math.floor(Date.now() / 1000);
    const sessionId = await openCheckout(page, ficha);
    // La cabecera, la marca y el resumen del aula, con el total DE LA SESIÓN.
    await expect(page.getByTestId('pago-marca')).toContainText('Primer Sorbo');
    await expect(page.getByTestId('pago-producto')).toHaveText('Espresso en casa');
    await expect(page.getByTestId('pago-total')).toHaveText(/29\s€/);
    await expect(page.getByTestId('pago-vende')).toContainText('Lucía Prieto');
    await expect(page.getByTestId('pago-seguro')).toBeVisible();
    await shot(page, `02-pago-en-el-aula-${label}`);

    const email = `compradora-${label}-${Date.now().toString(36)}@example.com`;
    await payWithCard(page, { email, card: '4242424242424242' });
    await page.waitForURL(/\/catalog\/checkout\/success\?session_id=cs_test_.+checkout=embedded/, {
      timeout: 90_000,
    });
    await expect(page.getByTestId('gracias-pagado')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('gracias-producto')).toHaveText('Espresso en casa');
    await expect(page.getByTestId('gracias-importe')).toHaveText(/29\s€/);
    await expect(page.getByTestId('gracias-entrar')).toContainText('Entrar al curso');
    await expect(page.locator('body')).not.toContainText('cs_test_');
    await shot(page, `03-gracias-${label}`);

    // Cobro y transferencia separados, en nombre de la cuenta del creador.
    const session = await stripeGet<{
      payment_intent: string;
      metadata: Record<string, string>;
      ui_mode: string;
    }>(`/v1/checkout/sessions/${sessionId}`);
    // `embedded` en la versión de la API con la que se crea (acacia);
    // `embedded_page` si se lee con la versión por defecto de la cuenta.
    expect(session.ui_mode).toMatch(/^embedded/);
    expect(session.metadata['referralCode']).toBe('ana123');
    const pi = await stripeGet<{ on_behalf_of: string; transfer_group: string }>(
      `/v1/payment_intents/${session.payment_intent}`,
    );
    expect(pi.on_behalf_of).toBe(CONNECTED);
    expect(pi.transfer_group).toMatch(/^didacta_/);

    // El webhook (eventos reales de Stripe) entrega el acceso.
    await relay({
      sessionId,
      since,
      secret: PLATFORM_WHSEC,
      endpoints: ['/api/v1/modules/payouts/webhook'],
    });
    await expect
      .poll(
        () => sql(`SELECT status FROM mod_billing_order WHERE stripe_session_id = '${sessionId}'`),
        {
          timeout: 30_000,
        },
      )
      .toBe('COMPLETED');
    expect(sql(`SELECT count(*) FROM "user" WHERE email = '${email}'`)).toBe('1');
    await ctx.close();
  }
});

test('plataforma · 3-D Secure: el reto se completa dentro del pago', async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext({ locale: 'es-ES', baseURL: platform.tenant.base });
  const page = await ctx.newPage();
  const since = Math.floor(Date.now() / 1000);
  const sessionId = await openCheckout(page, `/catalog/${platform.courseSlug}`);
  await payWithCard(page, {
    email: `tresdes-${Date.now().toString(36)}@example.com`,
    card: '4000002760003184',
  });
  await complete3ds(page);
  await page.waitForURL(/\/catalog\/checkout\/success/, { timeout: 90_000 });
  await expect(page.getByTestId('gracias-pagado')).toBeVisible({ timeout: 30_000 });
  await relay({
    sessionId,
    since,
    secret: PLATFORM_WHSEC,
    endpoints: ['/api/v1/modules/payouts/webhook'],
  });
  await expect
    .poll(
      () => sql(`SELECT status FROM mod_billing_order WHERE stripe_session_id = '${sessionId}'`),
      {
        timeout: 30_000,
      },
    )
    .toBe('COMPLETED');
  await ctx.close();
});

test('plataforma · tarjeta rechazada: se queda en el pago, no cobra y la vuelta no dice «gracias»', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext({ locale: 'es-ES', baseURL: platform.tenant.base });
  const page = await ctx.newPage();
  const sessionId = await openCheckout(page, `/catalog/${platform.courseSlug}`);
  await payWithCard(page, {
    email: `rechazo-${Date.now().toString(36)}@example.com`,
    card: '4000000000000002',
  });
  // Stripe lo dice en su formulario y no se sale de la ficha.
  await expect(
    stripeFrame(page)
      .getByText(/declin|rechaz/i)
      .first(),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(page).toHaveURL(new RegExp(`/catalog/${platform.courseSlug}`));
  await shot(page, '04-pago-rechazado-escritorio');
  // «Volver» lleva a la ficha tal como estaba.
  await page.getByTestId('pago-volver').click();
  await expect(page.getByTestId('pago-en-el-aula')).toBeHidden();
  await expect(page.getByTestId('ficha-comprar')).toBeVisible();
  // Y si alguien llega a la vuelta con esa sesión: «no se ha completado».
  await page.goto(`/catalog/checkout/success?session_id=${sessionId}&checkout=embedded`);
  await expect(page.getByTestId('gracias-no-pagado')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Volver a intentarlo' })).toHaveAttribute(
    'href',
    `/catalog/${platform.courseSlug}`,
  );
  await shot(page, '05-vuelta-sin-pago-escritorio');
  expect(sql(`SELECT status FROM mod_billing_order WHERE stripe_session_id = '${sessionId}'`)).toBe(
    'PENDING',
  );
  await ctx.close();
});

test('plataforma · el precio cambia con la ficha abierta: se enseña el de la sesión', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ locale: 'es-ES', baseURL: platform.tenant.base });
  const page = await ctx.newPage();
  await page.goto(`/catalog/${platform.courseSlug}`);
  await expect(page.getByTestId('precio-curso')).toHaveText(/29\s€/);
  // La creadora baja el precio a 1 € mientras la ficha sigue abierta.
  await apiAs(platform.tenant.host, `/api/v1/modules/billing/products/${platform.productId}`, {
    method: 'PATCH',
    bearer: platform.bearer,
    body: { amountCents: 100 },
  });
  await page.getByTestId('withdrawal-waiver').getByRole('checkbox').check();
  await page.getByTestId('ficha-comprar').click();
  await expect(page.getByTestId('pago-en-el-aula')).toBeVisible();
  await expect(page.getByTestId('pago-total')).toHaveText(/1\s€/);
  await expect(page.getByText('El precio se ha actualizado')).toBeVisible();
  await shot(page, '06-precio-de-la-sesion-escritorio');
  // Se deja como estaba para el resto de pruebas.
  await apiAs(platform.tenant.host, `/api/v1/modules/billing/products/${platform.productId}`, {
    method: 'PATCH',
    bearer: platform.bearer,
    body: { amountCents: 2900 },
  });
  await ctx.close();
});

test('plataforma · membresía con ?ref=: pago dentro de /join y alta del miembro', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({
    locale: 'es-ES',
    viewport: { width: 1440, height: 900 },
    baseURL: platform.tenant.base,
  });
  const page = await ctx.newPage();
  const since = Math.floor(Date.now() / 1000);
  const sessionId = await openCheckout(page, '/join?ref=ana123');
  await expect(page.getByTestId('pago-producto')).toHaveText('Club del café');
  await expect(page.getByTestId('pago-total')).toHaveText(/19\s€/);
  await shot(page, '07-membresia-pago-en-el-aula-escritorio');
  const email = `miembro-${Date.now().toString(36)}@example.com`;
  await payWithCard(page, { email, card: '4242424242424242' });
  await page.waitForURL(/\/join\?status=success&session_id=cs_test_.+checkout=embedded/, {
    timeout: 90_000,
  });
  await expect(page.getByTestId('gracias-pagado')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('gracias-producto')).toHaveText('Club del café');
  await shot(page, '08-membresia-gracias-escritorio');
  const session = await stripeGet<{ subscription: string; metadata: Record<string, string> }>(
    `/v1/checkout/sessions/${sessionId}`,
  );
  expect(session.metadata['referralCode']).toBe('ana123');
  const sub = await stripeGet<{ on_behalf_of: string }>(
    `/v1/subscriptions/${session.subscription}`,
  );
  expect(sub.on_behalf_of).toBe(CONNECTED);
  await relay({
    sessionId,
    since,
    secret: PLATFORM_WHSEC,
    endpoints: ['/api/v1/modules/payouts/webhook'],
  });
  await expect
    .poll(
      () =>
        sql(
          `SELECT s.status FROM mod_subscriptions_subscription s JOIN "user" u ON u.id = s.user_id WHERE u.email = '${email}'`,
        ),
      { timeout: 30_000 },
    )
    .toMatch(/ACTIVE|TRIALING/);
  await ctx.close();
});

test('claves propias del aula · curso y membresía dentro de la página, con su clave publicable', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext({
    locale: 'es-ES',
    viewport: { width: 1440, height: 900 },
    baseURL: own.tenant.base,
  });
  const page = await ctx.newPage();

  // Curso.
  let since = Math.floor(Date.now() / 1000);
  let sessionId = await openCheckout(page, `/catalog/${own.courseSlug}?ref=ana123`);
  await expect(page.getByTestId('pago-marca')).toContainText('Café de Origen');
  await shot(page, '09-claves-propias-pago-en-el-aula-escritorio');
  const email = `propia-${Date.now().toString(36)}@example.com`;
  await payWithCard(page, { email, card: '4242424242424242' });
  await page.waitForURL(/\/catalog\/checkout\/success/, { timeout: 90_000 });
  await expect(page.getByTestId('gracias-pagado')).toBeVisible({ timeout: 30_000 });
  const pi = await stripeGet<{ payment_intent: string }>(`/v1/checkout/sessions/${sessionId}`);
  const intent = await stripeGet<{ on_behalf_of: string | null }>(
    `/v1/payment_intents/${pi.payment_intent}`,
  );
  // Claves propias: sin cuenta conectada de por medio.
  expect(intent.on_behalf_of).toBeNull();
  await relay({
    sessionId,
    since,
    secret: OWN_WHSEC,
    endpoints: ['/api/v1/modules/billing/webhook'],
    host: own.tenant.host,
  });
  await expect
    .poll(
      () => sql(`SELECT status FROM mod_billing_order WHERE stripe_session_id = '${sessionId}'`),
      {
        timeout: 30_000,
      },
    )
    .toBe('COMPLETED');

  // Membresía.
  since = Math.floor(Date.now() / 1000);
  sessionId = await openCheckout(page, '/join');
  const miembro = `propia-miembro-${Date.now().toString(36)}@example.com`;
  await payWithCard(page, { email: miembro, card: '4242424242424242' });
  await page.waitForURL(/\/join\?status=success/, { timeout: 90_000 });
  await expect(page.getByTestId('gracias-pagado')).toBeVisible({ timeout: 30_000 });
  await relay({
    sessionId,
    since,
    secret: OWN_WHSEC,
    endpoints: ['/api/v1/modules/subscriptions/webhook'],
    host: own.tenant.host,
  });
  await expect
    .poll(
      () =>
        sql(
          `SELECT s.status FROM mod_subscriptions_subscription s JOIN "user" u ON u.id = s.user_id WHERE u.email = '${miembro}'`,
        ),
      { timeout: 30_000 },
    )
    .toMatch(/ACTIVE|TRIALING/);
  await ctx.close();
});
