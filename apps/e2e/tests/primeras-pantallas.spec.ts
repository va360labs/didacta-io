/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';

/**
 * LAS PRIMERAS PANTALLAS, lo que enseñó la grabación de la primera venta real
 * de Didacta Cloud (14-nov-2026), en un aula NUEVA en modo sencillo y en español:
 *
 *  4. La creadora, con pasos de «Empieza aquí» pendientes, entra a «Empieza
 *     aquí» (no a la comunidad). Una alumna del mismo aula y el administrador
 *     de un aula del modo completo siguen entrando a la comunidad.
 * 10. Mientras se decide adónde va, se ve el esqueleto del aula, no una
 *     pantalla en blanco.
 *  8. La alumna que acaba de comprar llega a SU curso con UN paso de perfil
 *     (foto opcional y nombre), sin DNI «para solicitar facturas».
 *  9. La entrada del aula no presume de «1 alumno activo · 1 curso»: las
 *     cifras salen desde 10 alumnos.
 *
 * Con `E2E_CAPTURAS_DIR`, deja capturas de cada pantalla (escritorio y móvil).
 */

const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'E2eAdminPassword123!';
const CAPTURAS = process.env.E2E_CAPTURAS_DIR;
const ESCRITORIO = { width: 1440, height: 900 };
const MOVIL = { width: 390, height: 844 };
const CURSO = 'Acuarela desde cero';
const COMPRADORA = 'marta@entrada.test';

let tenant: FreshTenant;
let courseId = '';
let courseSlug = '';

test.describe.configure({ mode: 'serial' });

async function captura(page: Page, nombre: string) {
  if (!CAPTURAS) return;
  mkdirSync(CAPTURAS, { recursive: true });
  await page.screenshot({ path: path.join(CAPTURAS, `${nombre}.png`), fullPage: true });
}

/** Escritorio y móvil de la pantalla que hay ahora mismo. */
async function capturas(page: Page, nombre: string) {
  if (!CAPTURAS) return;
  const antes = page.viewportSize() ?? ESCRITORIO;
  await page.setViewportSize(ESCRITORIO);
  await captura(page, `${nombre}-escritorio`);
  await page.setViewportSize(MOVIL);
  await captura(page, `${nombre}-movil`);
  await page.setViewportSize(antes);
}

async function contexto(browser: Browser, base = tenant.base): Promise<BrowserContext> {
  const ctx = await browser.newContext({ locale: 'es-ES', viewport: ESCRITORIO });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: base }]);
  return ctx;
}

/** Rutas por las que pasa la pestaña. */
function rastro(page: Page): string[] {
  const vistas: string[] = [];
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) vistas.push(new URL(f.url()).pathname);
  });
  return vistas;
}

/** Enlace de «define tu contraseña» como el del correo de la compra. */
function enlace(email: string, next?: string): string {
  const token = randomBytes(24).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  sql(
    `INSERT INTO password_reset_token (id, user_id, tenant_id, token_hash, expires_at, created_at) ` +
      `SELECT gen_random_uuid(), u.id, u.tenant_id, '${hash}', now() + interval '7 days', now() ` +
      `FROM "user" u JOIN tenant t ON t.id = u.tenant_id WHERE u.email = '${email}' AND t.slug = '${tenant.slug}'`,
  );
  const n = next ? `&next=${encodeURIComponent(next)}` : '';
  return `${tenant.base}/reset-password?token=${token}${n}`;
}

async function guardarContrasena(page: Page) {
  const pw = page.locator('input[type="password"]');
  await pw.nth(0).fill(PASSWORD);
  await pw.nth(1).fill(PASSWORD);
  await page.getByRole('button', { name: 'Guardar nueva contraseña' }).click();
}

async function entrarPorElLogin(page: Page, base: string, email: string, password = PASSWORD) {
  await page.goto(`${base}/signin`);
  await page.getByLabel(/Email/).fill(email);
  await page.getByLabel(/Contraseña/).fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

async function tokenDe(email: string): Promise<string> {
  const r = await apiAs<{ tokens: { accessToken: string } }>(tenant.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: tenant.slug, email, password: PASSWORD },
  });
  return r.tokens.accessToken;
}

/** Alumna que se da de alta sola (con contraseña): cuenta como alumna activa. */
async function alumnaConCuenta(nombre: string): Promise<void> {
  await apiAs(tenant.host, '/api/v1/auth/signup', {
    method: 'POST',
    body: {
      tenantSlug: tenant.slug,
      email: `al-${randomBytes(4).toString('hex')}@entrada.test`,
      password: PASSWORD,
      name: nombre,
    },
  });
}

