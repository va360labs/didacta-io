/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { fotoPngBase64 } from '../helpers/png';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';
import { startStripeDouble, type StripeDouble } from '../helpers/stripe-double';

/**
 * PULIDO DEL MODO SENCILLO, en un aula NUEVA EN INGLÉS (como las de Didacta
 * Cloud), de principio a fin y con la creadora y una alumna de verdad:
 *
 *  1. Portada del curso: opcional en el alta de 3 preguntas (sin sumar clics),
 *     editable en el editor sencillo y visible en el enlace de venta, la página
 *     de venta y las tarjetas de curso.
 *  2. Cuestionario en el editor sencillo (una o varias correctas, nota para
 *     aprobar) que la alumna aprueba en la lección.
 *  3. Desde el modo completo se vuelve al sencillo.
 *  4. Los retos se alcanzan desde el ranking.
 *  5. El anuncio automático de un directo sale en inglés (texto y etiqueta).
 *  6. El selector de espacio del compositor pinta iconos, no sus nombres.
 *  7. La zona horaria: la del aula al crear la cuenta, la del navegador en el
 *     primer acceso, y después no se pisa.
 *  9. La página de venta pública lleva el color del aula.
 * 10. La clave del agente se llama «AI agent» en un aula en inglés.
 *
 * (El 8, erratas, tiene sus asserts en el directo, el ranking y los textos.)
 */

const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'E2eAdminPassword123!';
const COURSE = 'Espresso at Home';
const QUIZ = 'Dial in your espresso';

let stripe: StripeDouble;
let tenant: FreshTenant;
let creatorCtx: BrowserContext;
let creator: Page;
let courseId = '';
let courseSlug = '';
let saleLink = '';
let coverSrc = '';
const STUDENT_EMAIL = 'student@pulido.test';

test.describe.configure({ mode: 'serial' });

function png(size = 320): { name: string; mimeType: string; buffer: Buffer } {
  return {
    name: 'cover.png',
    mimeType: 'image/png',
    buffer: Buffer.from(fotoPngBase64(size), 'base64'),
  };
}

function setPasswordLink(email: string): string {
  const token = randomBytes(24).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  sql(
    `INSERT INTO password_reset_token (id, user_id, tenant_id, token_hash, expires_at, created_at) ` +
      `SELECT gen_random_uuid(), u.id, u.tenant_id, '${hash}', now() + interval '1 day', now() ` +
      `FROM "user" u JOIN tenant t ON t.id = u.tenant_id WHERE u.email = '${email}' AND t.slug = '${tenant.slug}'`,
  );
  return `${tenant.base}/reset-password?token=${token}`;
}

async function setPasswordAndSignIn(page: Page, url: string, email: string) {
  await page.goto(url);
  const pw = page.locator('input[type="password"]');
  await pw.nth(0).fill(PASSWORD);
  await pw.nth(1).fill(PASSWORD);
  await page
    .getByRole('button', { name: /password/i })
    .last()
    .click();
  await page.waitForURL(/\/signin/, { timeout: 20_000 });
  await signIn(page, email);
}

async function signIn(page: Page, email: string) {
  await page.locator('input[autocomplete="email"]').fill(email);
  await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
}

async function englishContext(browser: Browser, timezoneId: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    locale: 'en-US',
    timezoneId,
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'en-US', url: tenant.base }]);
  return ctx;
}

function userRow(email: string): { timezone: string; locale: string } {
  const [tz, locale] = sql(
    `SELECT u.timezone || '|' || u.locale FROM "user" u JOIN tenant t ON t.id = u.tenant_id ` +
      `WHERE u.email = '${email}' AND t.slug = '${tenant.slug}'`,
  ).split('|');
  return { timezone: tz ?? '', locale: locale ?? '' };
}

async function creatorToken(): Promise<string> {
  const r = await apiAs<{ tokens: { accessToken: string } }>(tenant.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: tenant.slug, email: tenant.creatorEmail, password: PASSWORD },
  });
  return r.tokens.accessToken;
}

/** Ningún nombre de icono de espacio pintado como texto. */
const ICON_NAMES =
  /^(megaphone|help|hash|message|book|globe|users|video|sparkles|award|shield|file)$/;

