import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_URL, E2E_USER_PASSWORD, signupOnboarded, TENANT_SLUG } from '../helpers/api';
import { injectSession } from '../helpers/auth';

/**
 * Cambio de idioma de punta a punta (es-ES ↔ en-US).
 *
 * Por qué existe. La migración i18n (43 namespaces, dos catálogos) no tenía ni
 * un solo test que probara lo único para lo que existe: cambiar el idioma y ver
 * el producto en el otro idioma. La paridad de claves ya la cubre
 * `apps/web/src/i18n/messages-parity.test.ts`, pero eso es el catálogo mirándose
 * a sí mismo: no dice nada de si el idioma llega a la pantalla.
 *
 * DÓNDE SE FIJA EL IDIOMA — el gotcha que costó un barrido entero.
 * En el PERFIL (`user.locale`), NO en la cookie `didacta_locale`. Con sesión
 * activa, `LocaleSync` (apps/web/src/components/locale-sync.tsx:50-71) lee
 * `GET /me/profile` y PISA la cookie con `profile.locale`. Un spec que ponga la
 * cookie y espere inglés verá español y creerá que la traducción no existe.
 * El tercer test de este fichero afirma justamente esa precedencia, para que
 * nadie vuelva a diagnosticarlo como un bug de traducción.
 *
 * DE DÓNDE SALEN LAS ASERCIONES.
 * De los ficheros reales de `apps/web/src/i18n/messages/{es,en}/`, leídos en
 * caliente por `msg()`. No hay literales ingleses escritos a mano: si alguien
 * renombra una key, el spec falla diciendo que la key ya no existe, y si alguien
 * cambia una traducción, el spec sigue verde con el texto nuevo — que es lo
 * correcto, porque lo que se prueba es el mecanismo, no la redacción.
 *
 * RED DE SEGURIDAD.
 * `assertLocale()` corre ANTES de cualquier aserción de texto y comprueba las
 * dos puntas de la cadena (perfil y `<html lang>`). Un fallo ahí dice «el idioma
 * no se aplicó», no «no encuentro el texto».
 */

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo: fuente única de las aserciones
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Se lee por `fs` y no por `import ... from '.../nav.json'` a propósito: el
 * `tsconfig.json` de este paquete tiene `rootDir: "."`, así que un import fuera
 * de `apps/e2e/**` rompe el typecheck. El acoplamiento al catálogo es el mismo;
 * lo que cambia es que la comprobación de que la key existe es de runtime, y por
 * eso `msg()` la hace explícita.
 */
const MESSAGES_DIR = join(__dirname, '..', '..', 'web', 'src', 'i18n', 'messages');

type CatalogName = 'es' | 'en';

const catalogCache = new Map<string, unknown>();

function readNamespace(catalog: CatalogName, namespace: string): unknown {
  const cacheKey = `${catalog}/${namespace}`;
  const cached = catalogCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const file = join(MESSAGES_DIR, catalog, `${namespace}.json`);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  catalogCache.set(cacheKey, parsed);
  return parsed;
}

/**
 * Valor real del catálogo. `keyPath` admite puntos (`sidebar.logout`) y también
 * segmentos con puntos dentro si se pasan ya troceados — por eso los
 * diccionarios de nav, cuyas claves son tokens en español con espacios y
 * acentos, se piden con `navLabel()`.
 */
function msg(catalog: CatalogName, namespace: string, ...keyPath: string[]): string {
  let node: unknown = readNamespace(catalog, namespace);
  const walked: string[] = [];
  for (const part of keyPath) {
    walked.push(part);
    if (typeof node !== 'object' || node === null || !(part in (node as object))) {
      throw new Error(
        `La key "${walked.join('.')}" ya no existe en ${catalog}/${namespace}.json.\n` +
          'Este spec NO escribe literales traducidos: los saca del catálogo. Si la\n' +
          'key se ha renombrado, actualiza la referencia aquí — eso es justo lo que\n' +
          'esta comprobación existe para forzar.',
      );
    }
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== 'string') {
    throw new Error(`"${walked.join('.')}" en ${catalog}/${namespace}.json no es un string.`);
  }
  return node;
}

