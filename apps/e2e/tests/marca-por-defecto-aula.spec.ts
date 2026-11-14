/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import { injectSession } from '../helpers/auth';
import { fotoPngBase64 } from '../helpers/png';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';

/**
 * Valentín (14-nov-2026): «El logo en la cabecera: si el creador no pone uno,
 * pon las iniciales, no el logo de Didacta. Didacta solo lo ponemos en el pie
 * como "Powered by Didacta — Create your own academy free" y listo.»
 *
 *  1. Aula SIN logo: sus iniciales («CG») sobre su color, con contraste AA, en
 *     la cabecera del aula (escritorio y móvil), la tarjeta de la comunidad, la
 *     portada pública, el catálogo, la ficha de venta, el acceso y el 404; el
 *     favicon y la imagen para redes, generados con ellas. En ninguna pantalla
 *     un fichero de `/brand/` (el logo de Didacta).
 *  2. El pie «Powered by Didacta — …» en es/en/pt, al alta de didacta.io en ese
 *     idioma con la campaña del aula, `rel="noopener"`.
 *  3. Aula CON logo (control): su logo en esos mismos sitios y ni rastro de las
 *     iniciales; el favicon es su logo y la imagen para redes, su portada.
 */

const NOMBRE = 'Café Primeiro Gole';
const INICIALES = 'CG';

interface Auth {
  tokens: { accessToken: string; refreshToken: string };
  user: {
    id: string;
    email: string;
    name: string | null;
    tenantId: string;
    tenantSlug: string;
    roles: string[];
    mfaEnabled: boolean;
  };
}

interface Aula extends FreshTenant {
  tenantId: string;
  operador: Auth;
}

const LOCALES = {
  es: { cookie: 'es-ES', site: 'es', pie: 'Powered by Didacta — Crea tu academia gratis' },
  en: { cookie: 'en-US', site: 'en', pie: 'Powered by Didacta — Create your own academy free' },
  pt: { cookie: 'pt-BR', site: 'pt-br', pie: 'Powered by Didacta — Crie sua escola grátis' },
} as const;

async function aulaNueva(prefix: string): Promise<Aula> {
  const ft = await freshTenant(`${prefix}${Date.now().toString(36)}`, true);
  const operador = await apiAs<Auth>(ft.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: ft.slug, email: `operador@${ft.slug}.test`, password: ft.password },
  });
  const T = operador.tokens.accessToken;
  // Su nombre y su color, como los deja la creadora en el alta y en Marca.
  await apiAs(ft.host, '/api/v1/admin/tenant-settings/academy', {
    method: 'PUT',
    bearer: T,
    body: { name: NOMBRE },
  });
  await apiAs(ft.host, '/api/v1/modules/theming/me', {
    method: 'PUT',
    bearer: T,
    body: { brandHue: 24, brandSaturation: 90 },
  });
  const tenantId = sql(`SELECT id FROM tenant WHERE slug='${ft.slug}'`);
  cursoALaVenta(tenantId, 'latte-art', 'Latte art', 4900);
  return { ...ft, tenantId, operador };
}

/** Curso publicado con una opción de compra (para el catálogo y la ficha). */
function cursoALaVenta(tenantId: string, slug: string, title: string, cents: number): void {
  const id = randomUUID();
  sql(
    `INSERT INTO mod_courses_course (id, tenant_id, slug, title, description, status, published_at, created_at, updated_at)
     VALUES ('${id}', '${tenantId}', '${slug}', '${title}', '<p>Desde cero</p>', 'PUBLISHED', now(), now(), now())`,
  );
  const p = randomUUID();
  sql(
    `INSERT INTO mod_billing_product (id, tenant_id, course_id, stripe_product_id, stripe_price_id, unit_amount, currency, updated_at)
     VALUES ('${p}', '${tenantId}', '${id}', 'prod_e2e_${p.slice(0, 8)}', 'price_e2e_${p.slice(0, 8)}', ${cents}, 'eur', now())`,
  );
}

async function visitante(
  browser: Browser,
  a: Aula,
  lang: keyof typeof LOCALES,
  width = 1440,
): Promise<Page> {
  const ctx = await browser.newContext({
    locale: LOCALES[lang].cookie,
    viewport: { width, height: width < 600 ? 844 : 900 },
  });
  await ctx.addCookies([{ name: 'didacta_locale', value: LOCALES[lang].cookie, url: a.base }]);
  return ctx.newPage();
}