test.beforeAll(async ({ browser }) => {
  stripe = await startStripeDouble();
  tenant = await freshTenant(`pulido${Date.now().toString(36)}`, true);
  creatorCtx = await englishContext(browser, 'Europe/Madrid');
  creator = await creatorCtx.newPage();
  creator.on('dialog', (d) => void d.accept());
});

test.afterAll(async () => {
  await creatorCtx?.close();
  await stripe?.close();
});

test('7 y 1: primer acceso de la creadora en Madrid y alta en inglés con portada opcional', async () => {
  test.setTimeout(150_000);
  // Antes de entrar: el perfil por defecto (UTC, español).
  expect(userRow(tenant.creatorEmail)).toEqual({ timezone: 'UTC', locale: 'es-ES' });
  await setPasswordAndSignIn(creator, tenant.setPasswordUrl, tenant.creatorEmail);
  await creator.waitForURL(/\/onboarding/, { timeout: 30_000 });
  await expect(
    creator.getByRole('heading', { name: 'Introduce yourself to your students' }),
  ).toBeVisible();
  // El perfil en español ya no le pasa la interfaz al español.
  await creator.getByRole('button', { name: 'Skip for now' }).click();
  await creator.locator('#ob-name').fill('Clara Barista');
  // Primer acceso: la zona propuesta es la de su navegador, no UTC.
  await expect(creator.locator('#ob-tz')).toHaveValue('Europe/Madrid');
  await expect(creator.locator('#ob-locale')).toHaveValue('en-US');
  await creator.getByRole('button', { name: 'Continue' }).click();
  await creator.getByRole('button', { name: 'Continue' }).click();
  await creator.getByRole('button', { name: 'Continue to my academy' }).click();
  await creator.waitForURL(/\/welcome/, { timeout: 30_000 });
  expect(userRow(tenant.creatorEmail)).toEqual({ timezone: 'Europe/Madrid', locale: 'en-US' });

  // Alta en 3 preguntas, con la portada opcional en la segunda.
  await creator.getByLabel('Academy name').fill('Morning Pour');
  await creator.getByRole('button', { name: 'Next' }).click();
  await creator.getByLabel('What is the course called?').fill(COURSE);
  await expect(creator.getByRole('button', { name: 'Add a cover (optional)' })).toBeVisible();
  await creator.getByTestId('alta-portada-fichero').setInputFiles(png());
  const preview = creator.getByTestId('alta-portada-vista');
  await expect(preview).toBeVisible({ timeout: 20_000 });
  await expect(creator.getByRole('button', { name: 'Change the cover' })).toBeVisible();
  await creator.getByRole('button', { name: 'Next' }).click();
  await creator.getByLabel('Price').fill('49');
  await creator.getByRole('button', { name: 'Create my academy' }).click();
  await creator.waitForURL(/\/start/, { timeout: 30_000 });

  // La tarjeta del enlace de venta ya enseña la portada (no el degradado).
  const linkCover = creator.getByTestId('enlace-portada');
  await expect(linkCover).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => linkCover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  await expect(creator.getByTestId('enlace-portada-reserva')).toHaveCount(0);
  coverSrc = (await linkCover.getAttribute('src')) ?? '';
  expect(coverSrc).toMatch(/\/api\/v1\/storage\/file\/|^https?:\/\//);

  const [row] = sql(
    `SELECT c.id || '|' || c.slug || '|' || coalesce(c.thumbnail_url, '') FROM mod_courses_course c ` +
      `JOIN tenant t ON t.id = c.tenant_id WHERE t.slug = '${tenant.slug}'`,
  ).split('\n');
  [courseId, courseSlug] = (row ?? '').split('|') as [string, string];
  expect(row).toContain(coverSrc);
});

test('1: la portada se cambia desde el editor sencillo', async () => {
  test.setTimeout(90_000);
  await creator.getByRole('link', { name: 'Add my first lesson' }).click();
  await expect(creator.getByTestId('editor-sencillo')).toBeVisible();
  const cover = creator.getByTestId('portada-imagen');
  await expect(cover).toHaveAttribute('src', coverSrc);
  await expect(creator.getByTestId('subir-portada')).toHaveText(/Change cover/);
  // Otra imagen: se guarda al elegirla.
  await creator.locator('#portada-fichero').setInputFiles(png(480));
  await expect(cover).not.toHaveAttribute('src', coverSrc, { timeout: 20_000 });
  coverSrc = (await cover.getAttribute('src')) ?? '';
  await expect
    .poll(() => sql(`SELECT thumbnail_url FROM mod_courses_course WHERE id = '${courseId}'`))
    .toBe(coverSrc);
});

test('2: cuestionario en el editor sencillo (una y varias correctas, nota para aprobar)', async () => {
  test.setTimeout(90_000);
  // El selector se abrió solo («Add my first lesson» llega con ?add=1).
  await expect(creator.getByTestId('tipo-QUIZ')).toBeVisible();
  await creator.getByTestId('tipo-QUIZ').click();
  const form = creator.getByTestId('form-cuestionario');
  await form.getByLabel('Lesson title').fill(QUIZ);
  await form.getByLabel('Pass mark').selectOption('70');

  const q1 = form.getByTestId('pregunta').nth(0);
  await q1
    .getByPlaceholder('Write the question')
    .fill('Your shot ran in 14 seconds and tastes sour. What first?');
  await q1.getByLabel('Answer 1', { exact: true }).fill('Grind coarser');
  await q1.getByLabel('Answer 2', { exact: true }).fill('Grind finer');
  // Sin marcar la buena, el formulario lo dice en la pregunta concreta.
  await q1.getByRole('radio', { name: 'Answer 1 is correct' }).click(); // la primera ya venía marcada: sigue
  await q1.getByRole('radio', { name: 'Answer 2 is correct' }).click();
  await expect(q1.getByRole('radio', { name: 'Answer 2 is correct' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(q1.getByRole('radio', { name: 'Answer 1 is correct' })).toHaveAttribute(
    'aria-checked',
    'false',
  );

  await form.getByTestId('anadir-pregunta').click();
  const q2 = form.getByTestId('pregunta').nth(1);
  await q2.getByPlaceholder('Write the question').fill('Which tools help you repeat a good shot?');
  await q2.getByLabel('More than one correct answer').check();
  await q2.getByLabel('Answer 1', { exact: true }).fill('A scale that reads to 0.1 g');
  await q2.getByLabel('Answer 2', { exact: true }).fill('A bigger cup');
  await q2.getByRole('button', { name: 'Add answer' }).click();
  await q2.getByLabel('Answer 3', { exact: true }).fill('A timer');
  // Varias correctas: marcar la 3 no desmarca la 1.
  await q2.getByRole('checkbox', { name: 'Answer 3 is correct' }).click();
  await expect(q2.getByRole('checkbox', { name: 'Answer 1 is correct' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Una pregunta a medias no se guarda: el error dice cuál.
  await form.getByTestId('anadir-pregunta').click();
  await form.getByTestId('guardar-leccion').click();
  await expect(form.getByRole('alert')).toHaveText('Write question 3.');
  await form.getByTestId('pregunta').nth(2).getByRole('button', { name: 'Remove' }).click();

  await form.getByTestId('guardar-leccion').click();
  await expect(creator.getByText(`1. ${QUIZ}`)).toBeVisible({ timeout: 20_000 });
  await expect(creator.getByTestId('form-cuestionario')).toHaveCount(0);

  // Debajo: el módulo de evaluaciones, publicado y enlazado a la lección.
  const quiz = sql(
    `SELECT q.status || '|' || q.pass_threshold || '|' || (q.lesson_id = l.id)::text || '|' || ` +
      `(SELECT count(*) FROM mod_assessments_question x WHERE x.quiz_id = q.id AND x.deleted_at IS NULL) ` +
      `FROM mod_courses_lesson l JOIN mod_assessments_quiz q ON q.id::text = l.content->>'quizId' ` +
      `WHERE l.title = '${QUIZ}' AND l.type = 'QUIZ' ` +
      `AND l.tenant_id = (SELECT id FROM tenant WHERE slug = '${tenant.slug}')`,
  );
  expect(quiz).toBe('PUBLISHED|70|true|2');

  // Volver a abrirlo enseña lo guardado.
  await creator.getByRole('button', { name: 'Edit' }).click();
  await expect(creator.getByTestId('form-cuestionario').getByTestId('pregunta')).toHaveCount(2);
  await expect(creator.getByLabel('Pass mark')).toHaveValue('70');
  await creator.getByTestId('form-cuestionario').getByRole('button', { name: 'Cancel' }).click();
});

test('9 y 1: publicar; la página de venta lleva la portada y el color del aula', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  // El color del aula: naranja (hue 24), como lo deja «Ajustes».
  await apiAs(tenant.host, '/api/v1/modules/theming/me', {
    method: 'PUT',
    bearer: await creatorToken(),
    body: { brandHue: 24, brandSaturation: 80 },
  });
  await creator.goto(`${tenant.base}/start`);
  await creator.getByTestId('publicar').click();
  await expect(creator.getByTestId('copiar-enlace')).toBeEnabled({ timeout: 20_000 });
  await creator.getByTestId('copiar-enlace').click();
  saleLink = await creator.evaluate(() => navigator.clipboard.readText());
  expect(saleLink).toContain(`/catalog/${courseSlug}`);

  const visitor = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1440, height: 900 },
  });
  await visitor.addCookies([{ name: 'didacta_locale', value: 'en-US', url: tenant.base }]);
  const v = await visitor.newPage();
  await v.goto(saleLink);
  await expect(v.getByRole('heading', { name: COURSE }).first()).toBeVisible({ timeout: 20_000 });
  const img = v.locator(`img[src="${coverSrc}"]`).first();
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
    .toBe(true);

  // El color: los tokens del aula, y el botón de compra en su naranja.
  await expect
    .poll(() =>
      v.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--brand-h').trim(),
      ),
    )
    .toBe('24');
  const buy = v.getByRole('button', { name: 'Buy now' });
  await expect(buy).toBeVisible();
  // Tono (hue) del fondo del botón: el del aula (24), no el azul de Didacta (213).
  const hue = await buy.evaluate((el) => {
    const m = getComputedStyle(el)
      .backgroundColor.match(/\d+(\.\d+)?/g)!
      .map(Number);
    const [r, g, b] = [m[0]! / 255, m[1]! / 255, m[2]! / 255];
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (d === 0) return -1;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return Math.round((h * 60 + 360) % 360);
  });
  expect(Math.abs(hue - 24)).toBeLessThanOrEqual(4);

  // Control: el aula de arranque (sin color propio) sigue en el azul de Didacta.
  const control = await browser.newPage();
  await control.goto(`${process.env.E2E_BASE_URL ?? 'http://localhost:3010'}/catalog`);
  await expect
    .poll(() =>
      control.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--brand-h').trim(),
      ),
    )
    .toBe('213');
  await control.close();
  await visitor.close();
});

test('7 y 2: la alumna nace con la zona del aula, su primer acceso toma la de su navegador y aprueba el cuestionario', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const token = await creatorToken();
  const created = await apiAs<{ id: string }>(tenant.host, '/api/v1/admin/users', {
    method: 'POST',
    bearer: token,
    body: { email: STUDENT_EMAIL, role: 'alumno', name: 'Sam Student' },
  });
  // Al crearla el servidor: la zona del aula (la de su creadora), no UTC.
  expect(userRow(STUDENT_EMAIL).timezone).toBe('Europe/Madrid');
  await apiAs(tenant.host, '/api/v1/modules/learning/enrollments', {
    method: 'POST',
    bearer: token,
    body: { userId: created.id, courseId },
  });

  // Primer acceso desde Nueva York: manda su navegador.
  const ctx = await englishContext(browser, 'America/New_York');
  const page = await ctx.newPage();
  await setPasswordAndSignIn(page, setPasswordLink(STUDENT_EMAIL), STUDENT_EMAIL);
  await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#ob-tz')).toHaveValue('America/New_York');
  await expect(page.locator('#ob-tz option:checked')).toHaveText('America/New_York');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Enter the platform' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/onboarding'), { timeout: 30_000 });
  expect(userRow(STUDENT_EMAIL)).toEqual({ timezone: 'America/New_York', locale: 'en-US' });

  // El cuestionario, en la lección: lo aprueba.
  await page.goto(`${tenant.base}/courses/${courseSlug}`);
  await page
    .getByRole('button', { name: new RegExp(QUIZ) })
    .first()
    .click();
  await expect(page.getByText('Quiz').first()).toBeVisible();
  await page.getByRole('button', { name: 'Start quiz' }).click();
  await page.getByLabel('Grind finer').check();
  await page.getByLabel('A scale that reads to 0.1 g').check();
  await page.getByLabel('A timer').check();
  await page.getByRole('button', { name: 'Submit answers' }).click();
  await expect(page.getByText('You did it!')).toBeVisible({ timeout: 20_000 });
  expect(
    sql(
      `SELECT a.passed::text FROM mod_assessments_attempt a JOIN "user" u ON u.id = a.user_id ` +
        `WHERE u.email = '${STUDENT_EMAIL}' ORDER BY a.started_at DESC LIMIT 1`,
    ),
  ).toBe('true');
  await ctx.close();

  // Después del primer acceso, su zona es SUYA: otro navegador no la pisa.
  const tokyo = await englishContext(browser, 'Asia/Tokyo');
  const t2 = await tokyo.newPage();
  await t2.goto(`${tenant.base}/signin`);
  await signIn(t2, STUDENT_EMAIL);
  await t2.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
  await t2.goto(`${tenant.base}/community`);
  await t2.waitForTimeout(1500);
  expect(userRow(STUDENT_EMAIL).timezone).toBe('America/New_York');
  await tokyo.close();
});

