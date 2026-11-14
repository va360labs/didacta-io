/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { expect, test } from '@playwright/test';
import { apiAs, freshTenant, sql, type FreshTenant } from '../helpers/simple-tenant';

/**
 * Valentín: «Sí se indexa en Google» la portada pública de cada academia y las
 * fichas de venta de sus cursos. El resto del aula sigue `noindex`.
 *
 * Todo se comprueba como lo ve un buscador: el HTML tal cual sale del servidor,
 * SIN ejecutar JavaScript (petición HTTP directa, y un navegador con JS
 * apagado), y los ficheros que lee un rastreador (`robots.txt`, `sitemap.xml`),
 * cada uno en su aula y sin mezclar.
 *
 *  1. Portada: su texto en el HTML, `index`, canonical limpio (también con
 *     `?ref=`), `lang`/`og:locale` y JSON-LD de la academia.
 *  2. Ficha: título, descripción y precio en el HTML, `index`, canonical y
 *     JSON-LD `Course` con su oferta real; un curso que no se vende, 404.
 *  3. Catálogo: los cursos en el HTML, `index` e `ItemList`.
 *  4. Lo privado: `noindex` en la meta y en la cabecera `X-Robots-Tag`.
 *  5. `robots.txt` y `sitemap.xml` por aula; con la portada apagada, nada.
 *  6. Idioma del aula en inglés y portugués.
 */

const WEB_PORT = Number(new URL(process.env.E2E_BASE_URL ?? 'http://localhost:3010').port || 3010);

interface Aula extends FreshTenant {
  tenantId: string;
  operator: string;
}

async function aula(prefix: string, simple: boolean): Promise<Aula> {
  const slug = `${prefix}-${Date.now().toString(36)}`;
  const ft = await freshTenant(slug, simple);
  const op = await apiAs<{ tokens: { accessToken: string } }>(ft.host, '/api/v1/auth/signin', {
    method: 'POST',
    body: { tenantSlug: slug, email: `operador@${slug}.test`, password: ft.password },
  });
  const tenantId = sql(`SELECT id FROM tenant WHERE slug='${slug}'`);
  return { ...ft, tenantId, operator: op.tokens.accessToken };
}

/** Curso publicado con una opción de compra (lo que el creador deja a la venta). */
function cursoALaVenta(a: Aula, slug: string, title: string, cents: number): void {
  const id = randomUUID();
  sql(
    `INSERT INTO mod_courses_course (id, tenant_id, slug, title, description, estimated_minutes, status, published_at, created_at, updated_at)
     VALUES ('${id}', '${a.tenantId}', '${slug}', '${title}', '<p>Aprende <b>desde cero</b> a servir un buen café.</p>', 90, 'PUBLISHED', now(), now(), now())`,
  );
  const p = randomUUID();
  sql(
    `INSERT INTO mod_billing_product (id, tenant_id, course_id, stripe_product_id, stripe_price_id, unit_amount, currency, updated_at)
     VALUES ('${p}', '${a.tenantId}', '${id}', 'prod_e2e_${p.slice(0, 8)}', 'price_e2e_${p.slice(0, 8)}', ${cents}, 'eur', now())`,
  );
}

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * GET al web como un rastreador: HTTP pelado, sin navegador ni JavaScript,
 * con el Host del aula (así se resuelve el aula, como en producción).
 */
function crawl(host: string, path: string): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: WEB_PORT,
        path,
        method: 'GET',
        headers: { Host: `${host}:${WEB_PORT}`, 'user-agent': 'Googlebot/2.1 (e2e)' },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** El texto que se VE en el HTML: sin scripts (ni el payload de React) ni etiquetas. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function metaContent(html: string, attr: 'name' | 'property', key: string): string | null {
  const re = new RegExp(`<meta ${attr}="${key.replace(/[.:]/g, '\\$&')}" content="([^"]*)"`);
  return re.exec(html)?.[1] ?? null;
}

function canonical(html: string): string | null {
  return /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1] ?? null;
}

function htmlLang(html: string): string | null {
  return /<html lang="([^"]+)"/.exec(html)?.[1] ?? null;
}

