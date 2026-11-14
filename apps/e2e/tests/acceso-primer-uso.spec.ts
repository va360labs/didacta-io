/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';
import { startStripeDouble, type StripeDouble } from '../helpers/stripe-double';

/**
 * ACCESO Y PRIMER USO, lo que encontró el ensayo general de Didacta Cloud
 * (14-nov-2026), en un aula NUEVA en modo sencillo y en español:
 *
 *  1. La creadora define su contraseña y ENTRA SOLA (nunca pasa por
 *     «Bienvenido de nuevo» con el correo en blanco); su perfil no le pide el
 *     DNI de los alumnos.
 *  2. La lección de texto interpreta el formato (`**Material:**` en negrita).
 *  3. La ficha pública enseña el temario; la portada sin foto no deja el hueco
 *     con las iniciales.
 *  4. La alumna entra sola y acaba en el curso del enlace (`next`), no en la
 *     comunidad; sin proveedor de IA no ve el tutor, y la creadora ve que está
 *     apagado y dónde encenderlo.
 *  5. Ficha del curso para quien aún no lo tiene: solo promete lo que es
 *     verdad y no dice «Este curso aún no tiene descripción».
 *  6. Un enlace caducado ofrece otro con un clic (uno por enlace).
 *  7. El panel del agente lista y revoca las claves de agente.
 *
 * Con `E2E_CAPTURAS_DIR`, deja capturas de cada pantalla en esa carpeta.
 */

const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'E2eAdminPassword123!';
const CURSO = 'Torno para principiantes';
const LECCION = 'Bienvenida al torno';
const TEXTO =
  'Hola y bienvenida.\n\n**Material:** 1 kg de gres, esponja y alambre.\n\n- Centrar\n- Abrir';
const CAPTURAS = process.env.E2E_CAPTURAS_DIR;

let stripe: StripeDouble;
let tenant: FreshTenant;
let creatorCtx: BrowserContext;
let creator: Page;
let courseSlug = '';
let courseId = '';

test.describe.configure({ mode: 'serial' });

async function captura(page: Page, nombre: string) {
  if (!CAPTURAS) return;
  mkdirSync(CAPTURAS, { recursive: true });
  await page.screenshot({ path: path.join(CAPTURAS, `${nombre}.png`), fullPage: true });
}

async function contexto(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    locale: 'es-ES',
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: tenant.base }]);
  return ctx;
}

/** Enlace de «define tu contraseña» como el del correo, con su validez. */
function enlace(email: string, opts: { caducado?: boolean; next?: string } = {}): string {
  const token = randomBytes(24).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  const [creado, caduca] = opts.caducado
    ? ["now() - interval '8 days'", "now() - interval '1 day'"]
    : ['now()', "now() + interval '7 days'"];
  sql(
    `INSERT INTO password_reset_token (id, user_id, tenant_id, token_hash, expires_at, created_at) ` +
      `SELECT gen_random_uuid(), u.id, u.tenant_id, '${hash}', ${caduca}, ${creado} ` +
      `FROM "user" u JOIN tenant t ON t.id = u.tenant_id WHERE u.email = '${email}' AND t.slug = '${tenant.slug}'`,
  );
  const next = opts.next ? `&next=${encodeURIComponent(opts.next)}` : '';
  return `${tenant.base}/reset-password?token=${token}${next}`;
}

/** Rutas por las que pasa la pestaña (para afirmar que NO pasa por /signin). */
function rastro(page: Page): string[] {
  const vistas: string[] = [];
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) vistas.push(new URL(f.url()).pathname);
  });
  return vistas;
}

async function guardarContrasena(page: Page) {
  const pw = page.locator('input[type="password"]');
  await pw.nth(0).fill(PASSWORD);
  await pw.nth(1).fill(PASSWORD);
  await page.getByRole('button', { name: 'Guardar nueva contraseña' }).click();
}

async function tokenDe(email: string): Promise<string> {
  const r = await apiAs<{ tokens: { accessToken: string } }>(tenant.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: tenant.slug, email, password: PASSWORD },
  });
  return r.tokens.accessToken;
}

async function crearAlumna(email: string, nombre: string): Promise<string> {
  const r = await apiAs<{ id: string }>(tenant.host, '/api/v1/admin/users', {
    method: 'POST',
    bearer: await tokenDe(tenant.creatorEmail),
    body: { email, role: 'alumno', name: nombre },
  });
  return r.id;
}

