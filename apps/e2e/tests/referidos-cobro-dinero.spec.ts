/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { apiAs, freshTenant, sql } from '../helpers/simple-tenant';
import { startStripeDouble, type StripeDouble } from '../helpers/stripe-double';

/**
 * Puntos legales de referidos (ADR-057), de punta a punta en un aula en modo
 * sencillo:
 *
 *  1. La alumna abre «Invita y gana» por primera vez: marca «Declaro que soy
 *     mayor de 18 años y acepto las condiciones del programa» y activa su
 *     enlace. La casilla enlaza a las condiciones públicas del aula.
 *  2. Con lo ganado ya confirmado, pide el cobro EN DINERO dando su nombre,
 *     su NIF y su IBAN.
 *  3. La creadora lo ve en Ventas con lo necesario para pagar, lo marca
 *     pagado con la referencia de la transferencia y descarga el justificante
 *     en PDF (nº 0001 del aula).
 *  4. La alumna descarga el mismo justificante desde «Invita y gana».
 *
 * La comisión confirmada se siembra (es lo que deja una venta con enlace tras
 * los 14 días de garantía; la venta en sí la recorre `referidos-compra-curso`).
 */

// El precio del curso se crea en el doble de Stripe (nunca en Stripe).
let stripe: StripeDouble;
test.beforeAll(async () => {
  stripe = await startStripeDouble();
});
test.afterAll(async () => {
  await stripe?.close();
});

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

