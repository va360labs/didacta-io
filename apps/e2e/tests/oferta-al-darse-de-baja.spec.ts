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
 * OFERTA AL DARSE DE BAJA, de punta a punta en un aula nueva de modo sencillo
 * («Primer Sorbo») que cobra con claves propias (modo `own`) contra el doble
 * de Stripe:
 *
 *  1. La creadora enciende en Ajustes → «Cuando alguien quiere irse» la pausa
 *     (hasta 3 meses) y un 30 % durante 3 meses.
 *  2. Tres alumnas con la membresía mensual pulsan «Darme de baja»:
 *     - Lucía (no tiene tiempo) PAUSA 2 meses → Stripe recibe
 *       `pause_collection` hasta un día antes del primer cobro. Cuando llega la
 *       renovación (webhook firmado) la suscripción pasa a «En pausa» y pierde
 *       el acceso al curso; con el cobro tras la pausa, vuelve.
 *     - Marcos (le sale caro) se queda con el DESCUENTO → cupón de un solo uso
 *       aplicado a su suscripción; no puede volver a usarlo.
 *     - Elena (faltan temas) se DA DE BAJA → al final del periodo, con su
 *       motivo y su texto.
 *  3. En Alumnos, la creadora ve «2 de 3 se quedaron» y los motivos.
 *
 * Con cobros de plataforma (Stripe Connect) el mismo recorrido se ha probado
 * contra Stripe en modo prueba (relojes de prueba, ledger y transferencias):
 * el arnés no arranca la API en ese modo. Lo que calcula la API lo fijan sus
 * tests (`retention.service.test.ts`, `subscriptions.service.test.ts`,
 * `platform-membership.test.ts`).
 *
 * `E2E_CAPTURAS=<carpeta>` guarda capturas; `E2E_MAILPIT_API=<url>` comprueba
 * además los tres correos de confirmación.
 */

const CAPTURAS = process.env.E2E_CAPTURAS;
const MAILPIT = process.env.E2E_MAILPIT_API;
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

interface MySub {
  id: string;
  planId: string | null;
  status: string;
  stripeSubscriptionId: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  pauseStartsAt: string | null;
  pauseEndsAt: string | null;
  retentionDiscount: { percent: number; months: number | null } | null;
}

interface Alumna {
  name: string;
  email: string;
  token: string;
  stripeSubId: string;
}

