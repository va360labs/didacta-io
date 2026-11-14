/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';

/**
 * Valentín: «traduce el aula entera al portugués de Brasil, para que una
 * academia pueda funcionar 100 % en portugués». Este spec monta un aula NUEVA
 * del modo sencillo con el idioma del aula en portugués (lo que deja Didacta
 * Cloud al aprovisionarla con `locale: pt-BR`, o Ajustes) y la recorre como lo
 * haría cada persona, SIN cookie de idioma (el idioma sale del aula y del
 * perfil, no de un atajo del test):
 *
 *  - la creadora, desde su primer acceso por la UI (contraseña, perfil, alta
 *    en 3 preguntas) y luego todo lo que se alcanza desde su armazón;
 *  - una alumna del aula, desde la comunidad;
 *  - un visitante sin sesión (acceso, catálogo, página de venta).
 *
 * En cada pantalla lee el texto visible (más los `placeholder`, `aria-label` y
 * `title` de lo que se ve) y falla si aparece una palabra que solo existe en
 * español o en inglés. Las palabras salen de dos listas cortas y discriminantes
 * (no del diccionario): «el», «los», «con», «aquí», «-ción»… y «the», «your»,
 * «settings»… Ninguna es una palabra portuguesa. Las excepciones son las
 * justificadas de `PERMITIDO`.
 */

const MESSAGES = path.resolve(__dirname, '..', '..', 'web', 'src', 'i18n', 'messages');
type Json = { [k: string]: Json | string };

function flat(obj: Json, prefix = '', out: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object') flat(v, key, out);
    else out[key] = v;
  }
  return out;
}
const catalogo = (l: string, ns: string) =>
  flat(JSON.parse(readFileSync(path.join(MESSAGES, l, `${ns}.json`), 'utf8')) as Json);

/**
 * El rótulo portugués de lo que en español dice `es` en el namespace `ns`.
 * Así el recorrido se lee con los textos de siempre y no se rompe si cambia la
 * redacción portuguesa.
 */
function pt(ns: string, es: string): string {
  const esCat = catalogo('es', ns);
  const key = Object.keys(esCat).find((k) => esCat[k] === es);
  if (!key) throw new Error(`«${es}» no está en es/${ns}.json`);
  const val = catalogo('pt', ns)[key];
  if (!val) throw new Error(`${ns}.${key} no tiene portugués`);
  return val;
}

/**
 * Palabras que en una pantalla portuguesa solo pueden ser español: ninguna
 * existe en portugués (las que existen en los dos, como «para», «desde»,
 * «buscar», «guardar» o «pagos», se quedan fuera a propósito).
 */
const ESPANOL = new Set([
  'el', 'los', 'las', 'del', 'y', 'una', 'unas', 'unos', 'con', 'pero', 'muy', 'cuando',
  'hay', 'ya', 'aún', 'aquí', 'allí', 'también', 'ahora', 'nuevo', 'nueva', 'nuevos',
  'nuevas', 'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'usted', 'tienes', 'tiene', 'tienen',
  'puedes', 'puede', 'quieres', 'ningún', 'ninguna', 'todavía', 'siguiente', 'cerrar',
  'añadir', 'usuario', 'usuarios', 'contraseña', 'correo', 'sesión', 'cuenta', 'alumno',
  'alumna', 'alumnos', 'lección', 'lecciones', 'clase', 'clases', 'comunidad', 'ventas',
  'precio', 'miembros', 'empieza', 'empezar', 'cargando', 'más', 'qué', 'cómo', 'dónde',
  'donde', 'son', 'hoy', 'esto', 'eso', 'hasta', 'sin', 'cobros', 'enlace', 'directo',
  'directos', 'nombre', 'fecha', 'día', 'gratis', 'listo', 'fuera', 'hola',
  'gracias', 'bienvenido', 'bienvenida', 'ayuda', 'mensaje', 'mensajes', 'cambiar', 'volver',
  'salir', 'acceso', 'acceder', 'contenido', 'calendario', 'otro', 'otra', 'otros', 'otras',
  'mismo', 'misma', 'entonces', 'luego', 'después', 'siempre', 'bien', 'bueno', 'mejor',
  'cuál', 'quién', 'hazlo', 'pulsa', 'elige', 'escribe', 'añade', 'crea', 'necesitas',
]); // prettier-ignore

