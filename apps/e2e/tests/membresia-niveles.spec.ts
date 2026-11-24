/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';
import { startStripeDouble, type StripeDouble } from '../helpers/stripe-double';

/**
 * MEMBRESÍA POR NIVELES, de punta a punta en un aula nueva que cobra con sus
 * claves (modo `own`) contra el doble de Stripe:
 *
 *  1. La creadora crea en Membresía (modo completo) los niveles Básico (curso
 *     A), Pro (cursos A y B) y Gratis (curso L), con sus precios.
 *  2. /join pinta una tarjeta por nivel con lo que incluye y «Entrar gratis».
 *  3. Ana compra Básico → ve A y no B.
 *  4. Ana sube a Pro desde su cuenta: la vista previa dice lo que se cobra hoy
 *     (prorrateo), Stripe recibe `always_invoice` + `error_if_incomplete` y B
 *     se abre. El webhook que llega después no duplica el cambio.
 *  5. Ana baja a Básico: `create_prorations` y B se cierra (A sigue).
 *  6. Si la tarjeta falla al subir (402), no cambia nada.
 *  7. Leo entra gratis (registro gratis + aprobación): ve L y ni A ni B.
 *
 * Y dos controles: un aula SIN niveles no ofrece nada de esto (su /join y su
 * cuenta siguen como siempre) y el modo sencillo (Ventas) también edita
 * niveles.
 *
 * Con cobros de plataforma el cambio va a la cuenta donde vive la suscripción
 * (lo fija `platform-membership.test.ts`); el arnés no arranca la API en ese
 * modo.
 *
 * `E2E_CAPTURAS=<carpeta>` guarda capturas.
 */

const CAPTURAS = process.env.E2E_CAPTURAS;
const WEBHOOK_SECRET =
  process.env.SUBSCRIPTIONS_WEBHOOK_SECRET ??
  process.env.E2E_WEBHOOK_SECRET ??
  'whsec_e2e_local_secret';
const API_PORT = Number(process.env.API_PORT ?? 4000);
const PASSWORD = 'AlumnaPrueba123!';
const DAY = 86_400;

let stripe: StripeDouble;
test.beforeAll(async () => {
  stripe = await startStripeDouble();
});
test.afterAll(async () => {
  await stripe?.close();
});

async function shot(page: Page, name: string) {
  if (!CAPTURAS) return;
  mkdirSync(CAPTURAS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(CAPTURAS, `${name}.png`), fullPage: true });
}