/** Label de grupo del sidebar (`nav.groups.<token español>`). */
function navGroup(catalog: CatalogName, token: string): string {
  return msg(catalog, 'nav', 'groups', token);
}

/** Label de item del sidebar (`nav.items.<token español>`). */
function navItem(catalog: CatalogName, token: string): string {
  return msg(catalog, 'nav', 'items', token);
}

/**
 * Par es/en de un mismo mensaje, con la garantía de que DIFIEREN.
 *
 * Sin esta guarda una aserción sobre una key que se traduce igual en los dos
 * idiomas (las hay: «Fundae», «Tags») pasaría en verde con el idioma
 * equivocado, que es exactamente el falso positivo que este fichero viene a
 * cerrar.
 */
function pair(read: (catalog: CatalogName) => string): { es: string; en: string } {
  const es = read('es');
  const en = read('en');
  expect(
    en,
    `"${es}" se traduce igual en los dos catálogos: no sirve para distinguir idioma`,
  ).not.toBe(es);
  return { es, en };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mensajes que se afirman en pantalla
// ─────────────────────────────────────────────────────────────────────────────

/** Grupos del sidebar que ve un alumno (ver `buildGroups` en lib/sidebar-nav.ts). */
const SIDEBAR_GROUPS = ['Inicio', 'Aprendizaje', 'Agenda', 'Personas'] as const;

/** Items del sidebar de un alumno que no dependen de módulos opcionales. */
const SIDEBAR_ITEMS = ['Feed de la comunidad', 'Mi panel', 'Cursos', 'Calendario'] as const;

/** Cabecera de la página de inicio (`/comunidad` → `CommunityFeed`). */
const HOME_TITLE = (c: CatalogName) => msg(c, 'comunidadComponentes', 'feedTitle');
const HOME_SUBTITLE = (c: CatalogName) => msg(c, 'comunidadComponentes', 'feedSubtitle');
const HOME_NEW_POST = (c: CatalogName) => msg(c, 'comunidadComponentes', 'newConversation');

/** Chrome del propio shell (no son tokens de nav, son textos). */
const SIDEBAR_LOGOUT = (c: CatalogName) => msg(c, 'shell', 'sidebar', 'logout');
const SIDEBAR_SEARCH = (c: CatalogName) => msg(c, 'shell', 'sidebar', 'search');

// ─────────────────────────────────────────────────────────────────────────────
// Red de seguridad + aserciones de pantalla
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Endpoint real de cambio de idioma: el MISMO que usa el formulario de
 * `/cuenta` (`meApi.updateProfile`, apps/web/src/app/(app)/cuenta/page.tsx:198).
 * Acepta `es-ES | es-AR | en-US | pt-BR` (`ALLOWED_LOCALES`,
 * apps/api/src/auth/me.controller.ts:38) — o sea que es MÁS permisivo que el
 * catálogo, que sólo tiene `es` y `en`.
 */
async function setProfileLocale(accessToken: string, locale: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/v1/me/profile`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ locale }),
  });
  expect(res.ok, `PATCH /me/profile locale=${locale} devolvió ${res.status}`).toBe(true);
  const updated = (await res.json()) as { locale: string };
  expect(updated.locale).toBe(locale);
}

async function profileLocale(accessToken: string): Promise<string> {
  const res = await fetch(`${API_URL}/api/v1/me/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(res.ok, `GET /me/profile devolvió ${res.status}`).toBe(true);
  return ((await res.json()) as { locale: string }).locale;
}

/**
 * RED DE SEGURIDAD. Comprueba que el idioma EFECTIVO es el que el test cree,
 * por las dos puntas de la cadena, antes de mirar un solo texto:
 *
 *   1. el perfil, que es quien manda con sesión activa (LocaleSync lo copia a
 *      la cookie, no al revés);
 *   2. `<html lang>`, que es lo que `getLocale()` resolvió en el servidor y por
 *      tanto qué catálogo se sirvió de verdad.
 *
 * La aserción sobre `lang` reintenta, así que además sirve de espera: cubre el
 * ciclo `GET /me` → `writeLocaleCookie` → `router.refresh()` de LocaleSync sin
 * usar `networkidle` (inservible aquí: con sesión hay dos canales SSE abiertos
 * y la red no queda ociosa nunca).
 */
async function assertLocale(page: Page, accessToken: string, expected: string): Promise<void> {
  expect(
    await profileLocale(accessToken),
    `el perfil no quedó en ${expected}: el idioma NO se aplicó (y ninguna aserción de texto de aquí en adelante significaría nada)`,
  ).toBe(expected);
  await expect(
    page.locator('html'),
    `<html lang> no llegó a ${expected}: el idioma NO se aplicó — LocaleSync no sincronizó la cookie con el perfil, o los RSC no se re-renderizaron`,
  ).toHaveAttribute('lang', expected, { timeout: 20_000 });
}

/** Sidebar de escritorio (el drawer móvil es el segundo `aside`). */
function sidebarOf(page: Page): Locator {
  return page.locator('aside').first();
}

/** Afirma que sidebar y página de inicio están en el catálogo `catalog`. */
async function assertShellInCatalog(page: Page, catalog: CatalogName): Promise<void> {
  const other: CatalogName = catalog === 'es' ? 'en' : 'es';
  const sidebar = sidebarOf(page);
  const nav = sidebar.locator('nav').first();

  // — Sidebar: grupos y items. Son tokens canónicos en español traducidos por
  //   `labelOr(tNav, ...)` en app-sidebar.tsx:156-157.
  for (const token of SIDEBAR_GROUPS) {
    const { es, en } = pair((c) => navGroup(c, token));
    const wanted = catalog === 'es' ? es : en;
    const unwanted = catalog === 'es' ? en : es;
    await expect(
      nav.getByText(wanted, { exact: true }),
      `grupo de nav "${token}" en ${catalog}`,
    ).toBeVisible();
    await expect(
      nav.getByText(unwanted, { exact: true }),
      `grupo de nav "${token}" sigue en ${other}`,
    ).toHaveCount(0);
  }

  for (const token of SIDEBAR_ITEMS) {
    const { es, en } = pair((c) => navItem(c, token));
    const wanted = catalog === 'es' ? es : en;
    const unwanted = catalog === 'es' ? en : es;
    await expect(
      nav.getByRole('link', { name: wanted, exact: true }),
      `item de nav "${token}" en ${catalog}`,
    ).toBeVisible();
    await expect(
      nav.getByRole('link', { name: unwanted, exact: true }),
      `item de nav "${token}" sigue en ${other}`,
    ).toHaveCount(0);
  }

  // — Sidebar: chrome propio del shell (aria-labels y placeholders), que sale
  //   del namespace `shell` y no del diccionario de tokens.
  const logout = pair(SIDEBAR_LOGOUT);
  await expect(
    sidebar.getByRole('button', { name: catalog === 'es' ? logout.es : logout.en }),
    `botón de salir en ${catalog}`,
  ).toBeVisible();
  const search = pair(SIDEBAR_SEARCH);
  await expect(
    sidebar.getByText(catalog === 'es' ? search.es : search.en, { exact: true }),
    `buscador del sidebar en ${catalog}`,
  ).toBeVisible();

  // — Página de inicio: `/comunidad` es donde aterriza la sesión (`/inicio`
  //   redirige ahí). El h1 se scopea por rol para no chocar con el subtítulo
  //   "Comunidad"/"Community" de la cabecera del sidebar.
  const title = pair(HOME_TITLE);
  await expect(
    page.getByRole('heading', { level: 1, name: catalog === 'es' ? title.es : title.en }),
    `título de la página de inicio en ${catalog}`,
  ).toBeVisible();
  const subtitle = pair(HOME_SUBTITLE);
  await expect(
    page.getByText(catalog === 'es' ? subtitle.es : subtitle.en, { exact: true }),
    `subtítulo de la página de inicio en ${catalog}`,
  ).toBeVisible();
  const newPost = pair(HOME_NEW_POST);
  await expect(
    page.getByRole('button', { name: catalog === 'es' ? newPost.es : newPost.en }),
    `botón de nueva conversación en ${catalog}`,
  ).toBeVisible();
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3010';

/** Alumno recién creado, con onboarding cerrado. Nace en `es-ES` (schema.prisma:190). */
async function newStudent(label: string) {
  return signupOnboarded({
    tenantSlug: TENANT_SLUG,
    email: `e2e-i18n-${label}-${Date.now()}@example.test`,
    password: E2E_USER_PASSWORD,
    name: 'Alumna i18n',
  });
}

async function openHome(
  page: Page,
  session: Awaited<ReturnType<typeof newStudent>>,
): Promise<void> {
  // Patrón de la casa (redesign-smoke, navegacion-simplificada): un `goto`
  // inicial para tener origin, se inyecta la sesión en web storage y se navega
  // al destino real.
  await page.goto('/signin');
  await injectSession(page, {
    accessToken: session.tokens.accessToken,
    refreshToken: session.tokens.refreshToken,
    user: session.user,
  });
  await page.goto('/comunidad');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Cambio de idioma (i18n es-ES ↔ en-US)', () => {
  test('el idioma del perfil cambia sidebar y página de inicio a inglés, y vuelve', async ({
    page,
  }) => {
    const session = await newStudent('switch');
    const token = session.tokens.accessToken;

    // 1. Estado de partida: español.
    await openHome(page, session);
    await assertLocale(page, token, 'es-ES');
    await assertShellInCatalog(page, 'es');

    // 2. Cambio de idioma por el mismo endpoint que el formulario de /cuenta.
    await setProfileLocale(token, 'en-US');

    // 3. Recarga. Ojo: el HTML del servidor todavía sale en español, porque la
    //    cookie sigue en es-ES. Es LocaleSync quien la alinea con el perfil y
    //    refresca los RSC — y por eso `assertLocale` espera por `<html lang>`.
    await page.reload();
    await assertLocale(page, token, 'en-US');

    // 4. La interfaz está en inglés DE VERDAD, contra el catálogo real.
    await assertShellInCatalog(page, 'en');

    // 5. Vuelta a español: el entorno queda como estaba.
    await setProfileLocale(token, 'es-ES');
    await page.reload();
    await assertLocale(page, token, 'es-ES');
    await assertShellInCatalog(page, 'es');
  });

  test('sin sesión manda la cookie: /signin se sirve en inglés', async ({ page, context }) => {
    // Media cadena, aislada. Si este test pasa y el anterior falla, el problema
    // está en el puente perfil→cookie (LocaleSync), no en next-intl ni en el
    // catálogo. Sin token, LocaleSync no toca nada (locale-sync.tsx:52).
    const title = pair((c) => msg(c, 'auth', 'signin', 'title'));
    const description = pair((c) => msg(c, 'auth', 'signin', 'description'));

    await context.addCookies([{ name: 'didacta_locale', value: 'en-US', url: BASE_URL }]);
    await page.goto('/signin');

    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    await expect(page.getByRole('heading', { name: title.en })).toBeVisible();
    await expect(page.getByText(description.en, { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: title.es })).toHaveCount(0);
  });

  test('con sesión, el perfil PISA la cookie (el gotcha que costó un barrido)', async ({
    page,
    context,
  }) => {
    // Precedencia documentada en locale-sync.tsx:8-24. Se afirma explícitamente
    // porque es la trampa que invalidó un barrido entero de 24 pantallas: aquel
    // spec ponía la cookie en `en-US`, el producto la revertía a `es-ES` desde
    // el perfil, y el resultado se reportó como «el sidebar no está traducido».
    const session = await newStudent('cookie');
    const token = session.tokens.accessToken;
    expect(await profileLocale(token), 'el alumno nace en es-ES').toBe('es-ES');

    await context.addCookies([{ name: 'didacta_locale', value: 'en-US', url: BASE_URL }]);
    await openHome(page, session);

    // El perfil sigue en es-ES → el producto tiene que ACABAR en es-ES.
    await assertLocale(page, token, 'es-ES');
    await expect
      .poll(
        () => page.evaluate(() => document.cookie.match(/didacta_locale=([^;]*)/)?.[1] ?? null),
        { message: 'LocaleSync reescribe la cookie con el locale del perfil' },
      )
      .toBe('es-ES');
    await assertShellInCatalog(page, 'es');
  });
});