test.beforeAll(async () => {
  tenant = await freshTenant(`entrada${Date.now().toString(36)}`, true);
});

test('9: con menos de 10 alumnos, la entrada del aula no enseña cifras', async ({ browser }) => {
  test.setTimeout(90_000);
  // Un curso publicado y una alumna: hoy el panel decía «1 alumno activo · 1 curso».
  sql(
    `INSERT INTO mod_courses_course (id, tenant_id, slug, title, status, published_at, updated_at) ` +
      `SELECT gen_random_uuid(), t.id, 'cifras-${Date.now().toString(36)}', 'Curso de cifras', 'PUBLISHED', now(), now() ` +
      `FROM tenant t WHERE t.slug = '${tenant.slug}'`,
  );
  await alumnaConCuenta('Primera Alumna');
  const ctx = await contexto(browser);
  const page = await ctx.newPage();
  await page.goto(`${tenant.base}/signin`);
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  await expect(page.getByText(/alumnos? activos?/)).toHaveCount(0);
  await expect(page.getByText(/cursos? incluidos?/)).toHaveCount(0);
  await capturas(page, '09-entrada-sin-cifras');

  // Control: con 10 alumnas, las dos cifras reales.
  for (let i = 2; i <= 10; i++) await alumnaConCuenta(`Alumna ${i}`);
  await page.reload();
  await expect(page.getByText('alumnos activos')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('10', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('curso incluido')).toBeVisible();
  await capturas(page, '09-entrada-con-cifras-desde-10');
  await ctx.close();
});

test('4 y 10: la creadora con pasos pendientes entra a «Empieza aquí», con esqueleto mientras se decide', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  // Su primer acceso: perfil y alta en 3 preguntas, como en Didacta Cloud.
  const alta = await contexto(browser);
  const creator = await alta.newPage();
  await creator.goto(tenant.setPasswordUrl);
  await guardarContrasena(creator);
  await creator.waitForURL(/\/onboarding/, { timeout: 30_000 });
  await creator.getByRole('button', { name: 'Dejar para luego' }).click();
  await creator.getByLabel(/Nombre de perfil/).fill('Lucía Entrada');
  await creator.getByRole('button', { name: 'Continuar' }).click();
  await creator.getByRole('button', { name: 'Continuar' }).click();
  await creator.getByRole('button', { name: 'Seguir con mi academia' }).click();
  await creator.waitForURL(/\/welcome/, { timeout: 30_000 });
  await creator.getByLabel('Nombre de la academia').fill('Acuarela con Lucía');
  await creator.getByRole('button', { name: 'Siguiente' }).click();
  await creator.getByLabel('¿Cómo se llama el curso?').fill(CURSO);
  await creator.getByRole('button', { name: 'Siguiente' }).click();
  await creator.getByLabel('Precio').fill('29');
  await creator.getByRole('button', { name: 'Crear mi academia' }).click();
  await creator.waitForURL(/\/start/, { timeout: 30_000 });
  await alta.close();

  // Vuelve otro día y entra por el login, con «Empieza aquí» a medias. La
  // respuesta de sus pasos se retrasa para poder ver qué hay mientras tanto.
  const ctx = await contexto(browser);
  const page = await ctx.newPage();
  const vistas = rastro(page);
  await page.route('**/api/v1/admin/simple-mode/start-here', async (route) => {
    await new Promise((r) => setTimeout(r, 2_000));
    await route.continue();
  });
  await entrarPorElLogin(page, tenant.base, tenant.creatorEmail);
  // 10. Ni un instante en blanco: el esqueleto del aula.
  await expect(page.getByTestId('pagina-cargando')).toBeVisible({ timeout: 20_000 });
  await captura(page, '10-esqueleto-al-entrar-escritorio');
  // 4. Y aterriza en «Empieza aquí», no en la comunidad.
  await page.waitForURL(/\/start/, { timeout: 30_000 });
  await expect(page.getByTestId('empieza-aqui')).toBeVisible({ timeout: 20_000 });
  expect(vistas.some((p) => p.startsWith('/community'))).toBe(false);
  await page.unroute('**/api/v1/admin/simple-mode/start-here');
  await capturas(page, '04-entrada-creadora-a-empieza-aqui');

  // El esqueleto, también en el móvil.
  await page.setViewportSize(MOVIL);
  await page.route('**/api/v1/admin/simple-mode/start-here', async (route) => {
    await new Promise((r) => setTimeout(r, 2_000));
    await route.continue();
  });
  await page.goto(`${tenant.base}/home`);
  await expect(page.getByTestId('pagina-cargando')).toBeVisible({ timeout: 20_000 });
  await captura(page, '10-esqueleto-al-entrar-movil');
  await page.waitForURL(/\/start/, { timeout: 30_000 });
  await ctx.close();

  const [row] = sql(
    `SELECT c.id || '|' || c.slug FROM mod_courses_course c JOIN tenant t ON t.id = c.tenant_id ` +
      `WHERE t.slug = '${tenant.slug}' AND c.title = '${CURSO}'`,
  ).split('\n');
  [courseId, courseSlug] = (row ?? '').split('|') as [string, string];
  expect(courseSlug).toBeTruthy();
});

