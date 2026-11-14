/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { academyUiLocale, type AcademyLocale } from '@/i18n/config';
import { minorToMajor, stripeDecimals } from './stripe-currencies';

/**
 * Qué enseña un aula a los BUSCADORES, en piezas puras (sin `next/headers`: las
 * usan el middleware, los route handlers de `robots.txt`/`sitemap.xml`, las
 * páginas y los tests).
 *
 * Decisión de Valentín: se indexan SOLO la portada pública de cada aula (`/`,
 * cuando su «Página pública de la academia» está encendida) y las fichas de
 * venta de los cursos (`/catalog/<slug>`, más el listado `/catalog` si hay algo
 * a la venta). Todo lo demás (acceso, `/join`, el pago, la comunidad, las
 * lecciones, la cuenta, `/admin`, `/studio`…) sigue `noindex`: por la
 * `<meta name="robots">` del layout raíz y, además, por la cabecera
 * `X-Robots-Tag` que pone el middleware (`robotsHeaderFor`).
 *
 * Los datos los da la API (`GET /api/v1/public/seo`, resuelto por el dominio);
 * aquí no se inventa nada: un dato que el aula no tiene no sale.
 */

// ── Lo que contesta la API ───────────────────────────────────────────────────

export interface PublicSeoCourse {
  slug: string;
  /** ISO. */
  lastmod: string;
}

export interface PublicSeoIndexable {
  indexable: true;
  /** Dominio canónico del aula; `null` = el de la petición. */
  canonicalHost: string | null;
  locale: AcademyLocale;
  academy: {
    name: string;
    description: string | null;
    logoUrl: string | null;
    coverUrl: string | null;
    sameAs: string[];
  };
  home: { lastmod: string };
  courses: PublicSeoCourse[];
}

export type PublicSeo = { indexable: false } | PublicSeoIndexable;

/** ¿La respuesta tiene la forma esperada? (Una API vieja o rota no cuela.) */
export function isPublicSeo(raw: unknown): raw is PublicSeo {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (r.indexable === false) return true;
  if (r.indexable !== true) return false;
  const academy = r.academy as Record<string, unknown> | undefined;
  return (
    (r.canonicalHost === null || typeof r.canonicalHost === 'string') &&
    typeof r.locale === 'string' &&
    !!academy &&
    typeof academy.name === 'string' &&
    Array.isArray(academy.sameAs) &&
    !!r.home &&
    typeof (r.home as Record<string, unknown>).lastmod === 'string' &&
    Array.isArray(r.courses)
  );
}

// ── Rutas ────────────────────────────────────────────────────────────────────

/** Ficha de venta: `/catalog/<slug>` (no la vuelta del pago, `/catalog/checkout/…`). */
const FICHA = /^\/catalog\/([^/]+)$/;

/**
 * ¿Puede indexarse esta ruta? Es la puerta GRUESA, por ruta: el middleware la
 * usa para poner `X-Robots-Tag: noindex` a todo lo demás. Que una de estas se
 * indexe de verdad lo decide después su página con los datos del aula
 * (portada encendida, curso a la venta).
 */
export function isIndexablePath(pathname: string): boolean {
  if (pathname === '/' || pathname === '/catalog') return true;
  const ficha = FICHA.exec(pathname);
  return !!ficha && ficha[1] !== 'checkout';
}

/** Ficheros para los buscadores: no llevan `noindex` (no son páginas). */
const CRAWLER_FILES = new Set(['/robots.txt', '/sitemap.xml']);

/** Valor de `X-Robots-Tag` para una ruta del aula, o `null` si no lleva. */
export function robotsHeaderFor(pathname: string): string | null {
  if (isIndexablePath(pathname) || CRAWLER_FILES.has(pathname)) return null;
  return 'noindex, nofollow';
}

// ── URL ──────────────────────────────────────────────────────────────────────

/**
 * Origen canónico del aula: su dominio primario (siempre https) y, si no tiene
 * uno publicable, el de la petición.
 */
export function canonicalOrigin(
  seo: PublicSeo | null,
  requestOrigin: string | null,
): string | null {
  if (seo?.indexable && seo.canonicalHost) return `https://${seo.canonicalHost}`;
  return requestOrigin;
}

