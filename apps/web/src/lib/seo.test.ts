/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import {
  academyJsonLd,
  absoluteUrl,
  buildRobotsTxt,
  buildSitemapXml,
  canonicalOrigin,
  canonicalUrl,
  catalogJsonLd,
  courseJsonLd,
  htmlToText,
  isIndexablePath,
  isoDuration,
  isPublicSeo,
  offerPrice,
  ogLocale,
  robotsHeaderFor,
  ROBOTS_NOT_INDEXABLE,
  serializeJsonLd,
  sitemapEntries,
  truncate,
  type PublicSeoIndexable,
} from './seo';

/**
 * Indexación del aula (decisión de Valentín): solo la portada pública y las
 * fichas de venta (y el catálogo). Lo demás, `noindex` y fuera del robots.
 */

const SEO: PublicSeoIndexable = {
  indexable: true,
  canonicalHost: 'morningpour.example.com',
  locale: 'en',
  academy: {
    name: 'Morning Pour',
    description: 'Specialty coffee at home',
    logoUrl: '/api/v1/modules/theming/tenants/a/logo?v=1',
    coverUrl: '/api/v1/modules/theming/tenants/a/cover?v=1',
    sameAs: ['https://instagram.com/morningpour'],
  },
  home: { lastmod: '2026-05-01T00:00:00.000Z' },
  courses: [
    { slug: 'latte-art', lastmod: '2026-05-01T00:00:00.000Z' },
    { slug: 'cold-brew', lastmod: '2026-03-01T00:00:00.000Z' },
  ],
};
const ORIGIN = 'https://morningpour.example.com';

/**
 * Lector de `robots.txt` como lo hace Google (RFC 9309): gana la regla que
 * más casa (la más larga); empatadas, `Allow`. `*` comodín y `$` final.
 */
function allowed(robots: string, url: string): boolean {
  const rules = robots
    .split('\n')
    .map((l) => /^(Allow|Disallow):\s*(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ allow: m[1] === 'Allow', path: m[2]! }));
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    const anchored = r.path.endsWith('$');
    const body = (anchored ? r.path.slice(0, -1) : r.path)
      .split('*')
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    if (!new RegExp(`^${body}${anchored ? '$' : ''}`).test(url)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
  }
  return best ? best.allow : true;
}

describe('qué rutas pueden indexarse', () => {
  it.each(['/', '/catalog', '/catalog/latte-art', '/catalog/caf%C3%A9'])('%s sí', (p) => {
    expect(isIndexablePath(p)).toBe(true);
    expect(robotsHeaderFor(p)).toBeNull();
  });

  it.each([
    '/signin',
    '/signup',
    '/join',
    '/member-registration',
    '/catalog/checkout',
    '/catalog/checkout/success',
    '/catalog/checkout/cancel',
    '/catalog/latte-art/extra',
    '/home',
    '/community',
    '/courses/latte-art',
    '/account',
    '/admin',
    '/admin/settings',
    '/studio',
    '/referral-terms',
    '/reset-password',
    '/u/123',
  ])('%s no: lleva X-Robots-Tag noindex', (p) => {
    expect(isIndexablePath(p)).toBe(false);
    expect(robotsHeaderFor(p)).toBe('noindex, nofollow');
  });

  it('los ficheros para buscadores no llevan noindex', () => {
    expect(robotsHeaderFor('/robots.txt')).toBeNull();
    expect(robotsHeaderFor('/sitemap.xml')).toBeNull();
  });
});

