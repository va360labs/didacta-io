/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { API_URL, E2E_USER_PASSWORD, signupOnboarded, TENANT_SLUG } from '../helpers/api';
import { injectSession } from '../helpers/auth';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';

/**
 * Valentín: «se ve raro que las URL estén en español; ponlas siempre todas en
 * inglés». Este spec recorre un aula NUEVA del modo sencillo como lo haría
 * una persona y falla si alguna URL lleva un segmento de las rutas en español
 * de antes:
 *
 *  - la creadora, desde su primer acceso por la UI (contraseña, perfil,
 *    alta en 3 preguntas) y luego todo lo que se alcanza desde su armazón;
 *  - una alumna del aula, desde la comunidad.
 *
 * Se mira CADA navegación de la pestaña (también las de `router.push`, que
 * Playwright ve como `framenavigated`) y CADA enlace interno que aparece en
 * las páginas visitadas, aunque no se pulse. Los segmentos dinámicos (el slug
 * de un curso puede estar en español, es contenido) no cuentan: solo las
 * palabras de las rutas fijas de antes.
 */

/** Palabras de las rutas fijas de antes. Copia independiente de la tabla del producto. */
const VIEJAS = new Set([
  'auditoria', 'avisos', 'cobros', 'competencias', 'comunidad', 'espacios',
  'publicaciones-api', 'configuracion', 'cursos', 'categorias', 'imagenes', 'dominios',
  'encuestas', 'empresas', 'grupos', 'gamificacion', 'grupos-acceso', 'ia', 'impagos',
  'integraciones', 'invitaciones', 'licencia', 'membresia', 'metricas', 'referidos',
  'seguridad', 'solicitudes-miembros', 'nuevo', 'nueva', 'usuarios', 'importar', 'invitar',
  'formador', 'aula-virtual', 'certificados', 'correcciones', 'rutas', 'alumnos',
  'calendario', 'clase', 'menciones', 'cuenta', 'suscripciones', 'empieza', 'eventos',
  'inicio', 'mi-panel', 'mensajes', 'miembros', 'mis-certificados', 'notificaciones',
  'recursos', 'retos', 'seguimiento', 'soporte', 'acceso', 'inscripcion-miembros',
  'verificar', 'catalogo', 'condiciones-referidos', 'unete', 'bienvenida', 'sitio',
]); // prettier-ignore

/** Claves de query de antes. */
const QUERY_VIEJAS = ['anadir', 'completo', 'vuelta', 'renovar', 'grupo', 'vista'];

/**
 * Valores de query de antes: los de `?tab=` de cada pantalla (cuenta, panel,
 * ajustes y la pestaña del módulo de directos, claves de API, webhooks,
 * expediente) y el de `?view=`. Copia independiente de la tabla del producto.
 */
const VALORES_VIEJOS = new Set([
  'datos', 'notificaciones', 'suscripcion', 'compras', 'seguridad',
  'actividad', 'negocio', 'registro', 'pagos', 'aula-virtual', 'claves', 'salientes',
  'resumen', 'formacion', 'mensajes', 'acceso', 'sanciones', 'eventos',
]); // prettier-ignore

/** Claves cuyo valor es contenido del aula (una búsqueda, una categoría): pueden ir en español. */
const QUERY_CONTENIDO = new Set(['q', 'category', 'ref', 'email', 'name', 'member']);

/** Anclas de antes. */
const ANCLAS_VIEJAS = new Set(['referidos', 'enlace']);

/**
 * Lo primero en español de una URL: una clave o un valor de query de antes,
 * un ancla de antes o un segmento fijo de las rutas de antes (no un id ni un
 * slug de contenido). `null` si va toda en inglés.
 */
function segmentoEspanol(url: string): string | null {
  const { pathname, searchParams, hash } = new URL(url, 'http://x');
  if (pathname.startsWith('/api/')) return null;
  const clave = QUERY_VIEJAS.find((k) => searchParams.has(k));
  if (clave) return `?${clave}=`;
  for (const [k, v] of searchParams) {
    if (QUERY_CONTENIDO.has(k) || k.startsWith('utm_')) continue;
    if (VALORES_VIEJOS.has(v)) return `?${k}=${v}`;
  }
  const ancla = decodeURIComponent(hash.slice(1));
  if (ANCLAS_VIEJAS.has(ancla)) return `#${ancla}`;
  const segs = pathname.split('/').filter(Boolean);
  // `/catalog/<slug>`, `/courses/<slug>`, `/spaces/<slug>`, `/paths/<slug>`…: el
  // segundo segmento es contenido del aula. Solo cuentan los fijos del App
  // Router, que en el aula son siempre los primeros o van tras «admin/studio».
  const fijos = segs[0] === 'admin' || segs[0] === 'studio' ? segs.slice(0, 3) : segs.slice(0, 1);
  if (segs[0] === 'studio' && segs[1] === 'courses' && segs[3]) fijos.push(segs[3]);
  return fijos.find((s) => VIEJAS.has(decodeURIComponent(s))) ?? null;
}

