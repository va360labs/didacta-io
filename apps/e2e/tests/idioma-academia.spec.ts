/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { adminTokenForBootstrap } from '../helpers/api';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';
import { startStripeDouble, type StripeDouble } from '../helpers/stripe-double';

/**
 * IDIOMA DE LA ACADEMIA: el aula tiene un idioma propio (ajuste
 * `academy/locale`) que se elige en el alta de 3 preguntas, en Ajustes (modo
 * sencillo y completo) o al aprovisionar el aula, y con el que la ven quienes
 * entran sin cookie ni preferencia. La preferencia de cada usuario sigue
 * mandando para ese usuario.
 *
 * Los visitantes se simulan con un navegador en FRANCÉS y sin cookies: así se
 * demuestra que el idioma sale del aula y no del `Accept-Language`.
 */

const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'E2eAdminPassword123!';
const REPO = path.resolve(__dirname, '..', '..', '..');

test.describe.configure({ mode: 'serial' });

let stripe: StripeDouble;
test.beforeAll(async () => {
  stripe = await startStripeDouble();
});
test.afterAll(async () => {
  await stripe?.close();
});

const operador = (t: FreshTenant) => `operador@${t.slug}.test`;

async function operatorToken(t: FreshTenant): Promise<string> {
  const r = await apiAs<{ tokens: { accessToken: string } }>(t.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: t.slug, email: operador(t), password: PASSWORD },
  });
  return r.tokens.accessToken;
}

async function setAcademyLocale(t: FreshTenant, locale: 'es' | 'en'): Promise<void> {
  await apiAs(t.host, '/api/v1/admin/tenant-settings/academy', {
    method: 'PUT',
    bearer: await operatorToken(t),
    body: { locale },
  });
}

/**
 * Un curso A LA VENTA, como lo deja la creadora en el modo sencillo: alta en 3
 * preguntas (sin `locale`: el aula decide), una lección y publicar (el precio
 * sale hacia el doble de Stripe). Es la ficha que abre un visitante.
 */
async function courseForSale(t: FreshTenant, title: string): Promise<void> {
  const bearer = await operatorToken(t);
  const { offer } = await apiAs<{ offer: { courseId: string } }>(
    t.host,
    '/api/v1/admin/simple-mode/quick-start',
    {
      method: 'POST',
      bearer,
      body: { academyName: title, offer: 'course', title, amountCents: 4900, currency: 'eur' },
    },
  );
  const course = await apiAs<{ modules: Array<{ id: string }> }>(
    t.host,
    `/api/v1/modules/courses/${offer.courseId}`,
    { bearer },
  );
  await apiAs(t.host, `/api/v1/modules/courses/modules/${course.modules[0]!.id}/lessons`, {
    method: 'POST',
    bearer,
    body: { title: 'L1', type: 'TEXT', orderIndex: 0, content: { text: 'x' }, durationSec: 60 },
  });
  await apiAs(t.host, '/api/v1/admin/simple-mode/publish', { method: 'POST', bearer });
}

/** Visitante: navegador en francés, sin cookie de idioma ni sesión. */
async function visitante(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 800 } });
  return ctx.newPage();
}

async function htmlLang(page: Page): Promise<string | null> {
  return page.locator('html').getAttribute('lang');
}

/**
 * Lo que ve un visitante nuevo en `/signin`, recargando hasta que coincida: la
 * web cachea el idioma del aula 30 s por dominio, así que un cambio en Ajustes
 * tarda como mucho eso en verse.
 */