/** Palabras que en una pantalla portuguesa solo pueden ser inglés. */
const INGLES = new Set([
  'the', 'and', 'or', 'your', 'you', 'with', 'of', 'to', 'in', 'on', 'at', 'from', 'is',
  'are', 'this', 'that', 'these', 'settings', 'save', 'saved', 'cancel', 'loading',
  'search', 'students', 'student', 'courses', 'course', 'community', 'sales', 'members',
  'member', 'home', 'start', 'here', 'more', 'new', 'edit', 'delete', 'upload', 'sign',
  'logout', 'password', 'live', 'free', 'price', 'lesson', 'lessons', 'welcome', 'back',
  'next', 'previous', 'close', 'add', 'create', 'view', 'hide', 'not', 'yet', 'please',
  'error', 'try', 'again', 'page', 'my', 'what', 'how', 'when', 'will', 'can', 'get',
  'share', 'copy', 'invite', 'earn', 'account', 'profile', 'help', 'select', 'choose',
  'name', 'title', 'date', 'today', 'week', 'month', 'year', 'days', 'hours', 'minutes',
  'click', 'learn', 'sell', 'buy', 'payment', 'payments', 'draft', 'published', 'pending',
  'certificate', 'events', 'messages', 'notifications', 'yes', 'done', 'none', 'empty',
]); // prettier-ignore

/**
 * Lo que puede salir en una pantalla portuguesa sin ser un fallo, y por qué:
 *  - «Powered by Didacta»: el lema de la marca, igual en todos los idiomas
 *    (el catálogo español tampoco lo traduce).
 *  - «Español (España)», «English (US)»…: endónimos en los selectores de
 *    idioma; quien no entiende la interfaz tiene que reconocer el suyo.
 *  - El código que la pantalla enseña para copiar (`<code>`, `<pre>`, `<kbd>`:
 *    «claude mcp add …») y los identificadores técnicos (`sk_live_…`): no se
 *    leen, se copian. `textoVisible` no los recoge y aquí se saltan los tokens
 *    con guion bajo o cifras.
 *  - Las iniciales del avatar («AT») y las siglas de hasta tres mayúsculas.
 * Antes de mirar se quitan URL, rutas, correos y el contenido que crea el
 * propio test (nombre de la academia, del curso, de las personas).
 */
const PERMITIDO = [
  /Powered by Didacta/g,
  /\bEspañol(?: \((?:España|Argentina)\))?/g,
  /\bEnglish(?: \(US\))?/g,
];

function palabrasAjenas(texto: string, contenido: readonly string[]): string[] {
  let limpio = texto
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\w.+-]+@[\w.-]+/g, ' ')
    .replace(/\/[\w/-]+/g, ' ');
  for (const c of contenido) limpio = limpio.split(c).join(' ');
  for (const p of PERMITIDO) limpio = limpio.replace(p, ' ');
  const malas: string[] = [];
  if (/[¿¡ñÑ]/.test(limpio)) {
    const m = /.{0,30}[¿¡ñÑ].{0,30}/.exec(limpio);
    malas.push(`signo español: «${m?.[0]?.trim()}»`);
  }
  // Una palabra con guiones es UNA palabra: «mudá-los» es portugués (el
  // pronombre pegado), no el «los» español.
  const re = /[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(limpio))) {
    const w = m[0];
    if (/[\d_]/.test(w)) continue; // identificadores técnicos
    if (/^\p{Lu}{1,3}$/u.test(w)) continue; // iniciales del avatar y siglas (AT, IVA)
    const lw = w.toLowerCase();
    const idioma =
      ESPANOL.has(lw) || /ci[oó]n(es)?$/.test(lw) ? 'español' : INGLES.has(lw) ? 'inglés' : null;
    if (!idioma) continue;
    const ctx = limpio
      .slice(Math.max(0, m.index - 35), m.index + w.length + 35)
      .replace(/\s+/g, ' ');
    malas.push(`${idioma} «${w}»: …${ctx.trim()}…`);
  }
  return malas;
}