describe('canonical', () => {
  it('absoluto, con el dominio del aula y SIN la query (?ref=, ?preview=)', () => {
    expect(canonicalUrl(ORIGIN, '/?ref=amigo123')).toBe(`${ORIGIN}/`);
    expect(canonicalUrl(ORIGIN, '/catalog/latte-art?ref=x&utm=y')).toBe(
      `${ORIGIN}/catalog/latte-art`,
    );
    expect(canonicalUrl(ORIGIN, '/catalog#cursos')).toBe(`${ORIGIN}/catalog`);
  });

  it('el dominio canónico del aula gana al de la petición; sin él, el de la petición', () => {
    expect(canonicalOrigin(SEO, 'http://otro.localhost:3010')).toBe(ORIGIN);
    expect(canonicalOrigin({ ...SEO, canonicalHost: null }, 'http://aula.localhost:3010')).toBe(
      'http://aula.localhost:3010',
    );
    expect(canonicalOrigin({ indexable: false }, 'https://x.example.com')).toBe(
      'https://x.example.com',
    );
    expect(canonicalOrigin(null, null)).toBeNull();
  });

  it('imágenes relativas de la API → absolutas; esquemas raros, fuera', () => {
    expect(absoluteUrl(ORIGIN, '/api/v1/x.png')).toBe(`${ORIGIN}/api/v1/x.png`);
    expect(absoluteUrl(ORIGIN, 'https://cdn.example.com/x.png')).toBe(
      'https://cdn.example.com/x.png',
    );
    expect(absoluteUrl(ORIGIN, 'javascript:alert(1)')).toBeNull();
    expect(absoluteUrl(ORIGIN, '//evil.example.com/x.png')).toBeNull();
    expect(absoluteUrl(ORIGIN, null)).toBeNull();
  });
});

describe('og:locale', () => {
  it.each([
    ['es-ES', 'es_ES'],
    ['es-AR', 'es_AR'],
    ['en-US', 'en_US'],
    ['pt-BR', 'pt_BR'],
    ['es', 'es_ES'],
    ['en', 'en_US'],
    ['pt', 'pt_BR'],
    ['fr-FR', 'es_ES'],
    [null, 'es_ES'],
  ])('%s → %s', (input, expected) => {
    expect(ogLocale(input)).toBe(expected);
  });
});

describe('robots.txt', () => {
  it('portada apagada: se deja rastrear (manda el noindex de cada página), salvo la API; sin sitemap', () => {
    const txt = buildRobotsTxt({ indexable: false }, ORIGIN);
    expect(txt).toBe(ROBOTS_NOT_INDEXABLE);
    expect(txt).not.toContain('Sitemap:');
    // Rastreables: así Google LEE el noindex y X/LinkedIn sacan la vista previa.
    for (const url of [
      '/',
      '/?ref=x',
      '/catalog',
      '/catalog/latte-art',
      '/signin',
      '/join?ref=x',
      '/home',
      '/_next/static/chunks/app.js',
      // og:image del aula para las vistas previas.
      '/api/v1/modules/theming/tenants/a/cover?v=1',
      '/api/v1/storage/file/tenants/a/uploads/x.png',
    ]) {
      expect(allowed(txt, url), url).toBe(true);
    }
    // Control: la API (JSON) sigue cerrada.
    for (const url of ['/api/v1/auth/signin', '/api/v1/public/seo', '/api/docs']) {
      expect(allowed(txt, url), url).toBe(false);
    }
  });

  it('portada encendida: solo lo indexable, lo que hace falta para pintarlo y el sitemap del aula', () => {
    const txt = buildRobotsTxt(SEO, ORIGIN);
    expect(txt).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    for (const url of [
      '/',
      '/?ref=amigo123',
      '/catalog',
      '/catalog?ref=x',
      '/catalog/latte-art',
      '/catalog/latte-art?ref=x',
      '/_next/static/chunks/app.js',
      '/_next/image?url=x',
      '/api/v1/modules/theming/tenants/a/cover?v=1',
      '/api/v1/storage/file/tenants/a/uploads/x.png',
    ]) {
      expect(allowed(txt, url), url).toBe(true);
    }
    for (const url of [
      '/signin',
      '/signup',
      '/join',
      '/join?ref=x',
      '/member-registration',
      '/catalog/checkout/success?session_id=cs_1',
      '/catalog/checkout/cancel',
      '/home',
      '/community',
      '/courses/latte-art',
      '/admin',
      '/studio',
      '/account',
      '/api/v1/auth/signin',
      '/api/v1/public/seo',
      '/robots-falso',
    ]) {
      expect(allowed(txt, url), url).toBe(false);
    }
  });
});