/** +N meses sin desbordar (31 ene + 1 = 28 feb), como los ciclos de Stripe. */
function addMonthsUtc(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
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

test('oferta al darse de baja: pausa, descuento y baja con motivo; resumen para la creadora', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const stamp = Date.now().toString(36);
  const tenant = await freshTenant(`primersorbo${stamp}`, true);
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
  sql(`UPDATE "user" SET name = 'Clara Barista' WHERE email = '${operador}'`);

  // ── Aula: membresía mensual de 29 € con un curso dentro ──────────────────
  const alta = await apiAs<{ offer: { planId: string } }>(
    tenant.host,
    '/api/v1/admin/simple-mode/quick-start',
    {
      method: 'POST',
      bearer,
      body: {
        academyName: 'Primer Sorbo',
        offer: 'membership',
        title: 'Club del café',
        amountCents: 2900,
        currency: 'eur',
        locale: 'es',
      },
    },
  );
  const planId = alta.offer.planId;
  await apiAs(tenant.host, '/api/v1/admin/simple-mode/publish', {
    method: 'POST',
    bearer,
    body: {},
  });
  const course = await apiAs<{ id: string }>(tenant.host, '/api/v1/modules/courses', {
    method: 'POST',
    bearer,
    body: {
      title: 'Espresso en casa',
      slug: `espresso-en-casa-${stamp}`,
      description: 'Molienda, dosis y tiempo.',
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
      title: 'La molienda',
      type: 'TEXT',
      orderIndex: 0,
      content: { text: 'Fina como la sal.' },
      durationSec: 60,
    },
  });
  await apiAs(tenant.host, `/api/v1/modules/courses/${course.id}/publish`, {
    method: 'POST',
    bearer,
  });
  const group = await apiAs<{ id: string }>(tenant.host, '/api/v1/modules/access-groups', {
    method: 'POST',
    bearer,
    body: { name: 'Club del café', kind: 'MULTI_COURSE', courseIds: [course.id] },
  });
  await apiAs(tenant.host, '/api/v1/membership/admin/config', {
    method: 'PUT',
    bearer,
    body: { accessGroupId: group.id },
  });

  // ── 1. La creadora configura «Cuando alguien quiere irse» ────────────────
  const creadora = await newPage(browser, tenant);
  await signinPage(creadora, operador, tenant.password);
  await creadora.goto('/admin/settings');
  const ajustes = creadora.getByTestId('retencion-ajustes');
  await expect(ajustes).toBeVisible({ timeout: 30_000 });
  await expect(ajustes).toContainText('Cuando alguien quiere irse');
  await creadora.getByTestId('retencion-pausa').click();
  await creadora.locator('#retencion-pausa-max').selectOption('3');
  await creadora.getByTestId('retencion-descuento').click();
  await creadora.locator('#retencion-pct').selectOption('30');
  await creadora.locator('#retencion-meses').selectOption('3');
  await creadora.getByTestId('retencion-guardar').click();
  await expect(ajustes.getByText('Oferta guardada')).toBeVisible({ timeout: 15_000 });
  await ajustes.scrollIntoViewIfNeeded();
  await shot(creadora, '01-ajustes-cuando-alguien-quiere-irse');
  const guardada = await apiAs<Record<string, unknown>>(
    tenant.host,
    '/api/v1/membership/admin/retention',
    { bearer },
  );
  expect(guardada).toEqual({
    pauseEnabled: true,
    pauseMaxMonths: 3,
    discountEnabled: true,
    discountPercent: 30,
    discountMonths: 3,
  });

  // ── 2. Tres alumnas con la membresía pagada ─────────────────────────────
  const tenantId = sql(`SELECT id FROM tenant WHERE slug = '${tenant.slug}'`);
  async function alumna(name: string, local: string, n: number): Promise<Alumna> {
    const email = `${local}.${stamp}@example.com`;
    const created = await apiAs<{ tokens: { accessToken: string } }>(
      tenant.host,
      '/api/v1/auth/signup',
      { method: 'POST', body: { tenantSlug: tenant.slug, email, password: PASSWORD, name } },
    );
    sql(`UPDATE "user" SET onboarding_completed_at = now() WHERE email = '${email}'`);
    const stripeSubId = `sub_e2e_${stamp}_${n}`;
    const status = await sendSubscriptionsWebhook(tenant.host, {
      id: `evt_${stamp}_${n}_checkout`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_e2e_${stamp}_${n}`,
          object: 'checkout.session',
          payment_status: 'paid',
          metadata: { membership: '1', tenantId, planId },
          subscription: stripeSubId,
          customer: `cus_e2e_${stamp}_${n}`,
          customer_email: null,
          customer_details: { email, name },
        },
      },
    });
    expect(status, `alta de ${name}`).toBe(200);
    return { name, email, token: created.tokens.accessToken, stripeSubId };
  }
  const lucia = await alumna('Lucía Prueba', 'lucia', 1);
  const marcos = await alumna('Marcos Prueba', 'marcos', 2);
  const elena = await alumna('Elena Prueba', 'elena', 3);

  const subOf = async (a: Alumna) =>
    (
      await apiAs<{ subscriptions: MySub[] }>(tenant.host, '/api/v1/modules/subscriptions/me', {
        bearer: a.token,
      })
    ).subscriptions.find((s) => s.planId === planId)!;
  for (const a of [lucia, marcos, elena]) {
    await expect.poll(async () => (await subOf(a))?.status, { timeout: 20_000 }).toBe('ACTIVE');
  }
  const enrollmentOf = async (a: Alumna) =>
    (
      await apiAs<Array<{ courseId: string; status: string }>>(
        tenant.host,
        '/api/v1/modules/learning/me/enrollments',
        { bearer: a.token },
      )
    ).find((e) => e.courseId === course.id)?.status;
  await expect.poll(() => enrollmentOf(lucia), { timeout: 20_000 }).toBe('ACTIVE');

  // ── 3. Lucía: no tiene tiempo → pausa 2 meses ───────────────────────────
  const periodEnd = stripe.subscription(lucia.stripeSubId)['current_period_end'] as number;
  const pLucia = await newPage(browser, tenant);
  await signinPage(pLucia, lucia.email, PASSWORD);
  await pLucia.goto('/account?tab=subscription');
  await pLucia.getByTestId('sub-darme-de-baja').click();
  const dialogo = pLucia.getByTestId('baja-dialogo');
  await expect(dialogo).toContainText('¿Por qué te quieres ir?', { timeout: 20_000 });
  await pLucia.getByTestId('baja-motivo-no_time').click();
  await pLucia.locator('#baja-texto').fill('Estoy de exámenes hasta febrero.');
  await shot(pLucia, '02-alumna-motivo');
  await pLucia.getByTestId('baja-seguir').click();
  await expect(pLucia.getByTestId('baja-oferta-pausa')).toBeVisible();
  await expect(pLucia.getByTestId('baja-oferta-descuento')).toContainText(
    /Tus próximos 3 pagos serán de 20,30\s€ en vez de 29,00\s€/,
  );
  await pLucia.getByTestId('baja-pausa-2').click();
  await shot(pLucia, '03-alumna-oferta-pausa-o-descuento');
  await pLucia.getByTestId('baja-pausar').click();
  await expect(pLucia.getByTestId('baja-listo')).toContainText('queda en pausa del', {
    timeout: 20_000,
  });
  await shot(pLucia, '04-alumna-pausa-confirmada');
  await pLucia.getByTestId('baja-dialogo').getByRole('button', { name: 'Cerrar' }).click();
  await expect(pLucia.getByTestId('sub-pausa-programada')).toBeVisible({ timeout: 20_000 });
  await shot(pLucia, '05-alumna-pausa-programada');

  // En «Stripe»: el cobro anula facturas hasta un día antes de 2 meses después
  // del fin de lo pagado; lo pagado no se toca.
  const pauseSub = stripe.subscription(lucia.stripeSubId);
  const expectedEnd = addMonthsUtc(new Date(periodEnd * 1000), 2);
  expect(pauseSub['pause_collection']).toEqual({
    behavior: 'void',
    resumes_at: Math.floor(expectedEnd.getTime() / 1000) - DAY,
  });
  const lSub = await subOf(lucia);
  expect(lSub.status).toBe('ACTIVE');
  expect(new Date(lSub.pauseStartsAt!).getTime()).toBe(periodEnd * 1000);
  expect(lSub.pauseEndsAt).toBe(expectedEnd.toISOString());
  expect(await enrollmentOf(lucia)).toBe('ACTIVE');

  // Llega la renovación (anulada por la pausa): «En pausa» y sin acceso.
  const renewal = await sendSubscriptionsWebhook(tenant.host, {
    id: `evt_${stamp}_renovacion`,
    object: 'event',
    type: 'customer.subscription.updated',
    data: {
      object: {
        ...pauseSub,
        current_period_start: periodEnd,
        current_period_end: periodEnd + 30 * DAY,
        customer: `cus_e2e_${stamp}_1`,
      },
    },
  });
  expect(renewal).toBe(200);
  await expect.poll(async () => (await subOf(lucia)).status, { timeout: 20_000 }).toBe('PAUSED');
  await expect.poll(() => enrollmentOf(lucia), { timeout: 20_000 }).not.toBe('ACTIVE');
  await pLucia.reload();
  await expect(pLucia.getByTestId('sub-en-pausa')).toBeVisible({ timeout: 20_000 });
  await expect(pLucia.getByText('En pausa', { exact: true }).first()).toBeVisible();
  await shot(pLucia, '06-alumna-en-pausa');

  // Primer cobro tras la pausa: vuelve el acceso.
  const resumed = await sendSubscriptionsWebhook(tenant.host, {
    id: `evt_${stamp}_cobro_tras_pausa`,
    object: 'event',
    type: 'invoice.paid',
    data: {
      object: {
        id: `in_e2e_${stamp}_vuelta`,
        object: 'invoice',
        subscription: lucia.stripeSubId,
        amount_paid: 2900,
        amount_due: 2900,
        currency: 'eur',
        created: Math.floor(expectedEnd.getTime() / 1000),
        billing_reason: 'subscription_cycle',
        period_start: periodEnd + 30 * DAY,
        period_end: Math.floor(expectedEnd.getTime() / 1000),
      },
    },
  });
  expect(resumed).toBe(200);
  await expect.poll(async () => (await subOf(lucia)).status, { timeout: 20_000 }).toBe('ACTIVE');
  await expect.poll(() => enrollmentOf(lucia), { timeout: 20_000 }).toBe('ACTIVE');

  // ── 4. Marcos: le sale caro → descuento ─────────────────────────────────
  const pMarcos = await newPage(browser, tenant);
  await signinPage(pMarcos, marcos.email, PASSWORD);
  await pMarcos.goto('/account?tab=subscription');
  await pMarcos.getByTestId('sub-darme-de-baja').click();
  await pMarcos.getByTestId('baja-motivo-too_expensive').click();
  await pMarcos.getByTestId('baja-seguir').click();
  await pMarcos.getByTestId('baja-descuento').click();
  await expect(pMarcos.getByTestId('baja-listo')).toContainText('30 % de descuento', {
    timeout: 20_000,
  });
  await shot(pMarcos, '07-alumno-descuento-aplicado');
  await pMarcos.getByTestId('baja-dialogo').getByRole('button', { name: 'Cerrar' }).click();
  await expect(pMarcos.getByTestId('sub-descuento')).toContainText('30 % de descuento', {
    timeout: 20_000,
  });
  const coupon = stripe.calls.filter((c) => c.method === 'POST' && c.path === '/v1/coupons');
  expect(coupon).toHaveLength(1);
  expect(coupon[0]!.body).toMatchObject({
    percent_off: '30',
    duration: 'repeating',
    duration_in_months: '3',
    max_redemptions: '1',
  });
  expect(stripe.subscription(marcos.stripeSubId)['discounts']).toHaveLength(1);
  // Una vez por persona: ya no se le ofrece y pedirlo da 409.
  const mSub = await subOf(marcos);
  expect(mSub.retentionDiscount).toMatchObject({ percent: 30, months: 3 });
  const offerAgain = await rawAs(tenant.host, `/api/v1/modules/subscriptions/me/${mSub.id}/leave`, {
    bearer: marcos.token,
  });
  expect(offerAgain.body['discount']).toBeNull();
  const again = await rawAs(tenant.host, `/api/v1/modules/subscriptions/me/${mSub.id}/leave`, {
    method: 'POST',
    bearer: marcos.token,
    body: { reason: 'too_expensive', choice: 'discount' },
  });
  expect(again.status).toBe(409);
  expect(again.body['code']).toBe('SUBSCRIPTIONS_RETENTION_ALREADY_USED');
  // Control: la suscripción de otra persona no existe para él.
  const ajena = await rawAs(
    tenant.host,
    `/api/v1/modules/subscriptions/me/${(await subOf(elena)).id}/leave`,
    { bearer: marcos.token },
  );
  expect(ajena.status).toBe(404);

  // ── 5. Elena: faltan temas → se da de baja ──────────────────────────────
  const pElena = await newPage(browser, tenant);
  await signinPage(pElena, elena.email, PASSWORD);
  await pElena.goto('/account?tab=subscription');
  await pElena.getByTestId('sub-darme-de-baja').click();
  await pElena.getByTestId('baja-motivo-missing_topics').click();
  await pElena.locator('#baja-texto').fill('Me gustaría un módulo de latte art.');
  await pElena.getByTestId('baja-seguir').click();
  await expect(pElena.getByTestId('baja-dialogo')).toContainText(
    'Si te das de baja, sigues teniendo acceso hasta el',
  );
  await pElena.getByTestId('baja-darme-de-baja').click();
  await expect(pElena.getByTestId('baja-listo')).toContainText('Tu baja está confirmada', {
    timeout: 20_000,
  });
  await shot(pElena, '08-alumna-baja-confirmada');
  expect(stripe.subscription(elena.stripeSubId)['cancel_at_period_end']).toBe(true);
  const eSub = await subOf(elena);
  expect(eSub.cancelAtPeriodEnd).toBe(true);
  expect(eSub.status).toBe('ACTIVE'); // conserva el acceso hasta el final del periodo pagado
  await pElena.getByTestId('baja-dialogo').getByRole('button', { name: 'Cerrar' }).click();
  await expect(pElena.getByTestId('sub-darme-de-baja')).toHaveCount(0);

  // ── 6. La creadora ve quién se quedó y por qué (Alumnos) ─────────────────
  await creadora.goto('/admin/users');
  const resumen = creadora.getByTestId('retencion-resumen');
  await expect(resumen).toBeVisible({ timeout: 30_000 });
  await expect(creadora.getByTestId('retencion-se-quedaron')).toHaveText('2 de 3 se quedaron');
  await expect(resumen).toContainText('1 en pausa · 1 con descuento · 1 se dio de baja');
  const motivos = creadora.getByTestId('retencion-motivos');
  await expect(motivos).toContainText('No tengo tiempo');
  await expect(motivos).toContainText('Me sale caro');
  await expect(motivos).toContainText('Faltan temas que me interesan');
  await expect(creadora.getByTestId('retencion-ultimas')).toContainText(
    '«Me gustaría un módulo de latte art.»',
  );
  await resumen.scrollIntoViewIfNeeded();
  await shot(creadora, '09-alumnos-quien-se-quiere-ir');

  // Las salidas guardadas, con lo ofrecido.
  expect(
    sql(
      `SELECT string_agg(outcome::text || ':' || reason || ':' || offered_pause || ':' || offered_discount, ',' ORDER BY created_at) FROM mod_subscriptions_exit WHERE tenant_id = '${tenantId}'`,
    ),
  ).toBe(
    'PAUSED:no_time:true:true,DISCOUNTED:too_expensive:true:true,CANCELED:missing_topics:true:true',
  );

  // ── 7. Correos de confirmación (si hay buzón de pruebas) ─────────────────
  if (MAILPIT) {
    for (const [a, subject] of [
      [lucia, 'Tu suscripción queda en pausa'],
      [marcos, 'Te quedas con un 30 % de descuento'],
      [elena, 'Tu baja está confirmada'],
    ] as const) {
      await expect
        .poll(
          async () => {
            const res = await fetch(
              `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${a.email}`)}`,
            );
            const json = (await res.json()) as { messages?: Array<{ Subject: string }> };
            return (json.messages ?? []).map((m) => m.Subject);
          },
          { timeout: 30_000 },
        )
        .toContain(subject);
    }
  }
});