test('el detector discrimina: marca español e inglés y deja pasar el portugués', () => {
  expect(palabrasAjenas('Comece aqui · Comunidade · Ao vivo · Configurações', [])).toEqual([]);
  expect(palabrasAjenas('Sua escola já está à venda. Convide e ganhe.', [])).toEqual([]);
  expect(palabrasAjenas('Powered by Didacta', [])).toEqual([]);
  expect(palabrasAjenas('Empieza aquí', [])).toHaveLength(2);
  expect(palabrasAjenas('Configuración', [])).toHaveLength(1);
  expect(palabrasAjenas('¿Te atascas?', [])).toHaveLength(1);
  expect(palabrasAjenas('Your settings', [])).toHaveLength(2);
  expect(palabrasAjenas('Café Primeiro Gole', ['Primeiro Gole'])).toEqual([]);
  // Pronombre pegado (portugués), endónimos e identificadores no cuentan.
  expect(palabrasAjenas('Você pode mudá-los quando quiser.', [])).toEqual([]);
  expect(palabrasAjenas('Español (España) · English (US)', [])).toEqual([]);
  expect(palabrasAjenas('sk_test_… ou sk_live_…', [])).toEqual([]);
  expect(palabrasAjenas('AT Comunidade · Voltar para a lista', [])).toEqual([]);
  // Control: el «los» suelto sí.
  expect(palabrasAjenas('Todos los cursos', [])).toHaveLength(1);
});

/** Texto visible de la pantalla, con lo que se ve sin ser texto (placeholder…). */
async function textoVisible(page: Page): Promise<string> {
  return page.evaluate(() => {
    // El código que se enseña para copiar no se lee: fuera del texto.
    const codigo = Array.from(document.querySelectorAll('code, pre, kbd')) as HTMLElement[];
    const antes = codigo.map((c) => c.style.display);
    for (const c of codigo) c.style.display = 'none';
    const partes = [document.body.innerText];
    codigo.forEach((c, i) => (c.style.display = antes[i] ?? ''));
    for (const el of Array.from(
      document.querySelectorAll('[placeholder], [aria-label], [title]'),
    )) {
      const h = el as HTMLElement;
      if (!h.offsetParent && h.tagName !== 'BODY') continue; // oculto
      for (const a of ['placeholder', 'aria-label', 'title']) {
        const v = h.getAttribute(a);
        if (v) partes.push(v);
      }
    }
    partes.push(document.title);
    return partes.join('\n');
  });
}

interface Hallazgos {
  visitadas: string[];
  malas: string[];
}

async function revisar(page: Page, r: Hallazgos, donde: string, contenido: readonly string[]) {
  for (const m of palabrasAjenas(await textoVisible(page), contenido)) {
    const linea = `${donde} → ${m}`;
    if (!r.malas.includes(linea)) r.malas.push(linea);
  }
}

async function asentar(page: Page) {
  await page.waitForLoadState('load');
  await expect(page.locator('body')).toBeVisible();
  await page.waitForTimeout(1200);
}

/** Enlaces internos de la página (sin descargas ni API). */
async function enlaces(page: Page, origin: string): Promise<string[]> {
  const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => (a as HTMLAnchorElement).href));
  const internos: string[] = [];
  for (const href of hrefs) {
    if (!href.startsWith(origin)) continue;
    const u = new URL(href);
    if (u.pathname.startsWith('/api/')) continue;
    if (/\.(pdf|ics|csv|zip|xml)$/i.test(u.pathname)) continue;
    // Salir de la sesión acabaría el recorrido.
    if (/sign-?out|logout/.test(u.pathname)) continue;
    internos.push(`${u.pathname}${u.search}`);
  }
  return internos;
}