test('el detector discrimina: marca las rutas de antes y deja pasar las nuevas', () => {
  expect(segmentoEspanol('http://a.test/comunidad/abc')).toBe('comunidad');
  expect(segmentoEspanol('/formador/cursos/x')).toBe('formador');
  expect(segmentoEspanol('/studio/courses/x/alumnos')).toBe('alumnos');
  expect(segmentoEspanol('/admin/configuracion?tab=x')).toBe('configuracion');
  expect(segmentoEspanol('/studio/courses/x?anadir=1')).toBe('?anadir=');
  expect(segmentoEspanol('/admin/payments?completo=1')).toBe('?completo=');
  expect(segmentoEspanol('/studio/courses/x?add=1')).toBeNull();
  expect(segmentoEspanol('/community/abc')).toBeNull();
  expect(segmentoEspanol('/catalog/curso-de-acuarela')).toBeNull();
  // El slug de un curso puede ser una palabra española: es contenido.
  expect(segmentoEspanol('/courses/cursos-de-cocina')).toBeNull();
  expect(segmentoEspanol('/api/v1/formador/stats')).toBeNull();
  // Valores de query y anclas de antes.
  expect(segmentoEspanol('/account?tab=seguridad')).toBe('?tab=seguridad');
  expect(segmentoEspanol('/admin?tab=negocio&x=1')).toBe('?tab=negocio');
  expect(segmentoEspanol('/admin/settings?tab=aula-virtual')).toBe('?tab=aula-virtual');
  expect(segmentoEspanol('/calendar?view=eventos')).toBe('?view=eventos');
  expect(segmentoEspanol('/admin/payments#referidos')).toBe('#referidos');
  expect(segmentoEspanol('/admin/payments?full=1#enlace')).toBe('#enlace');
  expect(segmentoEspanol('/account?tab=security')).toBeNull();
  expect(segmentoEspanol('/admin/settings?tab=virtual-classroom')).toBeNull();
  expect(segmentoEspanol('/calendar?view=events')).toBeNull();
  expect(segmentoEspanol('/admin/payments#referrals')).toBeNull();
  // Una búsqueda o una categoría en español es contenido.
  expect(segmentoEspanol('/courses?q=seguridad&category=pagos')).toBeNull();
});

interface Recorrido {
  visitadas: string[];
  malas: string[];
}

/**
 * Vigila la pestaña: cada navegación con un segmento español se apunta.
 * Devuelve el registro que va llenando.
 */
function vigilar(page: Page, origin: string): Recorrido {
  const r: Recorrido = { visitadas: [], malas: [] };
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (!url.startsWith(origin)) return;
    r.visitadas.push(url.slice(origin.length));
    const s = segmentoEspanol(url);
    if (s) r.malas.push(`navegó a ${url} («${s}»)`);
  });
  return r;
}

/** Enlaces internos de la página; apunta los que llevan un segmento español. */
async function enlaces(page: Page, origin: string, r: Recorrido, desde: string): Promise<string[]> {
  const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => (a as HTMLAnchorElement).href));
  const internos: string[] = [];
  for (const href of hrefs) {
    if (!href.startsWith(origin)) continue;
    const s = segmentoEspanol(href);
    if (s) r.malas.push(`enlace a ${href} («${s}») en ${desde}`);
    const u = new URL(href);
    if (u.pathname.startsWith('/api/')) continue;
    if (/\.(pdf|ics|csv|zip|xml)$/i.test(u.pathname)) continue;
    internos.push(`${u.pathname}${u.search}`);
  }
  return internos;
}

/** Espera a que la página pinte sus enlaces (el armazón y los datos de la API). */
async function asentar(page: Page) {
  await page.waitForLoadState('load');
  await expect(page.locator('body')).toBeVisible();
  // Los enlaces del contenido llegan con los datos de la API.
  await page.waitForTimeout(1200);
}

/**
 * Recorre en anchura todo lo que se alcanza desde `inicio` por enlaces
 * internos, hasta `max` páginas. En la primera abre también el menú del
 * perfil, que solo pinta sus enlaces abierto.
 */
