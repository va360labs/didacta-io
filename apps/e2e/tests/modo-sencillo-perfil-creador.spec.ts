/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { injectSession } from '../helpers/auth';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';

/**
 * MODO SENCILLO: el perfil de quien LLEVA la academia en su primer acceso.
 *
 * Tras definir su contraseña, la creadora pasa por el mismo paso de perfil que
 * el alumno (foto, nombre, bio, idioma, avisos) con textos que le hablan de
 * sus alumnos, ANTES del alta en 3 preguntas. La foto se puede dejar para
 * luego. Después su foto sale en la cabecera y junto a su post de bienvenida
 * en la comunidad, y ni el alta ni «Empieza aquí» vuelven a pedírsela.
 *
 * Controles: un alumno del MISMO aula ve los textos de alumno, y una sesión
 * ya abierta sin perfil también entra por el perfil, no por el alta.
 */

/** PNG de 96×96 con un degradado: una foto de perfil neutra, sin personas. */
function pngDegradado(): Buffer {
  const w = 96;
  const h = 96;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 40 + Math.round((x / w) * 160);
      raw[o + 1] = 120 + Math.round((y / h) * 80);
      raw[o + 2] = 200 - Math.round((x / w) * 60);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Enlace de «define tu contraseña» para un usuario ya creado (como el del correo). */
function enlaceDeContrasena(tenant: FreshTenant, email: string): string {
  const token = randomBytes(24).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  sql(
    `INSERT INTO password_reset_token (id, user_id, tenant_id, token_hash, expires_at, created_at) ` +
      `SELECT gen_random_uuid(), u.id, u.tenant_id, '${hash}', now() + interval '1 day', now() ` +
      `FROM "user" u JOIN tenant t ON t.id = u.tenant_id WHERE u.email = '${email}' AND t.slug = '${tenant.slug}'`,
  );
  return `${tenant.base}/reset-password?token=${token}`;
}

async function definirYEntrar(page: Page, url: string, email: string, password: string) {
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

/**
 * El panel «Hazlo más rápido con tu agente de IA» no tiene nada que hacer en
 * el primer acceso: ni la columna, ni la pestaña plegada, ni el botón de móvil.
 */
async function sinPanelDelAgente(page: Page) {
  await expect(page.getByTestId('agente-ia-panel')).toHaveCount(0);
  await expect(page.getByTestId('agente-ia-plegado')).toHaveCount(0);
  await expect(page.getByTestId('agente-ia-movil')).toHaveCount(0);
}

async function contextoEn(browser: import('@playwright/test').Browser, tenant: FreshTenant) {
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'en-US', url: tenant.base }]);
  return ctx;
}

function usuario(email: string, slug: string) {
  const [fila] = sql(
    `SELECT u.name || '|' || coalesce(u.avatar_url, '') || '|' || coalesce(u.bio, '') || '|' || ` +
      `coalesce(u.onboarding_completed_at::text, '') ` +
      `FROM "user" u JOIN tenant t ON t.id = u.tenant_id WHERE u.email = '${email}' AND t.slug = '${slug}'`,
  ).split('\n');
  const [name, avatarUrl, bio, completedAt] = (fila ?? '').split('|');
  return { name, avatarUrl, bio, completedAt };
}