/** Recorre en anchura lo alcanzable desde `inicio` y revisa cada pantalla. */
async function recorrer(
  page: Page,
  origin: string,
  r: Hallazgos,
  inicio: string,
  max: number,
  contenido: readonly string[],
) {
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
    r.visitadas.push(ruta);
    await revisar(page, r, ruta, contenido);
    const encontrados = await enlaces(page, origin);
    if (primera) {
      primera = false;
      // El menú del perfil solo pinta sus enlaces abierto.
      const perfil = page.getByRole('button', { name: pt('modoSencillo', 'Tu perfil') });
      if (await perfil.isVisible().catch(() => false)) {
        await perfil.click();
        await revisar(page, r, `${ruta} (menú del perfil)`, contenido);
        encontrados.push(...(await enlaces(page, origin)));
        await page.keyboard.press('Escape');
      }
    }
    for (const e of encontrados) if (!vistas.has(e.split('#')[0]!)) cola.push(e);
  }
  return vistas;
}

/** Sin cookie de idioma: el idioma lo pone el aula (y luego el perfil). */
async function contexto(browser: Browser) {
  return browser.newContext({ locale: 'pt-BR', viewport: { width: 1440, height: 900 } });
}

const ACADEMIA = 'Primeiro Gole';
const CURSO = 'Espresso em casa';
const CREADORA = 'Clara Barista';