test('4 y 8: el alumno llega a los retos desde el ranking («Ranking» en los dos sitios)', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const ctx = await englishContext(browser, 'America/New_York');
  const page = await ctx.newPage();
  await page.goto(`${tenant.base}/signin`);
  await signIn(page, STUDENT_EMAIL);
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
  await page
    .getByRole('navigation', { name: 'Sections' })
    .first()
    .getByRole('link', { name: 'Leaderboard' })
    .click();
  await page.waitForURL(/\/leaderboard/);
  await expect(page.getByRole('heading', { name: 'Leaderboard', exact: true })).toBeVisible();
  const tabs = page.getByTestId('ranking-retos');
  await expect(tabs.getByRole('link', { name: 'Leaderboard' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await tabs.getByRole('link', { name: 'Challenges' }).click();
  await page.waitForURL(/\/challenges/);
  await expect(
    page.getByTestId('ranking-retos').getByRole('link', { name: 'Challenges' }),
  ).toHaveAttribute('aria-current', 'page');
  // La pestaña de arriba sigue marcando el ranking: los retos viven dentro.
  await expect(
    page
      .getByRole('navigation', { name: 'Sections' })
      .first()
      .getByRole('link', { name: 'Leaderboard' }),
  ).toHaveAttribute('aria-current', 'page');
  await ctx.close();
});

test('5, 6 y 8: el anuncio del directo sale en inglés y el selector de espacio pinta iconos', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const token = await creatorToken();
  // Jueves 19 de noviembre a las 19:00 en Madrid.
  const session = await apiAs<{ id: string }>(tenant.host, '/api/v1/modules/zoom-live/sessions', {
    method: 'POST',
    bearer: token,
    body: {
      topic: 'Latte art live',
      startTime: '2026-11-19T19:00:00+01:00',
      durationMinutes: 60,
      hostEmail: tenant.creatorEmail,
      timezone: 'Europe/Madrid',
      announce: true,
      externalJoinUrl: 'https://meet.example.com/abc-defg-hij',
    },
  });
  const body = await expect
    .poll(
      () =>
        sql(
          `SELECT p.body || '§' || array_to_string(p.tags, ',') FROM mod_community_post p ` +
            `JOIN tenant t ON t.id = p.tenant_id WHERE t.slug = '${tenant.slug}' ` +
            `AND p.body LIKE '%didacta-clase:${session.id}%'`,
        ),
      { timeout: 20_000 },
    )
    .toContain('Live class: **Latte art live**.');
  void body;
  const [text, tags] = sql(
    `SELECT p.body || '§' || array_to_string(p.tags, ',') FROM mod_community_post p ` +
      `WHERE p.body LIKE '%didacta-clase:${session.id}%'`,
  ).split('§');
  expect(text).toContain('Thursday, November 19');
  expect(text).toContain('Sign up here');
  expect(text).not.toMatch(/Clase en directo|Inscríbete|noviembre|jueves/i);
  expect(tags).toBe('Live classes');

  // La alumna lo ve en su comunidad, en inglés.
  const ctx = await englishContext(browser, 'America/New_York');
  const page = await ctx.newPage();
  await page.goto(`${tenant.base}/signin`);
  await signIn(page, STUDENT_EMAIL);
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
  await page.goto(`${tenant.base}/community`);
  const card = page.getByTestId(`clase-embed-${session.id}`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Live classes').first()).toBeVisible();
  await expect(page.getByText(/Clases en directo|Inscríbete/)).toHaveCount(0);

  // El directo, con la fecha en minúscula salvo la primera letra.
  await page.goto(`${tenant.base}/live/${session.id}`);
  await expect(page.getByTestId('fecha-directo')).toBeVisible();
  const date = page.getByTestId('fecha-directo');
  expect(await date.evaluate((el) => getComputedStyle(el).textTransform)).toBe('none');
  await expect(date).toContainText(/Thursday, November 19, 2026 at/);

  // 6: el selector de espacio del compositor, con iconos y sin nombres de icono.
  await page.goto(`${tenant.base}/community`);
  await page.getByText('Write something…').click();
  await page.getByRole('button', { name: /Publishing in/ }).click();
  const menu = page.getByRole('button', { name: 'Announcements' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('svg')).toHaveCount(1);
  for (const label of await page
    .getByRole('button', { name: /General|Announcements|Questions/ })
    .allTextContents()) {
    expect(label.trim()).not.toMatch(ICON_NAMES);
    expect(label).not.toMatch(/megaphone|help/);
  }
  await ctx.close();
});

test('10: la clave del agente se llama «AI agent» en un aula en inglés', async () => {
  test.setTimeout(60_000);
  const created = await apiAs<{ id: string; name: string }>(tenant.host, '/api/v1/agent/keys', {
    method: 'POST',
    bearer: await creatorToken(),
    body: {},
  });
  expect(created.name).toBe('AI agent');
  await creator.goto(`${tenant.base}/admin/api-keys`);
  await expect(creator.getByText('AI agent').first()).toBeVisible({ timeout: 20_000 });
  await expect(creator.getByText('Agente de IA')).toHaveCount(0);
});

test('3: del modo completo se vuelve al sencillo', async () => {
  test.setTimeout(90_000);
  await creator.goto(`${tenant.base}/admin/settings`);
  await creator.getByRole('button', { name: 'Switch to the full mode' }).click();
  await creator.waitForURL(/\/admin(\?|$)/, { timeout: 30_000 });
  expect(sql(`SELECT simple_mode::text FROM tenant WHERE slug = '${tenant.slug}'`)).toBe('false');
  // En el modo completo, Configuración ofrece la vuelta.
  await creator.goto(`${tenant.base}/admin/settings`);
  const back = creator.getByTestId('volver-sencillo');
  await expect(back).toBeVisible({ timeout: 20_000 });
  await expect(back).toContainText('Back to the simple mode');
  await back.getByRole('button', { name: 'Back to the simple mode' }).click();
  await creator.waitForURL(/\/start/, { timeout: 30_000 });
  await expect(creator.getByTestId('empieza-aqui')).toBeVisible({ timeout: 20_000 });
  expect(sql(`SELECT simple_mode::text FROM tenant WHERE slug = '${tenant.slug}'`)).toBe('true');
  // Y en el modo sencillo la tarjeta no aparece (ya está en él).
  await creator.goto(`${tenant.base}/admin/settings?full=1`);
  await expect(creator.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(creator.getByTestId('volver-sencillo')).toHaveCount(0);
});