async function expectVisitorSees(
  browser: Browser,
  t: FreshTenant,
  lang: 'en-US' | 'es-ES',
): Promise<void> {
  const page = await visitante(browser);
  try {
    await expect
      .poll(
        async () => {
          await page.goto(`${t.base}/signin`);
          return htmlLang(page);
        },
        { timeout: 45_000, intervals: [1_000, 3_000, 5_000] },
      )
      .toBe(lang);
    await expect(
      page.getByRole('button', { name: lang === 'en-US' ? 'Sign in' : 'Entrar', exact: true }),
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
}

function setPasswordLink(t: FreshTenant, email: string): string {
  const token = randomBytes(24).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  sql(
    `INSERT INTO password_reset_token (id, user_id, tenant_id, token_hash, expires_at, created_at) ` +
      `SELECT gen_random_uuid(), u.id, u.tenant_id, '${hash}', now() + interval '1 day', now() ` +
      `FROM "user" u JOIN tenant tt ON tt.id = u.tenant_id WHERE u.email = '${email}' AND tt.slug = '${t.slug}'`,
  );
  return `${t.base}/reset-password?token=${token}`;
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.locator('input[autocomplete="email"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
}

const ajuste = (t: FreshTenant) =>
  sql(
    `SELECT s.value_json #>> '{}' FROM tenant_setting s JOIN tenant tt ON tt.id = s.tenant_id ` +
      `WHERE tt.slug = '${t.slug}' AND s.module_name = 'academy' AND s.key = 'locale'`,
  );

test('visitante sin cookie: la venta de un aula en inglés sale en inglés, y la de una en español en español', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const stamp = Date.now().toString(36);
  const en = await freshTenant(`idiomaen${stamp}`, true);
  const es = await freshTenant(`idiomaes${stamp}`, true);
  await setAcademyLocale(en, 'en');
  await courseForSale(en, 'Espresso at Home');
  await courseForSale(es, 'Café en casa');
  expect(ajuste(en)).toBe('en');
  // El alta sin idioma en un aula española la deja en español (deducido).
  expect(ajuste(es)).toBe('es');

  const page = await visitante(browser);
  // Ficha de venta del curso: en inglés, con su botón de compra.
  await page.goto(`${en.base}/catalog/espresso-at-home`);
  expect(await htmlLang(page)).toBe('en-US');
  await expect(page.getByRole('heading', { name: /Espresso at Home/ }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('link', { name: 'Courses', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buy now' })).toBeVisible();
  // Acceso.
  await page.goto(`${en.base}/signin`);
  expect(await htmlLang(page)).toBe('en-US');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();

  // Control: la otra aula, en español, con el MISMO navegador.
  await page.goto(`${es.base}/catalog/cafe-en-casa`);
  expect(await htmlLang(page)).toBe('es-ES');
  await expect(page.getByRole('heading', { name: /Café en casa/ }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('link', { name: 'Cursos', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Comprar ahora' })).toBeVisible();
  await page.goto(`${es.base}/signin`);
  await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeVisible();
  // Ninguna cookie de idioma: lo decide el aula, no una elección guardada.
  expect((await page.context().cookies()).some((c) => c.name === 'didacta_locale')).toBe(false);
  await page.context().close();
});

test('el usuario con preferencia propia la conserva en un aula en inglés', async ({ browser }) => {
  test.setTimeout(120_000);
  const en = await freshTenant(`idiomapref${Date.now().toString(36)}`, true);
  await setAcademyLocale(en, 'en');
  // El operador ya eligió su idioma (español) y terminó su primer acceso.
  sql(
    `UPDATE "user" SET locale = 'es-ES', onboarding_completed_at = now(), name = 'Operador' ` +
      `WHERE email = '${operador(en)}'`,
  );

  const page = await visitante(browser);
  await page.goto(`${en.base}/signin`);
  // Antes de entrar: el idioma del aula.
  expect(await htmlLang(page)).toBe('en-US');
  await signIn(page, operador(en));
  // Al entrar manda su perfil: la interfaz pasa a español y queda en su cookie.
  await expect.poll(() => htmlLang(page), { timeout: 30_000 }).toBe('es-ES');
  expect((await page.context().cookies()).find((c) => c.name === 'didacta_locale')?.value).toBe(
    'es-ES',
  );
  expect(
    sql(`SELECT locale FROM "user" WHERE email = '${operador(en)}'`),
    'su preferencia no se pisa con la del aula',
  ).toBe('es-ES');
  await page.context().close();
});

test('alta en 3 preguntas: la creadora elige el idioma de la academia, y lo cambia en Ajustes', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const t = await freshTenant(`idiomaalta${Date.now().toString(36)}`, true);
  // La creadora trabaja en español (su cookie), pero monta la academia en inglés.
  const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: t.base }]);
  const page = await ctx.newPage();

  await page.goto(setPasswordLink(t, t.creatorEmail));
  const pw = page.locator('input[type="password"]');
  await pw.nth(0).fill(PASSWORD);
  await pw.nth(1).fill(PASSWORD);
  await page
    .getByRole('button', { name: /contraseña|password/i })
    .last()
    .click();
  await page.waitForURL(/\/signin/, { timeout: 20_000 });
  await signIn(page, t.creatorEmail);
  await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Dejar para luego' }).click();
  await page.getByLabel(/Nombre de perfil/).fill('Clara Barista');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Seguir con mi academia' }).click();
  await page.waitForURL(/\/welcome/, { timeout: 30_000 });

  await page.getByLabel('Nombre de la academia').fill('Morning Pour');
  // Preseleccionado con el de la interfaz: no suma clics si no se toca.
  const idioma = page.getByLabel('Idioma de la academia');
  await expect(idioma).toHaveValue('es');
  await expect(idioma.locator('option')).toHaveText(['Español', 'English']);
  await idioma.selectOption('en');
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await page.getByLabel('¿Cómo se llama el curso?').fill('Espresso at Home');
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await page.getByLabel('Precio').fill('49');
  await page.getByRole('button', { name: 'Crear mi academia' }).click();
  await page.waitForURL(/\/start/, { timeout: 30_000 });

  // El aula queda en inglés: ajuste, espacios y post de bienvenida…
  expect(ajuste(t)).toBe('en');
  expect(
    sql(
      `SELECT string_agg(s.title, '|' ORDER BY s.sort_order) FROM mod_community_space s ` +
        `JOIN tenant tt ON tt.id = s.tenant_id WHERE tt.slug = '${t.slug}'`,
    ),
  ).toBe('General|Announcements|Questions');
  // …y es lo que ve un visitante; la creadora sigue con su interfaz en español.
  await expectVisitorSees(browser, t, 'en-US');
  expect(await htmlLang(page)).toBe('es-ES');

  // Ajustes (modo sencillo): vuelve al español.
  await page.goto(`${t.base}/admin/settings`);
  await expect(page.getByTestId('ajustes-sencillo')).toBeVisible({ timeout: 20_000 });
  const selector = page.getByLabel('Idioma de la academia');
  await expect(selector).toHaveValue('en');
  await selector.selectOption('es');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.getByText('Guardado', { exact: true })).toBeVisible();
  expect(ajuste(t)).toBe('es');
  await expectVisitorSees(browser, t, 'es-ES');
  await ctx.close();
});

test('Configuración del modo completo: «Idioma de la academia» en la pestaña General', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const t = await freshTenant(`idiomafull${Date.now().toString(36)}`, false);
  // El operador ya pasó su primer acceso y el asistente de la academia.
  sql(
    `UPDATE "user" SET onboarding_completed_at = now(), name = 'Operador' WHERE email = '${operador(t)}'`,
  );
  await apiAs(t.host, '/api/v1/tenant-settings/onboarding/academy', {
    method: 'PUT',
    bearer: await operatorToken(t),
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
  await expectVisitorSees(browser, t, 'es-ES');

  const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: t.base }]);
  const page = await ctx.newPage();
  await page.goto(`${t.base}/signin`);
  await signIn(page, operador(t));
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
  await page.goto(`${t.base}/admin/settings?tab=general`);
  const card = page.getByTestId('idioma-academia');
  await expect(card).toBeVisible({ timeout: 20_000 });
  // Sin ajuste todavía: se dice que es el deducido y se puede fijar.
  await expect(card.getByText(/Aún no se ha elegido/)).toBeVisible();
  await card.getByLabel('Idioma').selectOption('en');
  await card.getByRole('button', { name: 'Guardar' }).click();
  await expect(card.getByText('Idioma guardado.')).toBeVisible();
  expect(ajuste(t)).toBe('en');
  await expectVisitorSees(browser, t, 'en-US');
  // Quien administra conserva su interfaz en español.
  expect(await htmlLang(page)).toBe('es-ES');
  await ctx.close();
});

/**
 * El alta de una segunda aula por la API es una capacidad de pago
 * (`feat:multi_tenant.real`) y el arnés corre en Community. Para ejercitar el
 * aprovisionamiento DE VERDAD (HTTP → BD → web) se levanta una segunda API sobre
 * la misma base, en desarrollo y con el bypass de licencia (todas las
 * capacidades); solo se usa para el POST. La web del arnés y su API normal
 * sirven después el aula como a cualquier otra.
 */
const DEV_API_PORT = 4_219;

function startDevApi(): ChildProcess {
  return spawn(process.execPath, ['dist/main.js'], {
    cwd: path.join(REPO, 'apps/api'),
    env: {
      ...process.env,
      // La API escucha en `API_PORT` (el `PORT` del arnés es otro).
      API_PORT: String(DEV_API_PORT),
      PORT: String(DEV_API_PORT),
      NODE_ENV: 'development',
      DIDACTA_DEV_BYPASS: 'true',
      DIDACTA_LICENSE_KEY: 'e2e-dev-bypass',
    },
    stdio: 'ignore',
  });
}

async function waitHealthy(port: number, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/healthz' }, (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) < 400);
      });
      req.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`La API de desarrollo no arrancó en :${port}`);
}