/** Perfil de primer acceso de una alumna, sin foto ni cambios. */
async function perfilAlumna(page: Page) {
  await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Entrar a la plataforma' }).click();
}

test.beforeAll(async ({ browser }) => {
  stripe = await startStripeDouble();
  tenant = await freshTenant(`acceso${Date.now().toString(36)}`, true);
  creatorCtx = await contexto(browser);
  creator = await creatorCtx.newPage();
  creator.on('dialog', (d) => void d.accept());
});

test.afterAll(async () => {
  await creatorCtx?.close();
  await stripe?.close();
});

test('1: la creadora define su contraseña y entra sola; su perfil no le pide el DNI', async () => {
  test.setTimeout(150_000);
  const vistas = rastro(creator);
  await creator.goto(tenant.setPasswordUrl);
  await expect(creator.getByRole('button', { name: 'Guardar nueva contraseña' })).toBeVisible();
  await captura(creator, '01-es-definir-contrasena');
  await guardarContrasena(creator);

  // Directo al perfil de primer acceso, con la sesión abierta.
  await creator.waitForURL(/\/onboarding/, { timeout: 30_000 });
  await expect(creator.getByRole('heading', { name: 'Preséntate a tus alumnos' })).toBeVisible();
  expect(vistas.some((p) => p.startsWith('/signin'))).toBe(false);
  expect(await creator.evaluate(() => localStorage.getItem('didacta.access_token'))).toBeTruthy();
  await captura(creator, '02-es-primer-acceso-sin-signin');

  await creator.getByRole('button', { name: 'Dejar para luego' }).click();
  await creator.getByLabel(/Nombre de perfil/).fill('Lucía Ensayo');
  // El DNI/NIE es cosa de alumnos (facturas de lo que pagan): a ella no se le pide.
  await expect(creator.locator('#ob-doc')).toHaveCount(0);
  await expect(creator.getByText(/facturas de pago/)).toHaveCount(0);
  await captura(creator, '03-es-perfil-creadora-sin-dni');
  await creator.getByRole('button', { name: 'Continuar' }).click();
  await creator.getByRole('button', { name: 'Continuar' }).click();
  await creator.getByRole('button', { name: 'Seguir con mi academia' }).click();
  await creator.waitForURL(/\/welcome/, { timeout: 30_000 });

  await creator.getByLabel('Nombre de la academia').fill('Cerámica con Lucía');
  await creator.getByRole('button', { name: 'Siguiente' }).click();
  await creator.getByLabel('¿Cómo se llama el curso?').fill(CURSO);
  await creator.getByRole('button', { name: 'Siguiente' }).click();
  await creator.getByLabel('Precio').fill('49');
  await creator.getByRole('button', { name: 'Crear mi academia' }).click();
  await creator.waitForURL(/\/start/, { timeout: 30_000 });

  const [row] = sql(
    `SELECT c.id || '|' || c.slug FROM mod_courses_course c JOIN tenant t ON t.id = c.tenant_id ` +
      `WHERE t.slug = '${tenant.slug}'`,
  ).split('\n');
  [courseId, courseSlug] = (row ?? '').split('|') as [string, string];
  expect(courseSlug).toBeTruthy();
});

test('2: lección de texto con formato, y publicar', async () => {
  test.setTimeout(90_000);
  await creator.getByRole('link', { name: 'Añadir mi primera lección' }).click();
  await expect(creator.getByTestId('editor-sencillo')).toBeVisible();
  await creator.getByTestId('tipo-TEXT').click();
  await creator.getByLabel('Título de la lección').fill(LECCION);
  await creator.getByLabel('Texto de la lección').fill(TEXTO);
  await creator.getByTestId('guardar-leccion').click();
  await expect(creator.getByText(`1. ${LECCION}`)).toBeVisible();

  await creator.goto(`${tenant.base}/start`);
  await creator.getByTestId('publicar').click();
  await expect(creator.getByTestId('copiar-enlace')).toBeEnabled({ timeout: 20_000 });
});