describe('sitemap.xml', () => {
  it('portada, catálogo (lastmod = la ficha más reciente) y cada ficha, con el dominio del aula', () => {
    expect(sitemapEntries(SEO, ORIGIN)).toEqual([
      { loc: `${ORIGIN}/`, lastmod: '2026-05-01T00:00:00.000Z' },
      { loc: `${ORIGIN}/catalog`, lastmod: '2026-05-01T00:00:00.000Z' },
      { loc: `${ORIGIN}/catalog/latte-art`, lastmod: '2026-05-01T00:00:00.000Z' },
      { loc: `${ORIGIN}/catalog/cold-brew`, lastmod: '2026-03-01T00:00:00.000Z' },
    ]);
  });

  it('sin nada a la venta: solo la portada', () => {
    expect(sitemapEntries({ ...SEO, courses: [] }, ORIGIN)).toEqual([
      { loc: `${ORIGIN}/`, lastmod: SEO.home.lastmod },
    ]);
  });

  it('XML válido del protocolo y con los slugs codificados', () => {
    const xml = buildSitemapXml(
      { ...SEO, courses: [{ slug: 'café&té', lastmod: '2026-01-01T00:00:00.000Z' }] },
      ORIGIN,
    );
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain(`<loc>${ORIGIN}/catalog/caf%C3%A9%26t%C3%A9</loc>`);
    expect(xml).toContain('<lastmod>2026-01-01T00:00:00.000Z</lastmod>');
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });
});