async function recorrer(page: Page, origin: string, r: Recorrido, inicio: string, max: number) {
  const cola = [inicio];
  const vistas = new Set<string>();
  let primera = true;
  while (cola.length > 0 && vistas.size < max) {
    const ruta = cola.shift()!;
    const clave = ruta.split('#')[0]!;
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    await page.goto(`${origin}${ruta}`);
    await asentar(page);
    const encontrados = await enlaces(page, origin, r, ruta);
    if (primera) {
      primera = false;
      const perfil = page.getByRole('button', { name: 'Tu perfil' });
      if (await perfil.isVisible()) {
        await perfil.click();
        encontrados.push(...(await enlaces(page, origin, r, `${ruta} (menú del perfil)`)));
        await perfil.click();
      }
    }
    for (const e of encontrados) if (!vistas.has(e.split('#')[0]!)) cola.push(e);
  }
  return vistas;
}

/** Primer acceso por la UI, igual que una creadora recién llegada. */
async function primerAccesoCreadora(page: Page, tenant: FreshTenant) {
  await page.goto(tenant.setPasswordUrl);
  const pw = page.locator('input[type="password"]');
  await pw.nth(0).fill(tenant.password);
  await pw.nth(1).fill(tenant.password);
  await page
    .getByRole('button', { name: /contraseña|password/i })
    .last()
    .click();
  await page.waitForURL(/\/signin/, { timeout: 20_000 });
  await page.locator('input[autocomplete="email"]').fill(tenant.creatorEmail);
  await page.locator('input[autocomplete="current-password"]').fill(tenant.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Dejar para luego' }).click();
  await page.getByLabel(/Nombre de perfil/).fill('Clara Acuarela');
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Tus notificaciones' })).toBeVisible();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Seguir con mi academia' }).click();
  await page.waitForURL(/\/welcome/, { timeout: 30_000 });
  await page.getByLabel('Nombre de la academia').fill('Taller de Acuarela');
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await page.getByLabel('¿Cómo se llama el curso?').fill('Acuarela desde cero');
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await page.getByLabel('Precio').fill('49');
  await page.getByRole('button', { name: 'Crear mi academia' }).click();
  await page.waitForURL(/\/start/, { timeout: 30_000 });
  await expect(page.getByTestId('empieza-aqui')).toBeVisible();
}

async function contexto(browser: Browser, base: string) {
  const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'didacta_locale', value: 'es-ES', url: base }]);
  return ctx;
}

test('modo sencillo: ni la creadora ni la alumna ven una URL en español', async ({ browser }) => {
  test.setTimeout(600_000);
  const tenant = await freshTenant(`urlsen${Date.now().toString(36)}`, true);
  const origin = tenant.base;

  // ── La creadora: primer acceso por la UI y todo su armazón ─────────────
  const ctx = await contexto(browser, origin);
  const page = await ctx.newPage();
  const creadora = vigilar(page, origin);
  await primerAccesoCreadora(page, tenant);
  // El primer acceso pasó por /onboarding y /welcome y acabó en /start.
  expect(creadora.visitadas.some((v) => v.startsWith('/welcome'))).toBe(true);
  const vistasCreadora = await recorrer(page, origin, creadora, '/start', 45);
  // El recorrido llegó a las zonas de gestión (si no, «sin URL en español»
  // no probaría nada).
  for (const zona of ['/studio/courses', '/studio/live', '/admin/settings', '/community']) {
    expect(
      [...vistasCreadora].some((v) => v.startsWith(zona)),
      `la creadora no llegó a ${zona}`,
    ).toBe(true);
  }
  expect(creadora.malas, creadora.malas.join('\n')).toEqual([]);

  // Un enlace guardado con el ancla de antes (y con la ruta de antes): la URL
  // pasa a la nueva. Va después de la comprobación de arriba porque la primera
  // navegación es, a propósito, a la URL vieja.
  await page.goto(`${origin}/admin/cobros#referidos`);
  await expect(page).toHaveURL(`${origin}/admin/payments#referrals`);
  await page.goto(`${origin}/admin/payments#enlace`);
  await expect(page).toHaveURL(`${origin}/admin/payments#sale-link`);
  await ctx.close();

  // ── Una alumna del aula ────────────────────────────────────────────────
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
  const email = `alumna@${tenant.slug}.test`;
  await apiAs(tenant.host, '/api/v1/admin/users', {
    method: 'POST',
    bearer: tokens.accessToken,
    body: { email, role: 'alumno' },
  });
  const token = randomBytes(24).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  sql(
    `INSERT INTO password_reset_token (id, user_id, tenant_id, token_hash, expires_at, created_at) ` +
      `SELECT gen_random_uuid(), u.id, u.tenant_id, '${hash}', now() + interval '1 day', now() ` +
      `FROM "user" u WHERE u.email = '${email}'`,
  );
  await apiAs(tenant.host, '/api/v1/auth/reset-password', {
    method: 'POST',
    body: { token, newPassword: tenant.password },
  });
  const alumnaTokens = await apiAs<{ tokens: { accessToken: string } }>(
    tenant.host,
    '/api/v1/auth/signin',
    { method: 'POST', body: { tenantSlug: tenant.slug, email, password: tenant.password } },
  );
  await apiAs(tenant.host, '/api/v1/me/profile', {
    method: 'PATCH',
    bearer: alumnaTokens.tokens.accessToken,
    body: { name: 'Alumna', avatarUrl: '/api/v1/storage/file/avatars/e2e-harness.png' },
  });
  await apiAs(tenant.host, '/api/v1/me/onboarding/complete', {
    method: 'POST',
    bearer: alumnaTokens.tokens.accessToken,
  });

  const actx = await contexto(browser, origin);
  const a = await actx.newPage();
  const alumna = vigilar(a, origin);
  await a.goto(`${origin}/signin`);
  await a.locator('input[autocomplete="email"]').fill(email);
  await a.locator('input[autocomplete="current-password"]').fill(tenant.password);
  await a.locator('button[type="submit"]').click();
  await a.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
  const vistasAlumna = await recorrer(a, origin, alumna, '/community', 30);
  for (const zona of ['/community', '/courses', '/account']) {
    expect(
      [...vistasAlumna].some((v) => v.startsWith(zona)),
      `la alumna no llegó a ${zona}`,
    ).toBe(true);
  }
  expect(alumna.malas, alumna.malas.join('\n')).toEqual([]);
  await actx.close();
});