test('3: la ficha pública enseña el temario y la portada sin foto no deja el hueco «CL»', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const visitante = await browser.newContext({
    locale: 'es-ES',
    viewport: { width: 1440, height: 900 },
  });
  const v = await visitante.newPage();
  await v.goto(`${tenant.base}/catalog/${courseSlug}`);
  const temario = v.getByTestId('ficha-temario');
  await expect(temario).toBeVisible({ timeout: 20_000 });
  await expect(temario).toContainText('Qué incluye el curso');
  await expect(temario).toContainText(LECCION);
  await expect(temario).toContainText('1 lección');
  // Solo el título: el contenido de la lección no sale del aula.
  await expect(v.getByText('1 kg de gres')).toHaveCount(0);
  await captura(v, '04-es-ficha-publica-temario');

  await v.goto(`${tenant.base}/`);
  await expect(v.locator('#portada-nombre')).toHaveText('Cerámica con Lucía', { timeout: 20_000 });
  await expect(v.getByTestId('portada-banda')).toHaveCount(0);
  await expect(v.getByTestId('portada-imagen')).toHaveCount(0);
  await captura(v, '05-es-portada-sin-foto');
  await visitante.close();
});

test('4: la alumna entra sola y acaba en SU curso; sin proveedor de IA no ve el tutor', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const email = 'marta@acceso.test';
  const id = await crearAlumna(email, 'Marta Alumna');
  await apiAs(tenant.host, '/api/v1/modules/learning/enrollments', {
    method: 'POST',
    bearer: await tokenDe(tenant.creatorEmail),
    body: { userId: id, courseId },
  });
  const ctx = await contexto(browser);
  const page = await ctx.newPage();
  const vistas = rastro(page);
  await page.goto(enlace(email, { next: `/courses/${courseSlug}` }));
  await guardarContrasena(page);
  await perfilAlumna(page);

  // El curso del enlace, no la comunidad.
  await page.waitForURL(new RegExp(`/courses/${courseSlug}`), { timeout: 30_000 });
  expect(vistas.some((p) => p.startsWith('/signin'))).toBe(false);
  expect(vistas.some((p) => p.startsWith('/community'))).toBe(false);

  // La lección de texto, con formato.
  const texto = page.getByTestId('leccion-texto');
  await expect(texto).toBeVisible({ timeout: 20_000 });
  await expect(texto.locator('strong', { hasText: 'Material:' })).toBeVisible();
  await expect(texto.locator('li')).toHaveText(['Centrar', 'Abrir']);
  await expect(texto).not.toContainText('**');

  // Sin proveedor de IA: ni tutor ni aviso para la alumna.
  await expect(page.getByRole('heading', { name: 'Tutor IA' })).toHaveCount(0);
  await expect(page.getByTestId('tutor-ia-apagado')).toHaveCount(0);
  await captura(page, '06-es-alumna-en-su-curso');
  await ctx.close();

  // La creadora, en cambio, ve que está apagado y dónde encenderlo.
  await creator.goto(`${tenant.base}/courses/${courseSlug}`);
  const aviso = creator.getByTestId('tutor-ia-apagado');
  await expect(aviso).toBeVisible({ timeout: 20_000 });
  await expect(aviso).toContainText('El tutor IA está apagado');
  await expect(aviso.getByRole('link', { name: 'Configurar el proveedor de IA' })).toHaveAttribute(
    'href',
    '/admin/ai/providers',
  );
  await captura(creator, '07-es-creadora-tutor-apagado');
});

test('5: ficha del curso para quien aún no lo tiene: solo lo que es verdad', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const email = 'nuria@acceso.test';
  await crearAlumna(email, 'Nuria Curiosa');
  const ctx = await contexto(browser);
  const page = await ctx.newPage();
  await page.goto(enlace(email));
  await guardarContrasena(page);
  await perfilAlumna(page);
  await page.waitForURL((u) => !u.pathname.startsWith('/onboarding'), { timeout: 30_000 });

  const modulos = await apiAs<{ activeModules: string[] }>(tenant.host, '/api/v1/me/modules', {
    bearer: await tokenDe(email),
  });
  await page.goto(`${tenant.base}/courses/${courseSlug}`);
  const beneficios = page.getByTestId('beneficios-curso');
  await expect(beneficios).toBeVisible({ timeout: 20_000 });
  // Se vende con pago único: el acceso de por vida sí es verdad.
  await expect(beneficios).toContainText('Acceso de por vida', { timeout: 20_000 });
  await expect(beneficios).toContainText('a tu ritmo');
  // Certificado y comunidad, solo si el aula los tiene.
  const certificado = beneficios.getByText('Certificado verificable');
  const comunidad = beneficios.getByText('Comunidad de alumnos');
  await expect(certificado).toHaveCount(modulos.activeModules.includes('mod.certificates') ? 1 : 0);
  await expect(comunidad).toHaveCount(modulos.activeModules.includes('mod.community') ? 1 : 0);
  await expect(page.getByText('Este curso aún no tiene descripción')).toHaveCount(0);
  await captura(page, '08-es-ficha-curso-con-sesion');
  await ctx.close();
});