function jsonLd(html: string): Array<Record<string, unknown>> {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (m) => JSON.parse(m[1]!) as Record<string, unknown>,
  );
}

test.describe('Indexación: la portada y las fichas de venta, sí; el resto, no', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let a: Aula;
  let b: Aula;
  let apagada: Aula;
  const origin = (x: Aula) => `http://${x.host}:${WEB_PORT}`;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    a = await aula('idx-a', true);
    cursoALaVenta(a, 'latte-art', 'Latte art', 4900);
    await apiAs(a.host, '/api/v1/modules/theming/me', {
      method: 'PUT',
      bearer: a.operator,
      body: {
        about: 'Café de especialidad en casa.',
        socialLinks: [
          { kind: 'instagram', url: 'https://instagram.com/idxcafe' },
          { kind: 'whatsapp', url: 'https://wa.me/34600000000' },
        ],
      },
    });
    b = await aula('idx-b', true);
    cursoALaVenta(b, 'cata-de-cafe', 'Cata de café', 2900);
    // Modo completo sin tocar el ajuste: portada apagada → nada se indexa.
    apagada = await aula('idx-off', false);
    cursoALaVenta(apagada, 'curso-cerrado', 'Curso cerrado', 9900);
  });

  test('portada sin JS: su texto en el HTML, index, canonical limpio, idioma y JSON-LD', async ({
    browser,
  }) => {
    const r = await crawl(a.host, '/');
    expect(r.status).toBe(200);
    const text = visibleText(r.body);
    expect(text).toContain(a.slug);
    expect(text).toContain('Café de especialidad en casa.');
    expect(text).toContain('Latte art');
    expect(metaContent(r.body, 'name', 'robots')).toBe('index, follow, max-image-preview:large');
    expect(r.headers['x-robots-tag']).toBeUndefined();
    // La raíz: Next la escribe sin la barra final (`https://x` y `https://x/`
    // son la misma URL; el sitemap y el JSON-LD llevan la barra).
    expect(canonical(r.body)).toBe(origin(a));
    expect(htmlLang(r.body)).toBe('es-ES');
    expect(metaContent(r.body, 'property', 'og:locale')).toBe('es_ES');
    expect(metaContent(r.body, 'property', 'og:url')).toBe(origin(a));
    expect(metaContent(r.body, 'name', 'description')).toBe('Café de especialidad en casa.');

    const [ld] = jsonLd(r.body);
    const [org, site] = (ld as { '@graph': Array<Record<string, unknown>> })['@graph'];
    expect(org).toMatchObject({
      '@type': 'EducationalOrganization',
      name: a.slug,
      url: `${origin(a)}/`,
      description: 'Café de especialidad en casa.',
      // WhatsApp no identifica al aula: solo el perfil.
      sameAs: ['https://instagram.com/idxcafe'],
    });
    expect(site).toMatchObject({ '@type': 'WebSite', name: a.slug, inLanguage: 'es-ES' });

    // Con ?ref= es la misma página: canonical a la limpia y sigue indexable.
    const conRef = await crawl(a.host, '/?ref=amigo123');
    expect(canonical(conRef.body)).toBe(origin(a));
    expect(metaContent(conRef.body, 'name', 'robots')).toContain('index, follow');

    // Navegador con JavaScript APAGADO: la portada se ve entera.
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto(`${origin(a)}/`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(a.slug);
    await expect(page.getByTestId('portada-curso')).toContainText('Latte art');
    await ctx.close();
  });

  test('ficha sin JS: título, descripción y precio en el HTML; Course con su oferta real', async ({
    browser,
  }) => {
    const r = await crawl(a.host, '/catalog/latte-art');
    expect(r.status).toBe(200);
    const text = visibleText(r.body);
    expect(text).toContain('Latte art');
    expect(text).toContain('Aprende desde cero a servir un buen café.');
    expect(text).toMatch(/49(,00)?\s?€/);
    // Ya no es el «Cargando…» que pintaba el servidor antes.
    expect(text).not.toContain('Cargando…');
    expect(metaContent(r.body, 'name', 'robots')).toBe('index, follow, max-image-preview:large');
    expect(canonical(r.body)).toBe(`${origin(a)}/catalog/latte-art`);
    expect(/<title>([^<]*)<\/title>/.exec(r.body)?.[1]).toBe(`Latte art | ${a.slug}`);
    expect(metaContent(r.body, 'name', 'description')).toBe(
      'Aprende desde cero a servir un buen café.',
    );

    const [course] = jsonLd(r.body);
    expect(course).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'Course',
      name: 'Latte art',
      description: 'Aprende desde cero a servir un buen café.',
      url: `${origin(a)}/catalog/latte-art`,
      inLanguage: 'es-ES',
      timeRequired: 'PT1H30M',
      provider: { '@type': 'EducationalOrganization', name: a.slug, url: `${origin(a)}/` },
      offers: [
        {
          '@type': 'Offer',
          category: 'Paid',
          price: 49,
          priceCurrency: 'EUR',
          availability: 'https://schema.org/InStock',
          url: `${origin(a)}/catalog/latte-art`,
        },
      ],
      hasCourseInstance: { '@type': 'CourseInstance', courseMode: 'Online' },
    });

    // Con ?ref=: canonical a la limpia.
    const conRef = await crawl(a.host, '/catalog/latte-art?ref=amigo123');
    expect(canonical(conRef.body)).toBe(`${origin(a)}/catalog/latte-art`);

    // Un curso que no está a la venta: 404 de verdad (antes, 200 con aviso)
    // y noindex; en el navegador, la tarjeta de siempre para volver al catálogo.
    const noExiste = await crawl(a.host, '/catalog/no-existe');
    expect(noExiste.status).toBe(404);
    expect(metaContent(noExiste.body, 'name', 'robots')).toMatch(/^noindex/);
    expect(jsonLd(noExiste.body)).toEqual([]);
    const conJs = await browser.newContext();
    const visita = await conJs.newPage();
    const res404 = await visita.goto(`${origin(a)}/catalog/no-existe`);
    expect(res404?.status()).toBe(404);
    await expect(visita.getByRole('heading', { name: 'Curso no disponible' })).toBeVisible();
    await expect(visita.getByRole('link', { name: 'Volver al catálogo' })).toHaveAttribute(
      'href',
      '/catalog',
    );
    await conJs.close();

    // Navegador con JavaScript APAGADO: la ficha se lee entera.
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto(`${origin(a)}/catalog/latte-art`);
    await expect(page.getByRole('heading', { name: 'Latte art' })).toBeVisible();
    await expect(page.getByTestId('precio-curso')).toHaveText(/49(,00)?\s?€/);
    await ctx.close();
  });

  test('catálogo sin JS: los cursos en el HTML, index e ItemList', async () => {
    const r = await crawl(a.host, '/catalog?ref=amigo123');
    expect(r.status).toBe(200);
    expect(visibleText(r.body)).toContain('Latte art');
    expect(visibleText(r.body)).toContain(a.slug);
    expect(metaContent(r.body, 'name', 'robots')).toBe('index, follow');
    expect(canonical(r.body)).toBe(`${origin(a)}/catalog`);
    expect(jsonLd(r.body)[0]).toEqual({
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: a.slug,
      itemListElement: [
        { '@type': 'ListItem', position: 1, url: `${origin(a)}/catalog/latte-art` },
      ],
    });
  });

  test('lo privado sigue noindex: cabecera X-Robots-Tag y meta robots', async () => {
    for (const path of [
      '/signin',
      '/join?ref=amigo123',
      '/member-registration',
      '/catalog/checkout/cancel',
      '/home',
      '/community',
      '/admin',
    ]) {
      const r = await crawl(a.host, path);
      expect(r.status, path).toBeLessThan(500);
      expect(r.headers['x-robots-tag'], path).toBe('noindex, nofollow');
      if (r.status === 200) {
        expect(metaContent(r.body, 'name', 'robots'), path).toBe('noindex, nofollow');
        // Control: lo privado no lleva datos estructurados de la venta.
        expect(jsonLd(r.body), path).toEqual([]);
      }
    }
  });

  test('robots.txt y sitemap.xml por aula, sin mezclar; con la portada apagada, nada', async () => {
    const robotsA = await crawl(a.host, '/robots.txt');
    expect(robotsA.status).toBe(200);
    expect(robotsA.headers['content-type']).toContain('text/plain');
    expect(robotsA.body).toContain('Allow: /$');
    expect(robotsA.body).toContain('Allow: /catalog/');
    expect(robotsA.body).toContain('Disallow: /catalog/checkout/');
    expect(robotsA.body).toMatch(/\nDisallow: \/\n/);
    expect(robotsA.body).toContain(`Sitemap: ${origin(a)}/sitemap.xml`);
    expect(robotsA.body).not.toContain(b.host);

    const mapA = await crawl(a.host, '/sitemap.xml');
    expect(mapA.status).toBe(200);
    expect(mapA.headers['content-type']).toContain('application/xml');
    expect(mapA.headers['cache-control']).toBe('public, max-age=300');
    expect(mapA.body).toContain(`<loc>${origin(a)}/</loc>`);
    expect(mapA.body).toContain(`<loc>${origin(a)}/catalog</loc>`);
    expect(mapA.body).toContain(`<loc>${origin(a)}/catalog/latte-art</loc>`);
    expect(mapA.body).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}T[\d:.]+Z<\/lastmod>/);
    expect(mapA.body).not.toContain('cata-de-cafe');
    expect(mapA.body).not.toContain(b.host);

    const mapB = await crawl(b.host, '/sitemap.xml');
    expect(mapB.body).toContain(`<loc>${origin(b)}/catalog/cata-de-cafe</loc>`);
    expect(mapB.body).not.toContain('latte-art');
    expect(mapB.body).not.toContain(a.host);

    // Portada apagada: robots cerrado, sin sitemap y la ficha (que se sigue
    // pudiendo comprar con el enlace) con noindex.
    const robotsOff = await crawl(apagada.host, '/robots.txt');
    expect(robotsOff.status).toBe(200);
    expect(robotsOff.body).toBe('User-agent: *\nDisallow: /\n');
    expect((await crawl(apagada.host, '/sitemap.xml')).status).toBe(404);
    const fichaOff = await crawl(apagada.host, '/catalog/curso-cerrado');
    expect(fichaOff.status).toBe(200);
    expect(visibleText(fichaOff.body)).toContain('Curso cerrado');
    expect(metaContent(fichaOff.body, 'name', 'robots')).toBe('noindex, nofollow');
    expect(jsonLd(fichaOff.body)).toEqual([]);
    const catalogOff = await crawl(apagada.host, '/catalog');
    expect(metaContent(catalogOff.body, 'name', 'robots')).toBe('noindex, nofollow');

    // Un dominio que no es de nadie: el 404 pelado del middleware de siempre.
    const nadie = await crawl(`nadie-${Date.now().toString(36)}.localhost`, '/robots.txt');
    expect(nadie.status).toBe(404);
  });

  test('idioma del aula: lang y og:locale en inglés y en portugués', async () => {
    for (const [locale, lang, og] of [
      ['en', 'en-US', 'en_US'],
      ['pt', 'pt-BR', 'pt_BR'],
    ] as const) {
      const x = await aula(`idx-${locale}`, true);
      await apiAs(x.host, '/api/v1/admin/tenant-settings/academy', {
        method: 'PUT',
        bearer: x.operator,
        body: { locale },
      });
      // La web cachea el idioma por host unos segundos: se espera a verlo.
      await expect
        .poll(async () => htmlLang((await crawl(x.host, '/')).body), { timeout: 60_000 })
        .toBe(lang);
      const r = await crawl(x.host, '/');
      expect(metaContent(r.body, 'property', 'og:locale')).toBe(og);
      await expect
        .poll(
          async () => {
            const ld = jsonLd((await crawl(x.host, '/')).body)[0] as
              | { '@graph': Array<Record<string, unknown>> }
              | undefined;
            return ld?.['@graph'][1]?.inLanguage;
          },
          { timeout: 90_000, intervals: [2_000, 5_000] },
        )
        .toBe(lang);
    }
  });
});