async function conSesion(browser: Browser, a: Aula, width: number): Promise<Page> {
  const page = await visitante(browser, a, 'es', width);
  await page.goto(`${a.base}/signin`);
  await injectSession(page, {
    accessToken: a.operador.tokens.accessToken,
    refreshToken: a.operador.tokens.refreshToken,
    user: { ...a.operador.user, onboardingCompletedAt: new Date().toISOString() },
  });
  await page.goto(`${a.base}/community`);
  return page;
}

function rgb(css: string): [number, number, number] {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
  if (!m) throw new Error(`color raro: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function luminancia([r, g, b]: [number, number, number]): number {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

/** Contraste WCAG real de las letras sobre el fondo del monograma pintado. */
async function contraste(mark: Locator): Promise<number> {
  const { bg, fg } = await mark.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, fg: cs.color };
  });
  const [l1, l2] = [luminancia(rgb(bg)), luminancia(rgb(fg))];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Las iniciales del aula, legibles, dentro de `scope`. */
async function esperaIniciales(scope: Locator): Promise<void> {
  const mark = scope.getByTestId('academy-mark').first();
  await expect(mark).toBeVisible({ timeout: 20_000 });
  await expect(mark).toHaveAttribute('data-initials', INICIALES);
  await expect(mark).toHaveText(INICIALES);
  expect(await contraste(mark)).toBeGreaterThanOrEqual(4.5);
}

/** Ningún fichero de `/brand/` (el logo de Didacta) en la pantalla. */
async function sinLogoDeDidacta(page: Page): Promise<void> {
  const srcs = await page
    .locator('img')
    .evaluateAll((els) => els.map((e) => e.getAttribute('src') ?? ''));
  expect(srcs.filter((s) => s.includes('/brand/'))).toEqual([]);
}

async function esperaPie(page: Page, a: Aula, lang: keyof typeof LOCALES): Promise<void> {
  const pie = page.getByTestId('powered-by-didacta');
  await expect(pie).toHaveText(LOCALES[lang].pie);
  await expect(pie).toHaveAttribute(
    'href',
    `https://didacta.io/${LOCALES[lang].site}/start?utm_source=aula&utm_medium=powered_by&utm_campaign=${a.slug}`,
  );
  await expect(pie).toHaveAttribute('rel', 'noopener');
  await expect(pie).toHaveAttribute('target', '_blank');
}

/**
 * GET a la web del aula SIN seguir redirecciones. El cliente HTTP de Node no
 * resuelve `*.localhost` (Chromium sí): se pide a localhost con el host del
 * aula en `x-forwarded-host`, que es lo que leen el middleware y las rutas
 * (igual que detrás del proxy de producción).
 */
function getAula(request: APIRequestContext, a: Aula, path: string) {
  const base = new URL(a.base);
  return request.get(`http://localhost:${base.port}${path}`, {
    maxRedirects: 0,
    headers: { 'x-forwarded-host': base.host },
  });
}