test('6: un enlace caducado ofrece otro con un clic (y solo uno)', async ({ browser }) => {
  test.setTimeout(90_000);
  const email = 'pedro@acceso.test';
  await crearAlumna(email, 'Pedro Tardón');
  // Los enlaces de ESTA cuenta (el mismo correo puede estar en el aula de una
  // pasada anterior del spec).
  const deLaCuenta =
    `FROM password_reset_token p JOIN "user" u ON u.id = p.user_id ` +
    `JOIN tenant t ON t.id = u.tenant_id WHERE u.email = '${email}' AND t.slug = '${tenant.slug}'`;
  const tokens = () => sql(`SELECT count(*) ${deLaCuenta}`);
  // El de la invitación que acaba de mandar `admin/users`.
  expect(Number(tokens())).toBe(1);
  const antes = Number(tokens());
  const ctx = await contexto(browser);
  const page = await ctx.newPage();
  await page.goto(enlace(email, { caducado: true }));

  // Lo dice ANTES de teclear la contraseña, y no echa a /signin.
  const caducado = page.getByTestId('enlace-caducado');
  await expect(caducado).toBeVisible({ timeout: 20_000 });
  await expect(caducado).toContainText('Este enlace ha caducado');
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await captura(page, '09-es-enlace-caducado');

  await page.getByTestId('pedir-enlace-nuevo').click();
  await expect(caducado).toContainText('te hemos enviado un enlace nuevo');
  await captura(page, '10-es-enlace-nuevo-pedido');
  expect(page.url()).toContain('/reset-password');

  // Un enlace nuevo, de 7 días como el caducado; el caducado queda quemado.
  // (La invitación que hizo `admin/users` ya dejó uno vivo, que el nuevo invalida.)
  await expect.poll(() => Number(tokens())).toBe(antes + 2);
  const vivos = sql(
    `SELECT round(extract(epoch FROM p.expires_at - p.created_at) / 86400) ${deLaCuenta} ` +
      `AND p.used_at IS NULL`,
  );
  expect(vivos).toBe('7');

  // Control: repetir con el mismo enlace caducado no manda otro.
  await page.reload();
  await expect(page.getByText('Este enlace ya se usó')).toBeVisible({ timeout: 20_000 });
  expect(Number(tokens())).toBe(antes + 2);
  await ctx.close();
});

test('7: el panel del agente lista las claves y las revoca', async () => {
  test.setTimeout(90_000);
  const token = await tokenDe(tenant.creatorEmail);
  const clave = await apiAs<{ id: string }>(tenant.host, '/api/v1/agent/keys', {
    method: 'POST',
    bearer: token,
    body: {},
  });
  await creator.goto(`${tenant.base}/studio/courses`);
  await expect(creator.getByTestId('agente-ia-panel')).toBeVisible({ timeout: 20_000 });
  await expect(creator.getByText('Ya tienes 1 clave activa')).toBeVisible({ timeout: 20_000 });
  await creator.getByTestId('agente-ia-gestionar').click();
  const lista = creator.getByTestId('agente-ia-claves');
  await expect(lista.locator('li')).toHaveCount(1);
  await expect(lista).toContainText('Creada el');
  await expect(lista).toContainText('sin usar todavía');
  // Nada de la pantalla técnica (POST /inscribe, n8n, WooCommerce).
  expect(creator.url()).toContain('/studio/courses');
  await captura(creator, '11-es-agente-claves');

  await lista.getByTestId('agente-ia-revocar').click();
  await expect(creator.getByText('Clave revocada')).toBeVisible({ timeout: 20_000 });
  await expect(creator.getByTestId('agente-ia-claves')).toHaveCount(0);
  expect(sql(`SELECT (revoked_at IS NOT NULL)::text FROM api_key WHERE id = '${clave.id}'`)).toBe(
    'true',
  );
  await captura(creator, '12-es-agente-clave-revocada');
});