function postJson(
  port: number,
  p: string,
  bearer: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: p,
        method: 'POST',
        headers: {
          Host: 'localhost',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          authorization: `Bearer ${bearer}`,
        },
      },
      (res) => {
        let txt = '';
        res.on('data', (c) => (txt += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: txt }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('aprovisionamiento con `locale`: el aula nace en inglés y su administradora también', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const bearer = await adminTokenForBootstrap(process.env.E2E_TENANT_SLUG ?? 'demo');
  const apiPort = Number(process.env.API_PORT ?? 4000);
  const slug = `idiomaprov${Date.now().toString(36)}`;
  const body = {
    slug,
    name: 'Provisioned Academy',
    adminEmail: `owner@${slug}.test`,
    primaryHostname: `${slug}.localhost`,
    simpleMode: true,
  };

  // Un idioma sin catálogo es un 400 (antes de mirar la licencia).
  const malo = await postJson(apiPort, '/api/v1/admin/tenants', bearer, {
    ...body,
    locale: 'pt-BR',
  });
  expect(malo.status).toBe(400);

  const dev = startDevApi();
  try {
    await waitHealthy(DEV_API_PORT, 90_000);
    const r = await postJson(DEV_API_PORT, '/api/v1/admin/tenants', bearer, {
      ...body,
      locale: 'en-US',
    });
    expect(r.status, r.body).toBe(201);
  } finally {
    dev.kill();
  }

  const t: FreshTenant = {
    slug,
    host: `${slug}.localhost`,
    base: `http://${slug}.localhost:${new URL(process.env.E2E_BASE_URL ?? 'http://localhost:3010').port}`,
    creatorEmail: body.adminEmail,
    password: PASSWORD,
    setPasswordUrl: '',
  };
  expect(ajuste(t), 'el ajuste del aula, reducido al código').toBe('en');
  expect(
    sql(
      `SELECT u.locale FROM "user" u JOIN tenant tt ON tt.id = u.tenant_id ` +
        `WHERE tt.slug = '${slug}' AND u.email = '${body.adminEmail}'`,
    ),
    'la administradora nace en el idioma del aula',
  ).toBe('en-US');
  await expectVisitorSees(browser, t, 'en-US');
});