test('modo sencillo: la creadora se presenta (foto, nombre, bio) antes del alta y su foto sale en la cabecera y la comunidad', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const tenant = await freshTenant(`perfil${Date.now().toString(36)}`, true);
  sql(`UPDATE "user" SET locale = 'en-US' WHERE email = '${tenant.creatorEmail}'`);
  const ctx = await contextoEn(browser, tenant);
  const page = await ctx.newPage();

  await definirYEntrar(page, tenant.setPasswordUrl, tenant.creatorEmail, tenant.password);

  // 1. Primero el perfil, no el alta. Textos de quien lleva la academia.
  await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
  await expect(
    page.getByRole('heading', { name: 'Introduce yourself to your students' }),
  ).toBeVisible();
  await expect(page.getByText('Before you set up your academy')).toBeVisible();
  // El nombre provisional del aula (su slug) no se le enseña.
  await expect(page.getByText(`Welcome to ${tenant.slug}`)).toHaveCount(0);
  await expect(page.getByText(/see it next to your posts/)).toBeVisible();
  // Es admin, pero el paso de perfil no es una pantalla de creación.
  await sinPanelDelAgente(page);

  // 2. Sin foto el botón la deja para luego; con foto, «Continue».
  await expect(page.getByRole('button', { name: 'Skip for now' })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'perfil.png',
    mimeType: 'image/png',
    buffer: pngDegradado(),
  });
  await expect(page.getByRole('button', { name: 'Change photo' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Skip for now' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue' }).click();

  // 3. Sus datos: nombre (obligatorio) y bio.
  await expect(
    page.getByText('This is how your students will see you in your community.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await page.getByLabel(/Profile name/).fill('Clara Fernhill');
  await page.getByLabel(/Bio/).fill('I teach watercolour from scratch.');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Your notifications' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  // 4. Resumen y a su academia.
  await expect(
    page.getByText('This is how your students will see you. Next up: your academy.'),
  ).toBeVisible();
  await expect(page.getByText('Clara Fernhill')).toBeVisible();
  await page.getByRole('button', { name: 'Continue to my academy' }).click();

  // 5. El alta en 3 preguntas no vuelve a pedir nada del perfil.
  await page.waitForURL(/\/welcome/, { timeout: 30_000 });
  await expect(page.getByText('Question 1 of 3')).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByLabel(/Profile name/)).toHaveCount(0);
  await sinPanelDelAgente(page);

  const yo = usuario(tenant.creatorEmail, tenant.slug);
  expect(yo.name).toBe('Clara Fernhill');
  expect(yo.bio).toBe('I teach watercolour from scratch.');
  expect(yo.avatarUrl).toMatch(/^\/api\/v1\/storage\/file\//);
  expect(yo.completedAt).not.toBe('');

  await page.getByLabel('Academy name').fill('Morning Pour');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('What is the course called?').fill('Latte art from scratch');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Price').fill('49');
  await page.getByRole('button', { name: 'Create my academy' }).click();
  await page.waitForURL(/\/start/, { timeout: 30_000 });
  await expect(page.getByTestId('empieza-aqui')).toBeVisible();

  // 6. Su foto en la cabecera; «Empieza aquí» tampoco pide el perfil.
  const cabecera = page.getByRole('button', { name: 'Your profile' });
  await expect(cabecera.locator('img')).toHaveAttribute('src', yo.avatarUrl!);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  // El nombre de la persona no se pisó con el de la academia.
  expect(usuario(tenant.creatorEmail, tenant.slug).name).toBe('Clara Fernhill');

  // 7. En la comunidad, su foto junto a su post de bienvenida (no solo en la
  //    caja de escribir, que también pinta a quien mira).
  await page.goto(`${tenant.base}/community`);
  const post = page.getByRole('button').filter({ hasText: 'Welcome to Morning Pour' }).first();
  await expect(post).toBeVisible({ timeout: 20_000 });
  await expect(post.locator(`img[src="${yo.avatarUrl}"]`).first()).toHaveAttribute(
    'alt',
    'Clara Fernhill',
  );

  await ctx.close();
});

test('control: un alumno del mismo aula sencilla ve el perfil de alumno, no el del creador', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const tenant = await freshTenant(`perfilal${Date.now().toString(36)}`, true);
  const op = await apiAs<{ tokens: { accessToken: string } }>(tenant.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: {
      tenantSlug: tenant.slug,
      email: `operador@${tenant.slug}.test`,
      password: tenant.password,
    },
  });
  const alumnoEmail = `alumno@${tenant.slug}.test`;
  await apiAs(tenant.host, '/api/v1/admin/users', {
    method: 'POST',
    bearer: op.tokens.accessToken,
    body: { email: alumnoEmail, role: 'alumno' },
  });
  sql(`UPDATE "user" SET locale = 'en-US' WHERE email = '${alumnoEmail}'`);
  const ctx = await contextoEn(browser, tenant);
  const page = await ctx.newPage();

  await definirYEntrar(page, enlaceDeContrasena(tenant, alumnoEmail), alumnoEmail, tenant.password);
  await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
  await expect(
    page.getByRole('heading', { name: 'Complete your profile to get started' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Introduce yourself to your students' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Skip for now' })).toHaveCount(0);
  // Su foto también es opcional en modo sencillo, con el texto de siempre.
  await expect(
    page.getByText('Optional. If you do not upload one, we use your initials.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel(/Profile name/).fill('Student Test');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Enter the platform' }).click();
  // El alumno no va a la academia del creador.
  await page.waitForURL((u) => !/\/(onboarding|bienvenida|empieza)/.test(u.pathname), {
    timeout: 30_000,
  });
  await ctx.close();
});

test('control: una sesión ya abierta de la creadora sin perfil entra por el perfil, no por el alta', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const tenant = await freshTenant(`perfilses${Date.now().toString(36)}`, true);
  sql(`UPDATE "user" SET locale = 'en-US' WHERE email = '${tenant.creatorEmail}'`);
  const ctx = await contextoEn(browser, tenant);
  const page = await ctx.newPage();
  // Contraseña puesta por su enlace; luego la sesión se abre por API.
  await page.goto(tenant.setPasswordUrl);
  const pw = page.locator('input[type="password"]');
  await pw.nth(0).fill(tenant.password);
  await pw.nth(1).fill(tenant.password);
  await page
    .getByRole('button', { name: /contraseña|password/i })
    .last()
    .click();
  await page.waitForURL(/\/signin/, { timeout: 20_000 });
  const auth = await apiAs<{
    tokens: { accessToken: string; refreshToken: string };
    user: Parameters<typeof injectSession>[1]['user'];
  }>(tenant.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: tenant.slug, email: tenant.creatorEmail, password: tenant.password },
  });
  expect(auth.user.onboardingCompletedAt).toBeNull();
  await injectSession(page, {
    accessToken: auth.tokens.accessToken,
    refreshToken: auth.tokens.refreshToken,
    user: auth.user,
  });

  // Por el gate del shell: perfil antes que alta.
  await page.goto(`${tenant.base}/start`);
  await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
  await expect(
    page.getByRole('heading', { name: 'Introduce yourself to your students' }),
  ).toBeVisible();

  // Abriendo el alta directamente: también al perfil.
  await page.goto(`${tenant.base}/welcome`);
  await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
  await expect(page.getByText('Question 1 of 3')).toHaveCount(0);

  // Entrando por una pantalla de creación (donde luego SÍ tendrá el panel del
  // agente de IA), el gate la lleva al perfil sin pintar el panel ni un instante.
  await page.addInitScript(() => {
    const w = window as unknown as { __panelAgente?: boolean };
    w.__panelAgente = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid^="agente-ia-"]')) w.__panelAgente = true;
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(`${tenant.base}/studio/courses`);
  await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
  await expect(
    page.getByRole('heading', { name: 'Introduce yourself to your students' }),
  ).toBeVisible();
  await sinPanelDelAgente(page);
  expect(
    await page.evaluate(() => (window as unknown as { __panelAgente?: boolean }).__panelAgente),
  ).toBe(false);
  await ctx.close();
});