test('referidos: casilla de mayor de 18, cobro en dinero con datos, pago y justificante', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const tenant = await freshTenant(`cobro${Date.now().toString(36)}`, true);
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
  // Programa encendido con un mínimo de cobro de 10 €.
  await apiAs(tenant.host, '/api/v1/modules/referrals/admin/config', {
    method: 'PUT',
    bearer,
    body: { active: true, minPayoutCents: 1000 },
  });
  // Un curso a la venta, para que el enlace lleve a una página que vende.
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
  const moduleId = sql(
    `SELECT id FROM mod_courses_module WHERE course_id = '${alta.offer.courseId}' ORDER BY created_at LIMIT 1`,
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
  await apiAs(tenant.host, '/api/v1/admin/simple-mode/publish', {
    method: 'POST',
    bearer,
    body: {},
  });

  const alumnaEmail = `alumna@${tenant.slug}.test`;
  await apiAs(tenant.host, '/api/v1/admin/users', {
    method: 'POST',
    bearer,
    body: { email: alumnaEmail, role: 'alumno' },
  });
  sql(
    `UPDATE "user" SET name = 'Lucía Pérez', onboarding_completed_at = now() WHERE email = '${alumnaEmail}'`,
  );
  const token = `${Date.now().toString(36)}${'b'.repeat(40)}`;
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
      acceptDownloads: true,
    });
    await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
    return ctx;
  };

  // ── 1. La casilla ───────────────────────────────────────────────────────
  const alumnaCtx = await nuevo();
  const alumna = await alumnaCtx.newPage();
  await entrar(
    alumna,
    `${tenant.base}/reset-password?token=${token}`,
    alumnaEmail,
    'AlumnaCobra123!',
  );
  await alumna.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
  await alumna.goto('/referidos');
  const casilla = alumna.getByTestId('referidos-casilla');
  await expect(casilla).toBeVisible({ timeout: 30_000 });
  await expect(alumna.getByTestId('referidos-enlace')).toHaveCount(0);
  // Enlaza a las condiciones públicas del aula.
  await expect(casilla.getByRole('link', { name: 'Leer las condiciones' })).toHaveAttribute(
    'href',
    '/condiciones-referidos',
  );
  const activar = casilla.getByRole('button', { name: 'Activar mi enlace' });
  await expect(activar).toBeDisabled();
  await casilla.getByRole('checkbox').check();
  await activar.click();
  await expect(alumna.getByTestId('referidos-enlace')).toContainText('ref=', { timeout: 30_000 });
  expect(
    sql(
      `SELECT m.terms_version FROM mod_referrals_member m JOIN "user" u ON u.id = m.user_id WHERE u.email = '${alumnaEmail}'`,
    ),
  ).toBe('2026-11-13');

  // Las condiciones públicas se leen sin sesión, con las cifras del aula.
  const anonCtx = await nuevo();
  const anon = await anonCtx.newPage();
  await anon.goto('/condiciones-referidos');
  const condiciones = anon.getByTestId('condiciones-referidos');
  await expect(condiciones).toContainText('mayor de 18 años', { timeout: 30_000 });
  await expect(condiciones).toContainText('80 %');
  await expect(condiciones).toContainText('30 días');

  // ── 2. Lo ganado ya confirmado (venta con enlace pasada la garantía) ────
  const tid = sql(`SELECT id FROM tenant WHERE slug = '${tenant.slug}'`);
  const alumnaId = sql(`SELECT id FROM "user" WHERE email = '${alumnaEmail}'`);
  const compradorId = sql(`SELECT id FROM "user" WHERE email = '${operador}'`);
  const referralId = sql(
    `INSERT INTO mod_referrals_referral (id, tenant_id, referrer_user_id, referred_user_id, code) ` +
      `VALUES (gen_random_uuid(), '${tid}', '${alumnaId}', '${compradorId}', 'e2ecobro') RETURNING id`,
  )
    .split('\n')[0]!
    .trim();
  sql(
    `INSERT INTO mod_referrals_commission (id, tenant_id, referral_id, referrer_user_id, stripe_invoice_id, base_amount_cents, amount_cents, currency, commission_bps, status, approve_after, approved_at, updated_at) ` +
      `VALUES (gen_random_uuid(), '${tid}', '${referralId}', '${alumnaId}', 'order:e2e-cobro-${tenant.slug}', 4900, 1470, 'eur', 3000, 'APPROVED', now() - interval '1 day', now(), now())`,
  );

  await alumna.reload();
  const cobro = alumna.getByTestId('referidos-cobro');
  await expect(cobro).toContainText(/14,70\s€ confirmados/, { timeout: 30_000 });
  const form = cobro.getByTestId('referidos-cobro-form');
  await form.getByLabel('Nombre y apellidos').fill('Lucía Pérez Gil');
  await form.getByLabel('NIF o NIE').fill('12345678Z');
  await form.getByLabel('Cuenta (IBAN)').fill('ES91 2100 0418 4502 0005 1332');
  await form.getByRole('button', { name: 'Guardar y pedir el cobro' }).click();
  await expect(cobro).toContainText(/Has pedido 14,70\s€/, { timeout: 30_000 });
  // Lo que ve la alumna de sus datos: enmascarado.
  await expect(cobro).toContainText('ES•• •••• 1332');
  await expect(cobro).not.toContainText('ES9121000418450200051332');

  // ── 3. La creadora paga y descarga el justificante ─────────────────────
  const creadoraCtx = await nuevo();
  const creadora = await creadoraCtx.newPage();
  await creadora.goto('/signin');
  await creadora.locator('input[autocomplete="email"]').fill(operador);
  await creadora.locator('input[autocomplete="current-password"]').fill(tenant.password);
  await creadora.locator('button[type="submit"]').click();
  await creadora.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
  await creadora.goto('/admin/membresia');
  const pedido = creadora.getByTestId('cobro-pedido');
  await expect(pedido).toContainText('Lucía Pérez Gil', { timeout: 30_000 });
  await expect(pedido).toContainText('ES91 2100 0418 4502 0005 1332');
  await expect(pedido).toContainText('12345678Z');
  await pedido.getByLabel('Referencia de la transferencia').fill('TRF-2026-0001');
  await pedido.getByRole('button', { name: 'Marcar como pagado' }).click();
  const boton = creadora.getByTestId('ventas-justificante');
  await expect(boton).toContainText('0001', { timeout: 30_000 });
  const [descarga] = await Promise.all([creadora.waitForEvent('download'), boton.click()]);
  expect(descarga.suggestedFilename()).toBe('justificante-0001.pdf');
  const pdf = readFileSync((await descarga.path())!);
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

  // ── 4. La alumna descarga el suyo ──────────────────────────────────────
  await alumna.reload();
  const suyo = alumna.getByTestId('referidos-justificante');
  await expect(suyo).toBeVisible({ timeout: 30_000 });
  const [descargaAlumna] = await Promise.all([alumna.waitForEvent('download'), suyo.click()]);
  expect(descargaAlumna.suggestedFilename()).toBe('justificante-0001.pdf');

  await Promise.all([alumnaCtx.close(), anonCtx.close(), creadoraCtx.close()]);
});