/** URL canónica de una ruta: absoluta y SIN query (`?ref=`, `?preview=`…). */
export function canonicalUrl(origin: string, path: string): string {
  return new URL(path.split(/[?#]/)[0] || '/', `${origin}/`).toString();
}

export function fichaPath(slug: string): string {
  return `/catalog/${encodeURIComponent(slug)}`;
}

/** Una URL de imagen absoluta (las del aula suelen ser relativas a la API), o `null`. */
export function absoluteUrl(origin: string, url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (!url.startsWith('/') || url.startsWith('//')) return null;
  return `${origin}${url}`;
}

// ── Textos ───────────────────────────────────────────────────────────────────

/** Longitud con la que los buscadores enseñan la descripción. */
export const META_DESCRIPTION_MAX = 160;

/** Texto plano de un HTML del editor (sin etiquetas ni entidades comunes). */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|li|h[1-6]|blockquote)>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n);
      return code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** Recorta en una palabra, con «…» si hace falta. */
export function truncate(text: string, max = META_DESCRIPTION_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// ── Open Graph ───────────────────────────────────────────────────────────────

const OG_DEFAULT_REGION: Record<string, string> = { es: 'ES', en: 'US', pt: 'BR' };

/**
 * `og:locale` (`es_ES`, `en_US`, `pt_BR`, `es_AR`…) de un tag de idioma de la
 * interfaz o de un aula. Antes solo distinguía el inglés: un aula en portugués
 * se anunciaba como `es_ES`.
 */
export function ogLocale(locale: string | null | undefined): string {
  const [rawLang, rawRegion] = (locale ?? '').trim().replace('_', '-').split('-');
  const lang = (rawLang ?? '').toLowerCase();
  if (!OG_DEFAULT_REGION[lang]) return 'es_ES';
  const region = rawRegion && /^[a-z]{2}$/i.test(rawRegion) ? rawRegion.toUpperCase() : null;
  return `${lang}_${region ?? OG_DEFAULT_REGION[lang]}`;
}

// ── robots.txt ───────────────────────────────────────────────────────────────

/**
 * `robots.txt` de un aula que NO se indexa (portada apagada, o dominio sin aula
 * que indexar). Se deja rastrear y manda el `noindex` de cada página (meta y
 * `X-Robots-Tag`), que es lo que había antes en la práctica (no existía el
 * fichero): con `Disallow: /` Google ya no podría leer ese `noindex`, y X o
 * LinkedIn, que respetan `robots.txt`, dejarían de sacar la vista previa de los
 * enlaces del aula. Solo se cierra la API (JSON, no páginas), salvo las
 * imágenes públicas del aula, que son el `og:image` de esas vistas previas.
 */
export const ROBOTS_NOT_INDEXABLE = [
  'User-agent: *',
  'Allow: /api/v1/modules/theming/tenants/',
  'Allow: /api/v1/storage/file/tenants/',
  'Disallow: /api/',
  '',
].join('\n');

/**
 * `robots.txt` de un aula indexable: SOLO la portada (con o sin query: los
 * enlaces con `?ref=` llevan su canonical a la limpia y el buscador tiene que
 * poder leerlo), el catálogo y las fichas (no la vuelta del pago), los
 * recursos que hacen falta para pintarlas (CSS/JS de Next) y las imágenes
 * públicas del aula (logo, portada, imágenes de cursos). Todo lo demás, fuera.
 *
 * Con `Allow`/`Disallow` gana la regla más larga (RFC 9309), así que
 * `/catalog/checkout/` cierra la vuelta del pago aunque `/catalog/` esté
 * abierto. `$` ancla el final: `/$` es la portada y nada más.
 */
export function buildRobotsTxt(seo: PublicSeo, origin: string): string {
  if (!seo.indexable) return ROBOTS_NOT_INDEXABLE;
  return [
    'User-agent: *',
    'Allow: /$',
    'Allow: /?',
    'Allow: /catalog$',
    'Allow: /catalog?',
    'Allow: /catalog/',
    'Disallow: /catalog/checkout/',
    'Allow: /_next/static/',
    'Allow: /_next/image',
    'Allow: /api/v1/modules/theming/tenants/',
    'Allow: /api/v1/storage/file/tenants/',
    'Disallow: /',
    '',
    `Sitemap: ${canonicalUrl(origin, '/sitemap.xml')}`,
    '',
  ].join('\n');
}

// ── sitemap.xml ──────────────────────────────────────────────────────────────

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface SitemapEntry {
  loc: string;
  lastmod: string;
}

/** Las URL del sitemap del aula: portada, catálogo (si hay algo) y fichas. */
export function sitemapEntries(seo: PublicSeoIndexable, origin: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [{ loc: canonicalUrl(origin, '/'), lastmod: seo.home.lastmod }];
  if (seo.courses.length > 0) {
    const newest = seo.courses.reduce(
      (max, c) => (Date.parse(c.lastmod) > Date.parse(max) ? c.lastmod : max),
      seo.courses[0]!.lastmod,
    );
    entries.push({ loc: canonicalUrl(origin, '/catalog'), lastmod: newest });
  }
  for (const c of seo.courses) {
    entries.push({ loc: canonicalUrl(origin, fichaPath(c.slug)), lastmod: c.lastmod });
  }
  return entries;
}

export function buildSitemapXml(seo: PublicSeoIndexable, origin: string): string {
  const urls = sitemapEntries(seo, origin).map(
    (e) =>
      `  <url>\n    <loc>${xmlEscape(e.loc)}</loc>\n    <lastmod>${xmlEscape(e.lastmod)}</lastmod>\n  </url>`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

// ── Datos estructurados (JSON-LD) ────────────────────────────────────────────

/**
 * JSON dentro de `<script type="application/ld+json">`: el texto lo escriben
 * personas (nombre del aula, título del curso), así que `<`, `>` y `&` se
 * escapan. Si no, un título con `</script>` cerraría la etiqueta.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Tag BCP 47 del contenido del aula (`es-ES`, `en-US`, `pt-BR`). */
export function contentLanguage(locale: AcademyLocale): string {
  return academyUiLocale(locale);
}

const organizationId = (origin: string) => `${canonicalUrl(origin, '/')}#organization`;

/**
 * Portada: la academia (`EducationalOrganization`, el subtipo de
 * `Organization` que la describe) y el sitio (`WebSite`, del que Google saca
 * el nombre del sitio en los resultados). Solo lo que el aula tiene.
 */
export function academyJsonLd(seo: PublicSeoIndexable, origin: string): Record<string, unknown> {
  const url = canonicalUrl(origin, '/');
  const logo = absoluteUrl(origin, seo.academy.logoUrl);
  const image = absoluteUrl(origin, seo.academy.coverUrl);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'EducationalOrganization',
        '@id': organizationId(origin),
        name: seo.academy.name,
        url,
        ...(seo.academy.description ? { description: seo.academy.description } : {}),
        ...(logo ? { logo } : {}),
        ...(image ? { image } : {}),
        ...(seo.academy.sameAs.length > 0 ? { sameAs: seo.academy.sameAs } : {}),
      },
      {
        '@type': 'WebSite',
        '@id': `${url}#website`,
        name: seo.academy.name,
        url,
        inLanguage: contentLanguage(seo.locale),
        publisher: { '@id': organizationId(origin) },
      },
    ],
  };
}

/** Lo de un curso del catálogo público que entra en su JSON-LD. */
export interface CourseForJsonLd {
  slug: string;
  title: string;
  thumbnailUrl: string | null;
  estimatedMinutes: number | null;
  options: Array<{ name: string; unitAmount: number; currency: string }>;
}

/** Duración ISO 8601 (`PT1H30M`) de unos minutos. */
export function isoDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `PT${h > 0 ? `${h}H` : ''}${m > 0 || h === 0 ? `${m}M` : ''}`;
}