/** Webhook de suscripciones firmado como Stripe, al dominio del aula. */
function sendSubscriptionsWebhook(host: string, event: Record<string, unknown>): Promise<number> {
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: API_PORT,
        path: '/api/v1/modules/subscriptions/webhook',
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

/** Igual que `apiAs` pero devuelve el código y el cuerpo también si es un error. */
function rawAs(
  host: string,
  p: string,
  opts: { method?: string; body?: unknown; bearer?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: API_PORT,
        path: p,
        method: opts.method ?? 'GET',
        headers: {
          Host: host,
          'content-type': 'application/json',
          ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
          ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
        },
      },
      (res) => {
        let txt = '';
        res.on('data', (c) => (txt += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: txt ? JSON.parse(txt) : {} }),
        );
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function newPage(browser: Browser, tenant: FreshTenant): Promise<Page> {
  const ctx = await browser.newContext({
    locale: 'es-ES',
    viewport: { width: 1280, height: 900 },
    baseURL: tenant.base,
  });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  return ctx.newPage();
}

async function signinPage(page: Page, email: string, password: string) {
  await page.goto('/signin');
  await page.locator('input[autocomplete="email"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
}

async function operatorToken(tenant: FreshTenant): Promise<string> {
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
  return tokens.accessToken;
}

/**
 * Cierra el asistente de puesta en marcha del aula (`/welcome`) y el
 * onboarding de perfil del operador: sin esto, en modo completo el panel
 * manda a la creadora al asistente (como `completeAcademyOnboarding`).
 */
async function aulaPuestaEnMarcha(tenant: FreshTenant, bearer: string): Promise<void> {
  await apiAs(tenant.host, '/api/v1/tenant-settings/onboarding/academy', {
    method: 'PUT',
    bearer,
    body: {
      value: {
        step: 'resumen',
        done: ['nombre', 'marca'],
        skipped: ['curso', 'alumnos', 'cobros', 'correo'],
        completedAt: new Date().toISOString(),
      },
      isSecret: false,
    },
  });
  sql(
    `UPDATE "user" SET onboarding_completed_at = now() WHERE email = 'operador@${tenant.slug}.test'`,
  );
}

/** Curso publicado con una lección de texto. */
async function crearCurso(
  tenant: FreshTenant,
  bearer: string,
  title: string,
  stamp: string,
): Promise<string> {
  const course = await apiAs<{ id: string }>(tenant.host, '/api/v1/modules/courses', {
    method: 'POST',
    bearer,
    body: {
      title,
      slug: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stamp}`,
      description: `Curso ${title}.`,
      category: 'general',
    },
  });
  const mod = await apiAs<{ id: string }>(
    tenant.host,
    `/api/v1/modules/courses/${course.id}/modules`,
    { method: 'POST', bearer, body: { title: 'Primeros pasos', orderIndex: 0 } },
  );
  await apiAs(tenant.host, `/api/v1/modules/courses/modules/${mod.id}/lessons`, {
    method: 'POST',
    bearer,
    body: {
      title: 'Lección 1',
      type: 'TEXT',
      orderIndex: 0,
      content: { text: 'Hola.' },
      durationSec: 60,
    },
  });
  await apiAs(tenant.host, `/api/v1/modules/courses/${course.id}/publish`, {
    method: 'POST',
    bearer,
  });
  return course.id;
}

interface AdminTier {
  id: string;
  name: string;
  isFree: boolean;
  allCourses: boolean;
  courseIds: string[];
  accessGroupId: string | null;
  plans: Array<{ id: string; name: string; amountCents: number; intervalMonths: number }>;
}

interface MySub {
  id: string;
  planId: string | null;
  tierName?: string | null;
  status: string;
  unitAmount: number;
}

test('niveles: Básico, Pro y Gratis; subir y bajar con prorrateo; cada uno ve lo suyo', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const stamp = Date.now().toString(36);
  const tenant = await freshTenant(`niveles${stamp}`, false);
  const operador = `operador@${tenant.slug}.test`;
  const bearer = await operatorToken(tenant);
  await aulaPuestaEnMarcha(tenant, bearer);
  const tenantId = sql(`SELECT id FROM tenant WHERE slug = '${tenant.slug}'`);

  const cursoA = await crearCurso(tenant, bearer, 'Guitarra desde cero', stamp);
  const cursoB = await crearCurso(tenant, bearer, 'Improvisacion avanzada', stamp);
  const cursoL = await crearCurso(tenant, bearer, 'Primeros acordes', stamp);
  await apiAs(tenant.host, '/api/v1/membership/admin/config', {
    method: 'PUT',
    bearer,
    body: { active: true },
  });

  // ── 1. La creadora crea los niveles en Membresía ─────────────────────────
  const creadora = await newPage(browser, tenant);
  await signinPage(creadora, operador, tenant.password);
  await creadora.goto('/admin/membership');
  const editor = creadora.getByTestId('niveles-editor');
  await expect(editor).toBeVisible({ timeout: 30_000 });

  async function nivelDePago(nombre: string, cursos: string[]) {
    await creadora.getByTestId('nivel-nuevo').click();
    await creadora.locator('#nivel-nombre').fill(nombre);
    await creadora.locator('#nivel-descripcion').fill(`Lo que incluye ${nombre}.`);
    await creadora.getByTestId('nivel-elegir-cursos').check();
    for (const c of cursos) await creadora.getByTestId(`nivel-curso-${c}`).check();
    await creadora.getByTestId('nivel-guardar').click();
    await expect(editor.locator(`[data-tier-name="${nombre}"]`)).toBeVisible({ timeout: 15_000 });
  }
  async function tiers(): Promise<AdminTier[]> {
    return (
      await apiAs<{ tiers: AdminTier[] }>(tenant.host, '/api/v1/membership/admin/tiers', {
        bearer,
      })
    ).tiers;
  }
  async function precioMensual(tierId: string, euros: string) {
    await creadora.getByTestId(`nivel-plan-nuevo-${tierId}`).click();
    await creadora.locator('#nivel-plan-intervalo').selectOption('1');
    await creadora.locator('#nivel-plan-precio').fill(euros);
    await creadora.getByTestId('nivel-plan-guardar').click();
    await expect
      .poll(async () => (await tiers()).find((t) => t.id === tierId)?.plans.length, {
        timeout: 15_000,
      })
      .toBe(1);
  }

  await nivelDePago('Básico', [cursoA]);
  await nivelDePago('Pro', [cursoA, cursoB]);
  let lista = await tiers();
  const basico = lista.find((t) => t.name === 'Básico')!;
  const pro = lista.find((t) => t.name === 'Pro')!;
  await precioMensual(basico.id, '10');
  await precioMensual(pro.id, '30');

  await creadora.getByTestId('nivel-gratis-nuevo').click();
  await creadora.locator('#nivel-nombre').fill('Gratis');
  await creadora.getByTestId('nivel-elegir-cursos').check();
  await creadora.getByTestId(`nivel-curso-${cursoL}`).check();
  await creadora.getByTestId('nivel-guardar').click();
  await expect(editor.locator('[data-tier-name="Gratis"]')).toBeVisible({ timeout: 15_000 });
  await expect(creadora.getByTestId('nivel-gratis-registro')).toHaveAttribute('data-open', 'true');
  await shot(creadora, '01-creadora-niveles');

  lista = await tiers();
  const gratis = lista.find((t) => t.isFree)!;
  expect(lista.find((t) => t.id === basico.id)!.courseIds).toEqual([cursoA]);
  expect([...lista.find((t) => t.id === pro.id)!.courseIds].sort()).toEqual(
    [cursoA, cursoB].sort(),
  );
  expect(gratis.courseIds).toEqual([cursoL]);
  const planBasico = lista.find((t) => t.id === basico.id)!.plans[0]!;
  const planPro = lista.find((t) => t.id === pro.id)!.plans[0]!;
  expect(planBasico.amountCents).toBe(1000);
  expect(planPro.amountCents).toBe(3000);
  // Cada nivel es un grupo de acceso propio; el gratis, el de las altas aprobadas.
  expect(new Set(lista.map((t) => t.accessGroupId)).size).toBe(3);
  expect(
    sql(
      `SELECT is_default_for_approval FROM mod_access_groups_group WHERE id = '${gratis.accessGroupId}'`,
    ),
  ).toBe('t');

  // Lectura pública de niveles (la usa la restricción de espacios y directos).
  const publicTiers = await apiAs<{ tiers: Array<Record<string, unknown>> }>(
    tenant.host,
    '/api/v1/membership/tiers',
  );
  expect(publicTiers.tiers).toEqual(
    expect.arrayContaining([
      { id: basico.id, name: 'Básico', accessGroupId: basico.accessGroupId, isFree: false },
      { id: gratis.id, name: 'Gratis', accessGroupId: gratis.accessGroupId, isFree: true },
    ]),
  );

  // ── 2. /join: una tarjeta por nivel con lo que incluye ───────────────────
  const visita = await newPage(browser, tenant);
  await visita.goto('/join');
  await expect(visita.getByTestId('niveles-join')).toBeVisible({ timeout: 30_000 });
  await expect(visita.getByTestId(`nivel-incluye-${basico.id}`)).toContainText(
    'Guitarra desde cero',
  );
  await expect(visita.getByTestId(`nivel-incluye-${basico.id}`)).not.toContainText(
    'Improvisacion avanzada',
  );
  await expect(visita.getByTestId(`nivel-incluye-${pro.id}`)).toContainText(
    'Improvisacion avanzada',
  );
  await expect(visita.getByTestId(`nivel-card-${pro.id}`)).toContainText('30');
  await expect(visita.getByTestId('nivel-gratis-entrar')).toHaveAttribute(
    'href',
    /\/member-registration/,
  );
  await shot(visita, '02-join-por-niveles');

  // ── 3. Ana compra Básico → ve A y no B ──────────────────────────────────
  const anaEmail = `ana.${stamp}@example.com`;
  const ana = await apiAs<{ tokens: { accessToken: string } }>(tenant.host, '/api/v1/auth/signup', {
    method: 'POST',
    body: { tenantSlug: tenant.slug, email: anaEmail, password: PASSWORD, name: 'Ana Prueba' },
  });
  sql(`UPDATE "user" SET onboarding_completed_at = now() WHERE email = '${anaEmail}'`);
  const anaToken = ana.tokens.accessToken;
  const subId = `sub_niveles_${stamp}`;
  expect(
    await sendSubscriptionsWebhook(tenant.host, {
      id: `evt_${stamp}_alta`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_niveles_${stamp}`,
          object: 'checkout.session',
          payment_status: 'paid',
          metadata: { membership: '1', tenantId, planId: planBasico.id },
          subscription: subId,
          customer: `cus_niveles_${stamp}`,
          customer_email: null,
          customer_details: { email: anaEmail, name: 'Ana Prueba' },
        },
      },
    }),
  ).toBe(200);
  // En Stripe: la línea con el precio de Básico, a mitad del periodo.
  const now = Math.floor(Date.now() / 1000);
  stripe.setSubscription(subId, {
    customer: `cus_niveles_${stamp}`,
    current_period_start: now - 10 * DAY,
    current_period_end: now + 20 * DAY,
    metadata: { membership: '1', tenantId, planId: planBasico.id },
    items: {
      object: 'list',
      data: [
        {
          id: `si_niveles_${stamp}`,
          price: {
            id: `price_basico_${stamp}`,
            unit_amount: 1000,
            currency: 'eur',
            recurring: { interval: 'month', interval_count: 1 },
          },
        },
      ],
    },
  });

  const subDeAna = async () =>
    (
      await apiAs<{ subscriptions: MySub[] }>(tenant.host, '/api/v1/modules/subscriptions/me', {
        bearer: anaToken,
      })
    ).subscriptions.find((s) => s.planId !== null);
  const matriculas = async () =>
    new Map(
      (
        await apiAs<Array<{ courseId: string; status: string }>>(
          tenant.host,
          '/api/v1/modules/learning/me/enrollments',
          { bearer: anaToken },
        )
      ).map((e) => [e.courseId, e.status]),
    );
  await expect.poll(async () => (await subDeAna())?.status, { timeout: 20_000 }).toBe('ACTIVE');
  await expect
    .poll(async () => (await matriculas()).get(cursoA), { timeout: 20_000 })
    .toBe('ACTIVE');
  expect((await matriculas()).get(cursoB)).toBeUndefined();
  expect((await subDeAna())?.tierName).toBe('Básico');

  // ── 4. Ana sube a Pro desde su cuenta ───────────────────────────────────
  const pAna = await newPage(browser, tenant);
  await signinPage(pAna, anaEmail, PASSWORD);
  await pAna.goto('/account?tab=subscription');
  await expect(pAna.getByTestId('sub-nivel')).toContainText('Básico', { timeout: 30_000 });
  await pAna.getByTestId('sub-cambiar-plan').click();
  const dialogo = pAna.getByTestId('cambio-plan-dialogo');
  await expect(dialogo).toBeVisible();
  await pAna.getByTestId(`cambio-plan-opcion-${planPro.id}`).click();
  // (30 € − 10 €) × 20 de 30 días que quedan = 13,33 €.
  await expect(pAna.getByTestId('cambio-plan-resumen')).toContainText(
    /Hoy se te cobrarán 13,3\d\s€/,
    { timeout: 15_000 },
  );
  await shot(pAna, '03-alumna-vista-previa-subir');
  await pAna.getByTestId('cambio-plan-confirmar').click();
  await expect(pAna.getByTestId('cambio-plan-ok')).toBeVisible({ timeout: 20_000 });
  await shot(pAna, '04-alumna-ya-en-pro');

  const cambioSubir = stripe.calls.filter(
    (c) =>
      c.method === 'POST' && c.path === `/v1/subscriptions/${subId}` && c.body['items[0][price]'],
  );
  expect(cambioSubir).toHaveLength(1);
  expect(cambioSubir[0]!.body['proration_behavior']).toBe('always_invoice');
  expect(cambioSubir[0]!.body['payment_behavior']).toBe('error_if_incomplete');
  expect(cambioSubir[0]!.body['metadata[planId]']).toBe(planPro.id);
  expect((await subDeAna())?.planId).toBe(planPro.id);
  expect((await subDeAna())?.unitAmount).toBe(3000);
  await expect
    .poll(async () => (await matriculas()).get(cursoB), { timeout: 20_000 })
    .toBe('ACTIVE');
  expect((await matriculas()).get(cursoA)).toBe('ACTIVE');

  // Stripe avisa después: la factura de la diferencia y la suscripción
  // cambiada. Ni se duplica el cambio ni se pierde la factura.
  const factura = stripe.subscription(subId)['latest_invoice'] as Record<string, unknown>;
  expect(factura['amount_paid']).toBeGreaterThan(1300);
  expect(
    await sendSubscriptionsWebhook(tenant.host, {
      id: `evt_${stamp}_factura_subir`,
      object: 'event',
      type: 'invoice.paid',
      data: { object: { ...factura, created: now, period_start: now, period_end: now } },
    }),
  ).toBe(200);
  expect(
    await sendSubscriptionsWebhook(tenant.host, {
      id: `evt_${stamp}_sub_subir`,
      object: 'event',
      type: 'customer.subscription.updated',
      data: { object: stripe.subscription(subId) },
    }),
  ).toBe(200);
  const anaSub = (await subDeAna())!;
  const facturas = await apiAs<{ invoices: Array<{ stripeInvoiceId: string; amount: number }> }>(
    tenant.host,
    `/api/v1/modules/subscriptions/me/${anaSub.id}/invoices`,
    { bearer: anaToken },
  );
  expect(facturas.invoices.map((i) => i.stripeInvoiceId)).toContain(factura['id']);
  expect(
    sql(
      `SELECT count(*) FROM outbox_event WHERE tenant_id = '${tenantId}' ` +
        `AND event_name = 'subscriptions.membership.plan_changed' ` +
        `AND payload->>'subscriptionId' = '${anaSub.id}'`,
    ),
  ).toBe('1');

  // ── 5. Ana baja a Básico: B se cierra, A sigue ──────────────────────────
  const bajar = await rawAs(tenant.host, '/api/v1/modules/subscriptions/me/membership/change', {
    method: 'POST',
    bearer: anaToken,
    body: { planId: planBasico.id },
  });
  expect(bajar.status).toBe(200);
  expect(bajar.body['direction']).toBe('downgrade');
  expect(bajar.body['charged']).toBeNull();
  const cambioBajar = stripe.calls.filter(
    (c) =>
      c.method === 'POST' && c.path === `/v1/subscriptions/${subId}` && c.body['items[0][price]'],
  );
  expect(cambioBajar).toHaveLength(2);
  expect(cambioBajar[1]!.body['proration_behavior']).toBe('create_prorations');
  await expect
    .poll(async () => (await matriculas()).get(cursoB), { timeout: 20_000 })
    .not.toBe('ACTIVE');
  expect((await matriculas()).get(cursoA)).toBe('ACTIVE');
  expect((await subDeAna())?.planId).toBe(planBasico.id);

  // ── 6. La tarjeta falla al subir: 402 y no cambia nada ──────────────────
  stripe.failNextPriceChange();
  const fallo = await rawAs(tenant.host, '/api/v1/modules/subscriptions/me/membership/change', {
    method: 'POST',
    bearer: anaToken,
    body: { planId: planPro.id },
  });
  expect(fallo.status).toBe(402);
  expect(fallo.body['code']).toBe('MEMBERSHIP_PLAN_CHANGE_PAYMENT_FAILED');
  expect((await subDeAna())?.planId).toBe(planBasico.id);
  expect((await matriculas()).get(cursoB)).not.toBe('ACTIVE');

  // ── 7. Leo entra gratis: ve L y ni A ni B ───────────────────────────────
  const leoEmail = `leo.${stamp}@example.com`;
  const alta = await rawAs(tenant.host, '/api/v1/modules/member-registration/register', {
    method: 'POST',
    body: { name: 'Leo Prueba', email: leoEmail, password: PASSWORD },
  });
  expect(alta.status).toBe(201);
  const leoId = sql(`SELECT id FROM "user" WHERE email = '${leoEmail}'`);
  await apiAs(tenant.host, `/api/v1/modules/member-registration/admin/requests/${leoId}/decision`, {
    method: 'POST',
    bearer,
    body: { action: 'approve' },
  });
  sql(`UPDATE "user" SET onboarding_completed_at = now() WHERE email = '${leoEmail}'`);
  const leo = await apiAs<{ tokens: { accessToken: string } }>(tenant.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: tenant.slug, email: leoEmail, password: PASSWORD },
  });
  const matriculasLeo = new Map(
    (
      await apiAs<Array<{ courseId: string; status: string }>>(
        tenant.host,
        '/api/v1/modules/learning/me/enrollments',
        { bearer: leo.tokens.accessToken },
      )
    ).map((e) => [e.courseId, e.status]),
  );
  expect(matriculasLeo.get(cursoL)).toBe('ACTIVE');
  expect(matriculasLeo.get(cursoA)).toBeUndefined();
  expect(matriculasLeo.get(cursoB)).toBeUndefined();
  // Sin membresía de pago, en su cuenta no hay nada que cambiar.
  const opcionesLeo = await apiAs<{ blockedReason: string | null; options: unknown[] }>(
    tenant.host,
    '/api/v1/modules/subscriptions/me/membership/change-options',
    { bearer: leo.tokens.accessToken },
  );
  expect(opcionesLeo.blockedReason).toBe('no_membership');
});