/** Ancho y alto de un PNG (cabecera IHDR). */
function tamPng(buf: Buffer): { w: number; h: number } {
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

test.describe('Marca por defecto del aula: iniciales y «Powered by Didacta»', () => {
  test.setTimeout(240_000);

  test('aula SIN logo: sus iniciales en todas partes y el pie en es/en/pt', async ({
    browser,
    request,
  }) => {
    const a = await aulaNueva('marca');

    // ── Visitante en español ───────────────────────────────────────────────
    const page = await visitante(browser, a, 'es');

    // Portada pública: cabecera con las iniciales y pie.
    await page.goto(`${a.base}/`);
    await esperaIniciales(page.getByTestId('portada-marca'));
    await esperaPie(page, a, 'es');
    await sinLogoDeDidacta(page);
    // El favicon y la imagen para redes salen del aula (generados).
    await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute(
      'href',
      /\/academy-brand\/icon/,
    );
    const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content');
    expect(ogImage).toMatch(/\/academy-brand\/og$/);
    const og = await getAula(request, a, '/academy-brand/og');
    expect(og.status()).toBe(200);
    expect(og.headers()['content-type']).toBe('image/png');
    expect(tamPng(await og.body())).toEqual({ w: 1200, h: 630 });
    const icon = await getAula(request, a, '/academy-brand/icon');
    expect(icon.status()).toBe(200);
    expect(icon.headers()['content-type']).toBe('image/png');
    expect(tamPng(await icon.body())).toEqual({ w: 64, h: 64 });
    const apple = await getAula(request, a, '/academy-brand/icon?size=180');
    expect(tamPng(await apple.body())).toEqual({ w: 180, h: 180 });

    // Catálogo y ficha de venta.
    await page.goto(`${a.base}/catalog`);
    await esperaIniciales(page.locator('header').first());
    await esperaPie(page, a, 'es');
    await sinLogoDeDidacta(page);
    await page.goto(`${a.base}/catalog/latte-art`);
    await expect(page.getByRole('heading', { name: 'Latte art' })).toBeVisible();
    await esperaIniciales(page.locator('aside'));
    await esperaPie(page, a, 'es');
    await sinLogoDeDidacta(page);

    // Acceso: el panel de marca y el pie bajo el formulario.
    await page.goto(`${a.base}/signin`);
    await esperaIniciales(page.locator('aside'));
    await expect(page.locator('aside')).toContainText(NOMBRE);
    await esperaPie(page, a, 'es');
    await sinLogoDeDidacta(page);

    // 404 del aula: con su marca, no la genérica de Next.
    const r404 = await page.goto(`${a.base}/esto-no-existe-${Date.now()}`);
    expect(r404?.status()).toBe(404);
    await esperaIniciales(page.getByTestId('not-found-brand'));
    await expect(page.getByTestId('not-found-brand')).toContainText(NOMBRE);
    await esperaPie(page, a, 'es');
    await page.context().close();

    // ── El pie en inglés y en portugués ────────────────────────────────────
    for (const lang of ['en', 'pt'] as const) {
      const p = await visitante(browser, a, lang);
      await p.goto(`${a.base}/signin`);
      await esperaIniciales(p.locator('aside'));
      await esperaPie(p, a, lang);
      await p.goto(`${a.base}/`);
      await esperaPie(p, a, lang);
      await p.context().close();
    }

    // ── Dentro del aula (modo sencillo): escritorio y móvil ────────────────
    for (const width of [1440, 390]) {
      const p = await conSesion(browser, a, width);
      const cabecera = p.locator('header').first();
      await esperaIniciales(cabecera.getByRole('link', { name: NOMBRE }));
      await sinLogoDeDidacta(p);
      if (width === 1440) {
        // La tarjeta de la academia de la comunidad y su pie, unificado (quien
        // administra aterriza en «Empieza aquí»: se va a la comunidad).
        await p.goto(`${a.base}/community`);
        await expect(p).toHaveURL(/\/community$/);
        await esperaIniciales(p.getByTestId('community-academy-card'));
        await esperaPie(p, a, 'es');
      }
      await p.context().close();
    }
  });

  test('aula CON logo (control): su logo, sin iniciales; favicon = logo, redes = portada', async ({
    browser,
    request,
  }) => {
    const a = await aulaNueva('conlogo');
    const T = a.operador.tokens.accessToken;
    const logo = await apiAs<{ logoUrl: string }>(a.host, '/api/v1/modules/theming/me/logo', {
      method: 'POST',
      bearer: T,
      body: { data: fotoPngBase64(200), filename: 'logo.png', contentType: 'image/png' },
    });
    const cover = await apiAs<{ coverUrl: string }>(a.host, '/api/v1/modules/theming/me/cover', {
      method: 'POST',
      bearer: T,
      body: { data: fotoPngBase64(400), filename: 'portada.png', contentType: 'image/png' },
    });
    const logoPath = logo.logoUrl.split('?')[0]!;
    const coverPath = cover.coverUrl.split('?')[0]!;

    const page = await visitante(browser, a, 'es');
    await page.goto(`${a.base}/`);
    await expect(page.getByTestId('portada-marca').locator('img')).toHaveAttribute(
      'src',
      new RegExp(logoPath),
    );
    await expect(page.getByTestId('portada-marca').getByTestId('academy-mark')).toHaveCount(0);
    await esperaPie(page, a, 'es');

    await page.goto(`${a.base}/signin`);
    await expect(page.locator('aside img').first()).toHaveAttribute('src', new RegExp(logoPath));
    await expect(page.locator('aside').getByTestId('academy-mark')).toHaveCount(0);

    // Favicon: su logo; imagen para redes: su portada (redirecciones, sin generar).
    const icon = await getAula(request, a, '/academy-brand/icon');
    expect(icon.status()).toBe(302);
    expect(icon.headers()['location']).toContain(logoPath);
    const og = await getAula(request, a, '/academy-brand/og');
    expect(og.status()).toBe(302);
    expect(og.headers()['location']).toContain(coverPath);
    await page.context().close();

    const dentro = await conSesion(browser, a, 1440);
    const cabecera = dentro.locator('header').first();
    await expect(cabecera.locator('img').first()).toHaveAttribute('src', new RegExp(logoPath));
    await expect(cabecera.getByTestId('academy-mark')).toHaveCount(0);
    await dentro.context().close();
  });
});