/** Importe de schema.org (unidades de la moneda, con punto) de uno de Stripe. */
export function offerPrice(minor: number, currency: string): number {
  return Number(minorToMajor(minor, currency).toFixed(stripeDecimals(currency)));
}

/**
 * Ficha de venta: un `Course` (schema.org) con quien lo imparte (`provider`,
 * la academia de la portada) y sus opciones de compra como `Offer` (precio y
 * moneda reales de mod.billing, a la venta). Cumple lo que Google pide para el
 * carrusel de cursos (`name` y `description` obligatorios, `provider`
 * recomendado) y lo de `Offer` (`price`, `priceCurrency`, `availability`).
 */
export function courseJsonLd(
  course: CourseForJsonLd,
  description: string,
  seo: PublicSeoIndexable,
  origin: string,
): Record<string, unknown> {
  const url = canonicalUrl(origin, fichaPath(course.slug));
  const image = absoluteUrl(origin, course.thumbnailUrl);
  const minutes =
    course.estimatedMinutes && course.estimatedMinutes > 0 ? course.estimatedMinutes : null;
  return {
    '@context': 'https://schema.org',
    '@type': 'Course',
    '@id': `${url}#course`,
    name: course.title,
    description,
    url,
    inLanguage: contentLanguage(seo.locale),
    ...(image ? { image } : {}),
    ...(minutes ? { timeRequired: isoDuration(minutes) } : {}),
    provider: {
      '@type': 'EducationalOrganization',
      '@id': organizationId(origin),
      name: seo.academy.name,
      url: canonicalUrl(origin, '/'),
    },
    offers: course.options.map((o) => ({
      '@type': 'Offer',
      ...(o.name ? { name: o.name } : {}),
      category: 'Paid',
      price: offerPrice(o.unitAmount, o.currency),
      priceCurrency: o.currency.toUpperCase(),
      availability: 'https://schema.org/InStock',
      url,
    })),
    // Didacta es un aula en línea: el curso se hace online, a su ritmo.
    hasCourseInstance: {
      '@type': 'CourseInstance',
      courseMode: 'Online',
      ...(minutes ? { courseWorkload: isoDuration(minutes) } : {}),
    },
  };
}

/**
 * Catálogo: la lista de fichas (`ItemList` con la URL canónica de cada una),
 * que es la página resumen del carrusel de cursos de Google.
 */
export function catalogJsonLd(
  slugs: string[],
  seo: PublicSeoIndexable,
  origin: string,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: seo.academy.name,
    itemListElement: slugs.map((slug, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: canonicalUrl(origin, fichaPath(slug)),
    })),
  };
}