/** Primer acceso por la UI, igual que una creadora recién llegada, en portugués. */
async function primerAccesoCreadora(page: Page, tenant: FreshTenant, r: Hallazgos) {
  const contenido = [ACADEMIA, CURSO, CREADORA, tenant.slug];
  await page.goto(tenant.setPasswordUrl);
  await asentar(page);
  await revisar(page, r, '/reset-password', contenido);
  const pw = page.locator('input[type="password"]');
  await pw.nth(0).fill(tenant.password);
  await pw.nth(1).fill(tenant.password);
  await page.locator('button[type="submit"]').last().click();
  await page.waitForURL(/\/signin/, { timeout: 20_000 });
  await asentar(page);
  await revisar(page, r, '/signin', contenido);
  await page.locator('input[autocomplete="email"]').fill(tenant.creatorEmail);
  await page.locator('input[autocomplete="current-password"]').fill(tenant.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
  await asentar(page);
  await revisar(page, r, '/onboarding', contenido);
  await page.getByRole('button', { name: pt('modoSencillo', 'Dejar para luego') }).click();
  await page.getByLabel(new RegExp(pt('auth', 'Nombre de perfil'))).fill(CREADORA);
  await revisar(page, r, '/onboarding (perfil)', contenido);
  await page.getByRole('button', { name: pt('auth', 'Continuar') }).click();
  await expect(page.getByRole('heading', { name: pt('auth', 'Tus notificaciones') })).toBeVisible();
  await revisar(page, r, '/onboarding (notificaciones)', contenido);
  await page.getByRole('button', { name: pt('auth', 'Continuar') }).click();
  await revisar(page, r, '/onboarding (final)', contenido);
  await page.getByRole('button', { name: pt('modoSencillo', 'Seguir con mi academia') }).click();
  await page.waitForURL(/\/welcome/, { timeout: 30_000 });
  await asentar(page);
  await revisar(page, r, '/welcome (1)', contenido);
  // El idioma del alta llega preseleccionado en portugués, sin tocarlo.
  await expect(page.locator('select').filter({ hasText: 'Português (Brasil)' })).toHaveValue('pt');
  await page.getByLabel(pt('modoSencillo', 'Nombre de la academia')).fill(ACADEMIA);
  await page.getByRole('button', { name: pt('modoSencillo', 'Siguiente') }).click();
  await revisar(page, r, '/welcome (2)', contenido);
  await page.getByLabel(pt('modoSencillo', '¿Cómo se llama el curso?')).fill(CURSO);
  await page.getByRole('button', { name: pt('modoSencillo', 'Siguiente') }).click();
  await revisar(page, r, '/welcome (3)', contenido);
  await page.getByLabel(pt('modoSencillo', 'Precio')).first().fill('49');
  await page.getByRole('button', { name: pt('modoSencillo', 'Crear mi academia') }).click();
  await page.waitForURL(/\/start/, { timeout: 30_000 });
  await expect(page.getByTestId('empieza-aqui')).toBeVisible();
  await expect(page.getByRole('link', { name: pt('modoSencillo', 'Empieza aquí') })).toBeVisible();
}

test('aula en portugués: ni la creadora, ni la alumna, ni un visitante ven español o inglés', async ({
  browser,
}) => {
  test.setTimeout(900_000);
  const tenant = await freshTenant(`ptbr${Date.now().toString(36)}`, true);
  const origin = tenant.base;
  const contenido = [ACADEMIA, CURSO, CREADORA, tenant.slug, 'Aluna Teste'];

  // El idioma del aula, como lo deja Cloud al aprovisionar con `pt-BR` (la
  // API guarda el código del catálogo, `pt`).
  const op = await apiAs<{ tokens: { accessToken: string } }>(tenant.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: {
      tenantSlug: tenant.slug,
      email: `operador@${tenant.slug}.test`,
      password: tenant.password,
    },
  });
  await apiAs(tenant.host, '/api/v1/admin/tenant-settings/academy', {
    method: 'PUT',
    bearer: op.tokens.accessToken,
    body: { locale: 'pt' },
  });
  expect(sql(`SELECT value_json #>> '{}' FROM tenant_setting WHERE module_name = 'academy' AND key = 'locale' AND tenant_id = (SELECT id FROM tenant WHERE slug = '${tenant.slug}')`)).toBe('pt'); // prettier-ignore

  // ── La creadora ─────────────────────────────────────────────────────────
  const ctx = await contexto(browser);
  const page = await ctx.newPage();
  const creadora: Hallazgos = { visitadas: [], malas: [] };
  await primerAccesoCreadora(page, tenant, creadora);
  const vistasCreadora = await recorrer(page, origin, creadora, '/start', 45, contenido);
  // El recorrido llegó a las zonas de gestión (si no, «nada en español» no
  // probaría nada).
  for (const zona of ['/studio/courses', '/studio/live', '/admin/settings', '/community']) {
    expect(
      [...vistasCreadora].some((v) => v.startsWith(zona)),
      `la creadora no llegó a ${zona}`,
    ).toBe(true);
  }
  await ctx.close();

  // ── Una alumna del aula ─────────────────────────────────────────────────
  const email = `aluna@${tenant.slug}.test`;
  await apiAs(tenant.host, '/api/v1/admin/users', {
    method: 'POST',
    bearer: op.tokens.accessToken,
    body: { email, role: 'alumno' },
  });
  // Nace con el idioma del aula: los correos que reciba antes de entrar,
  // también.
  expect(sql(`SELECT locale FROM "user" WHERE email = '${email}'`)).toBe('pt-BR');
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
    body: { name: 'Aluna Teste', avatarUrl: '/api/v1/storage/file/avatars/e2e-harness.png' },
  });
  await apiAs(tenant.host, '/api/v1/me/onboarding/complete', {
    method: 'POST',
    bearer: alumnaTokens.tokens.accessToken,
  });

  const actx = await contexto(browser);
  const a = await actx.newPage();
  const alumna: Hallazgos = { visitadas: [], malas: [] };
  await a.goto(`${origin}/signin`);
  await a.locator('input[autocomplete="email"]').fill(email);
  await a.locator('input[autocomplete="current-password"]').fill(tenant.password);
  await a.locator('button[type="submit"]').click();
  await a.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
  const vistasAlumna = await recorrer(a, origin, alumna, '/community', 30, contenido);
  for (const zona of ['/community', '/courses', '/account']) {
    expect(
      [...vistasAlumna].some((v) => v.startsWith(zona)),
      `la alumna no llegó a ${zona}`,
    ).toBe(true);
  }
  await actx.close();

  // ── Un visitante sin sesión ni cookie ───────────────────────────────────
  const vctx = await contexto(browser);
  const v = await vctx.newPage();
  const visitante: Hallazgos = { visitadas: [], malas: [] };
  for (const ruta of ['/signin', '/forgot-password', '/catalog', '/join']) {
    const res = await v.goto(`${origin}${ruta}`);
    if (!res || res.status() >= 400) continue;
    await asentar(v);
    visitante.visitadas.push(ruta);
    await revisar(v, visitante, ruta, contenido);
  }
  expect(visitante.visitadas).toContain('/signin');
  await vctx.close();

  const todas = [...creadora.malas, ...alumna.malas, ...visitante.malas];
  expect(todas, `Texto en español o inglés en el aula portuguesa:\n${todas.join('\n')}`).toEqual(
    [],
  );
});