test('aula SIN niveles: /join y la cuenta siguen como siempre', async ({ browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now().toString(36);
  const tenant = await freshTenant(`sinniveles${stamp}`, false);
  const bearer = await operatorToken(tenant);
  await aulaPuestaEnMarcha(tenant, bearer);
  const tenantId = sql(`SELECT id FROM tenant WHERE slug = '${tenant.slug}'`);
  const curso = await crearCurso(tenant, bearer, 'Curso de siempre', stamp);
  const group = await apiAs<{ id: string }>(tenant.host, '/api/v1/modules/access-groups', {
    method: 'POST',
    bearer,
    body: { name: 'Socios', kind: 'MULTI_COURSE', courseIds: [curso] },
  });
  await apiAs(tenant.host, '/api/v1/membership/admin/config', {
    method: 'PUT',
    bearer,
    body: { active: true, accessGroupId: group.id },
  });
  const plan = await apiAs<{ id: string; tierId: string | null }>(
    tenant.host,
    '/api/v1/membership/admin/plans',
    {
      method: 'POST',
      bearer,
      body: { name: 'Mensual', intervalMonths: 1, amountCents: 1900, currency: 'eur' },
    },
  );
  expect(plan.tierId).toBeNull();

  const page = await apiAs<{ tiers: unknown[]; plans: Array<{ id: string }> }>(
    tenant.host,
    '/api/v1/membership/page',
  );
  expect(page.tiers).toEqual([]);
  expect(page.plans.map((p) => p.id)).toEqual([plan.id]);

  const visita = await newPage(browser, tenant);
  await visita.goto('/join');
  await expect(visita.getByTestId('unete-pagar')).toBeVisible({ timeout: 30_000 });
  await expect(visita.getByTestId('niveles-join')).toHaveCount(0);

  // Una alumna con la membresía de siempre: el grupo de la configuración, y
  // en su cuenta no se ofrece cambiar de nivel.
  const email = `sofia.${stamp}@example.com`;
  const sofia = await apiAs<{ tokens: { accessToken: string } }>(
    tenant.host,
    '/api/v1/auth/signup',
    { method: 'POST', body: { tenantSlug: tenant.slug, email, password: PASSWORD, name: 'Sofía' } },
  );
  sql(`UPDATE "user" SET onboarding_completed_at = now() WHERE email = '${email}'`);
  expect(
    await sendSubscriptionsWebhook(tenant.host, {
      id: `evt_${stamp}_sin_niveles`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_sin_niveles_${stamp}`,
          object: 'checkout.session',
          payment_status: 'paid',
          metadata: { membership: '1', tenantId, planId: plan.id },
          subscription: `sub_sin_niveles_${stamp}`,
          customer: `cus_sin_niveles_${stamp}`,
          customer_email: null,
          customer_details: { email, name: 'Sofía' },
        },
      },
    }),
  ).toBe(200);
  await expect
    .poll(
      async () =>
        (
          await apiAs<Array<{ courseId: string; status: string }>>(
            tenant.host,
            '/api/v1/modules/learning/me/enrollments',
            { bearer: sofia.tokens.accessToken },
          )
        ).find((e) => e.courseId === curso)?.status,
      { timeout: 20_000 },
    )
    .toBe('ACTIVE');
  const opciones = await apiAs<{ options: unknown[]; blockedReason: string | null }>(
    tenant.host,
    '/api/v1/modules/subscriptions/me/membership/change-options',
    { bearer: sofia.tokens.accessToken },
  );
  expect(opciones.options).toEqual([]);
  const pSofia = await newPage(browser, tenant);
  await signinPage(pSofia, email, PASSWORD);
  await pSofia.goto('/account?tab=subscription');
  await expect(pSofia.getByTestId('sub-darme-de-baja')).toBeVisible({ timeout: 30_000 });
  await expect(pSofia.getByTestId('sub-cambiar-plan')).toHaveCount(0);
  await expect(pSofia.getByTestId('sub-nivel')).toHaveCount(0);
});

test('modo sencillo: en Ventas se crean niveles', async ({ browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now().toString(36);
  const tenant = await freshTenant(`ventasniveles${stamp}`, true);
  const bearer = await operatorToken(tenant);
  await apiAs(tenant.host, '/api/v1/admin/simple-mode/quick-start', {
    method: 'POST',
    bearer,
    body: {
      academyName: 'Taller de cerámica',
      offer: 'membership',
      title: 'Club del barro',
      amountCents: 2500,
      currency: 'eur',
      locale: 'es',
    },
  });
  const curso = await crearCurso(tenant, bearer, 'Torno basico', stamp);

  const page = await newPage(browser, tenant);
  await signinPage(page, `operador@${tenant.slug}.test`, tenant.password);
  await page.goto('/admin/membership');
  await expect(page.getByTestId('ventas-sencillo')).toBeVisible({ timeout: 30_000 });
  const editor = page.getByTestId('niveles-editor');
  await expect(editor).toBeVisible();
  await page.getByTestId('nivel-nuevo').click();
  await page.locator('#nivel-nombre').fill('Socio');
  await page.getByTestId('nivel-elegir-cursos').check();
  await page.getByTestId(`nivel-curso-${curso}`).check();
  await page.getByTestId('nivel-guardar').click();
  await expect(editor.locator('[data-tier-name="Socio"]')).toBeVisible({ timeout: 15_000 });
  await shot(page, '05-sencillo-ventas-niveles');

  // El primer nivel de un aula que ya vendía se queda con su precio de siempre.
  const { tiers, legacyPlanCount } = await apiAs<{
    tiers: AdminTier[];
    legacyPlanCount: number;
  }>(tenant.host, '/api/v1/membership/admin/tiers', { bearer });
  expect(legacyPlanCount).toBe(0);
  expect(tiers).toHaveLength(1);
  expect(tiers[0]!.plans.map((p) => p.amountCents)).toEqual([2500]);
  expect(tiers[0]!.courseIds).toEqual([curso]);
});