test('8: la alumna que acaba de comprar llega a SU curso con un solo paso de perfil y sin DNI', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  // Como deja la compra: cuenta con el nombre del pago, matrícula y el enlace
  // de «define tu contraseña» que lleva a su curso.
  sql(
    `UPDATE mod_courses_course SET status = 'PUBLISHED', published_at = now() WHERE id = '${courseId}'`,
  );
  const creadora = await tokenDe(tenant.creatorEmail);
  const alumna = await apiAs<{ id: string }>(tenant.host, '/api/v1/admin/users', {
    method: 'POST',
    bearer: creadora,
    body: { email: COMPRADORA, role: 'alumno', name: 'Marta Compradora Ruiz' },
  });
  await apiAs(tenant.host, '/api/v1/modules/learning/enrollments', {
    method: 'POST',
    bearer: creadora,
    body: { userId: alumna.id, courseId },
  });

  const ctx = await contexto(browser);
  const page = await ctx.newPage();
  const vistas = rastro(page);
  await page.goto(enlace(COMPRADORA, `/courses/${courseSlug}`));
  await guardarContrasena(page);
  await page.waitForURL(/\/onboarding/, { timeout: 30_000 });

  // UN paso: foto opcional y nombre (el del pago, ya puesto). Sin pasos de
  // notificaciones ni resumen, y sin DNI «para solicitar facturas».
  const paso = page.getByTestId('perfil-un-paso');
  await expect(paso).toBeVisible();
  await expect(page.getByLabel(/Nombre de perfil/)).toHaveValue('Marta Compradora Ruiz');
  await expect(page.locator('#ob-doc')).toHaveCount(0);
  await expect(page.getByText(/facturas/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Tus notificaciones' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Atrás' })).toHaveCount(0);
  await capturas(page, '08-perfil-un-paso-tras-comprar');

  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL(new RegExp(`/courses/${courseSlug}`), { timeout: 30_000 });
  await expect(page.getByText(CURSO).first()).toBeVisible({ timeout: 20_000 });
  expect(vistas.some((p) => p.startsWith('/community'))).toBe(false);
  const [completado] = sql(
    `SELECT coalesce(u.onboarding_completed_at::text, '') FROM "user" u JOIN tenant t ON t.id = u.tenant_id ` +
      `WHERE u.email = '${COMPRADORA}' AND t.slug = '${tenant.slug}'`,
  ).split('\n');
  expect(completado).not.toBe('');
  await ctx.close();
});

test('4 control: la alumna del mismo aula entra a la comunidad, no a «Empieza aquí»', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const ctx = await contexto(browser);
  const page = await ctx.newPage();
  const vistas = rastro(page);
  await entrarPorElLogin(page, tenant.base, COMPRADORA);
  await page.waitForURL(/\/community/, { timeout: 30_000 });
  expect(vistas.some((p) => p.startsWith('/start'))).toBe(false);
  await ctx.close();
});

test('4 control: el administrador de un aula del modo completo sigue entrando a la comunidad', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const base = process.env.E2E_BASE_URL ?? 'http://localhost:3010';
  const ctx = await contexto(browser, base);
  const page = await ctx.newPage();
  const vistas = rastro(page);
  await entrarPorElLogin(
    page,
    base,
    process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@example.test',
    process.env.E2E_ADMIN_PASSWORD ?? PASSWORD,
  );
  await page.waitForURL(/\/community/, { timeout: 30_000 });
  expect(vistas.some((p) => p.startsWith('/start'))).toBe(false);
  await ctx.close();
});