describe('JSON-LD', () => {
  it('se escapa para no poder cerrar el <script>', () => {
    const out = serializeJsonLd({ name: '</script><script>alert(1)</script> & co' });
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(JSON.parse(out)).toEqual({ name: '</script><script>alert(1)</script> & co' });
  });

  it('portada: EducationalOrganization + WebSite, con lo que tiene el aula y nada más', () => {
    const ld = academyJsonLd(SEO, ORIGIN) as {
      '@context': string;
      '@graph': Array<Record<string, unknown>>;
    };
    expect(ld['@context']).toBe('https://schema.org');
    const [org, site] = ld['@graph'];
    expect(org).toEqual({
      '@type': 'EducationalOrganization',
      '@id': `${ORIGIN}/#organization`,
      name: 'Morning Pour',
      url: `${ORIGIN}/`,
      description: 'Specialty coffee at home',
      logo: `${ORIGIN}/api/v1/modules/theming/tenants/a/logo?v=1`,
      image: `${ORIGIN}/api/v1/modules/theming/tenants/a/cover?v=1`,
      sameAs: ['https://instagram.com/morningpour'],
    });
    expect(site).toEqual({
      '@type': 'WebSite',
      '@id': `${ORIGIN}/#website`,
      name: 'Morning Pour',
      url: `${ORIGIN}/`,
      inLanguage: 'en-US',
      publisher: { '@id': `${ORIGIN}/#organization` },
    });
    // Sin descripción, logo ni enlaces: esas claves no salen (no se inventan).
    const bare = academyJsonLd(
      {
        ...SEO,
        academy: { name: 'X', description: null, logoUrl: null, coverUrl: null, sameAs: [] },
      },
      ORIGIN,
    ) as { '@graph': Array<Record<string, unknown>> };
    expect(Object.keys(bare['@graph'][0]!).sort()).toEqual(['@id', '@type', 'name', 'url']);
  });

  it('ficha: Course con provider y offers reales (precio en unidades, moneda ISO, a la venta)', () => {
    const ld = courseJsonLd(
      {
        slug: 'latte-art',
        title: 'Latte art',
        thumbnailUrl: '/api/v1/storage/file/tenants/a/uploads/latte.png',
        estimatedMinutes: 90,
        options: [
          { name: '', unitAmount: 4990, currency: 'eur' },
          { name: 'Con mentoría', unitAmount: 500, currency: 'jpy' },
        ],
      },
      'Pour like a barista.',
      SEO,
      ORIGIN,
    );
    expect(ld).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Course',
      '@id': `${ORIGIN}/catalog/latte-art#course`,
      name: 'Latte art',
      description: 'Pour like a barista.',
      url: `${ORIGIN}/catalog/latte-art`,
      inLanguage: 'en-US',
      image: `${ORIGIN}/api/v1/storage/file/tenants/a/uploads/latte.png`,
      timeRequired: 'PT1H30M',
      provider: {
        '@type': 'EducationalOrganization',
        '@id': `${ORIGIN}/#organization`,
        name: 'Morning Pour',
        url: `${ORIGIN}/`,
      },
      offers: [
        {
          '@type': 'Offer',
          category: 'Paid',
          price: 49.9,
          priceCurrency: 'EUR',
          availability: 'https://schema.org/InStock',
          url: `${ORIGIN}/catalog/latte-art`,
        },
        {
          '@type': 'Offer',
          name: 'Con mentoría',
          category: 'Paid',
          price: 500,
          priceCurrency: 'JPY',
          availability: 'https://schema.org/InStock',
          url: `${ORIGIN}/catalog/latte-art`,
        },
      ],
      hasCourseInstance: {
        '@type': 'CourseInstance',
        courseMode: 'Online',
        courseWorkload: 'PT1H30M',
      },
    });
  });

  it('ficha sin duración ni imagen: sin esas claves (no se inventan)', () => {
    const ld = courseJsonLd(
      { slug: 's', title: 'S', thumbnailUrl: null, estimatedMinutes: null, options: [] },
      'd',
      SEO,
      ORIGIN,
    );
    expect(ld).not.toHaveProperty('image');
    expect(ld).not.toHaveProperty('timeRequired');
    expect(ld.hasCourseInstance).toEqual({ '@type': 'CourseInstance', courseMode: 'Online' });
  });

  it('catálogo: ItemList con la URL canónica de cada ficha', () => {
    expect(catalogJsonLd(['latte-art', 'cold-brew'], SEO, ORIGIN)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'Morning Pour',
      itemListElement: [
        { '@type': 'ListItem', position: 1, url: `${ORIGIN}/catalog/latte-art` },
        { '@type': 'ListItem', position: 2, url: `${ORIGIN}/catalog/cold-brew` },
      ],
    });
  });

  it('duraciones e importes', () => {
    expect(isoDuration(45)).toBe('PT45M');
    expect(isoDuration(120)).toBe('PT2H');
    expect(isoDuration(0)).toBe('PT0M');
    expect(offerPrice(4900, 'eur')).toBe(49);
    expect(offerPrice(1999, 'usd')).toBe(19.99);
    // COP: Stripe lo cobra con dos decimales aunque el CLDR diga cero.
    expect(offerPrice(39900000, 'cop')).toBe(399000);
    expect(offerPrice(500, 'jpy')).toBe(500);
  });
});

describe('textos', () => {
  it('texto plano de la descripción del editor', () => {
    expect(htmlToText('<p>Aprende <b>desde cero</b></p><p>Café &amp; leche&nbsp;&#233;</p>')).toBe(
      'Aprende desde cero Café & leche é',
    );
    expect(htmlToText('<script>alert(1)</script>Hola')).toBe('Hola');
    expect(htmlToText(null)).toBe('');
  });

  it('recorta en una palabra', () => {
    const long = 'palabra '.repeat(40);
    const out = truncate(long, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith('…')).toBe(true);
    expect(truncate('corto')).toBe('corto');
  });
});

describe('respuesta de la API', () => {
  it('solo acepta las dos formas esperadas', () => {
    expect(isPublicSeo({ indexable: false })).toBe(true);
    expect(isPublicSeo(SEO)).toBe(true);
    expect(isPublicSeo({ indexable: true })).toBe(false);
    expect(isPublicSeo({ message: 'boom' })).toBe(false);
    expect(isPublicSeo(null)).toBe(false);
  });
});