/**
 * El modo completo, como administrador: cada pestaña que se pulsa en cuenta,
 * panel, ajustes (con la que aporta el módulo de directos), claves de API,
 * webhooks, SSO y el expediente de un miembro deja la URL en inglés, también
 * su `?tab=`. Y los enlaces que pinta cada pantalla.
 */
test('modo completo: ninguna pestaña deja un valor en español en la URL', async ({ page }) => {
  test.setTimeout(240_000);
  const res = await fetch(`${API_URL}/api/v1/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantSlug: TENANT_SLUG,
      email: process.env.E2E_ADMIN_EMAIL,
      password: process.env.E2E_ADMIN_PASSWORD,
    }),
  });
  expect(res.ok, `signin admin (${res.status})`).toBe(true);
  const auth = (await res.json()) as {
    tokens: { accessToken: string; refreshToken: string };
    user: Parameters<typeof injectSession>[1]['user'];
  };
  const miembro = await signupOnboarded({
    tenantSlug: TENANT_SLUG,
    email: `urls-pestanas-${Date.now().toString(36)}@e2e.test`,
    password: E2E_USER_PASSWORD,
    name: 'Miembro de las pestañas',
  });

  await page.goto('/signin');
  await injectSession(page, {
    accessToken: auth.tokens.accessToken,
    refreshToken: auth.tokens.refreshToken,
    user: { ...auth.user, onboardingCompletedAt: new Date().toISOString() },
  });
  const origin = new URL(page.url()).origin;
  const r = vigilar(page, origin);

  const pantallas = [
    '/account',
    '/admin',
    '/admin/settings',
    '/admin/api-keys',
    '/admin/webhooks',
    '/admin/sso',
    `/u/${miembro.user.id}`,
    '/events',
  ];
  for (const ruta of pantallas) {
    await page.goto(`${origin}${ruta}`);
    await asentar(page);
    await enlaces(page, origin, r, ruta);
    // Las pestañas: las de `role="tab"` y las del expediente.
    const pestanas = page.locator('[role="tab"], [data-testid^="dossier-tab-"]');
    const n = await pestanas.count();
    for (let i = 0; i < n; i++) {
      const p = pestanas.nth(i);
      if (!(await p.isVisible())) continue;
      await p.click();
      await page.waitForTimeout(400);
      await enlaces(page, origin, r, `${ruta} (pestaña ${i + 1})`);
    }
  }

  // Control: el recorrido pasó de verdad por las pestañas que escriben la URL
  // (si no, «ningún valor en español» no probaría nada).
  for (const esperada of [
    '/admin?tab=business',
    '/admin/settings?tab=registration',
    '/admin/settings?tab=payments',
    '/admin/settings?tab=virtual-classroom',
    '/admin/api-keys?tab=docs',
    '/admin/webhooks?tab=zoom',
    '/admin/sso?tab=saml',
    '/calendar?view=events',
  ]) {
    expect(r.visitadas, `no pasó por ${esperada}`).toContain(esperada);
  }
  expect(r.malas, r.malas.join('\n')).toEqual([]);
});
