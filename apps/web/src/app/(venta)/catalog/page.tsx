/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { cache, Suspense } from 'react';
import { publicHost } from '@/lib/academy-locale';
import { ACADEMY_OG_PATH } from '@/lib/academy-mark';
import {
  absoluteUrl,
  canonicalOrigin,
  canonicalUrl,
  catalogJsonLd,
  ogLocale,
  serializeJsonLd,
  truncate,
} from '@/lib/seo';
import { brandStyle } from '@/lib/academy-home';
import {
  fetchPublicBrand,
  fetchPublicCatalog,
  fetchPublicSeo,
  requestOrigin,
} from '@/lib/seo-server';
import { CatalogoView } from './catalogo-view';

/**
 * Catálogo PÚBLICO de cursos sueltos (viaje 2): visible sin cuenta ni sesión.
 * El tenant se resuelve por dominio en la API; los precios salen de
 * mod.billing y solo aparecen cursos publicados con opciones de compra
 * activas. La compra es checkout anónimo de Stripe (la cuenta se crea tras
 * el pago).
 *
 * Se pinta en el SERVIDOR con los cursos dentro (lo que lee un buscador) y se
 * indexa con la portada pública del aula encendida y algo a la venta (ver
 * `lib/seo.ts`). Si la API no contesta, lo pide el navegador, como antes.
 */

const load = cache(async () => {
  const h = await headers();
  const host = publicHost(h);
  const xff = h.get('x-forwarded-for');
  const [courses, seo] = await Promise.all([
    fetchPublicCatalog(host, xff),
    fetchPublicSeo(host, xff),
  ]);
  return { courses, seo, origin: canonicalOrigin(seo, requestOrigin(h, host)) };
});

/** Nombre, logo y color del aula, ya en el HTML (solo para la página). */
async function loadBrand() {
  const h = await headers();
  return fetchPublicBrand(publicHost(h), h.get('x-forwarded-for'));
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('publicSite');
  const { courses, seo, origin } = await load();
  if (!seo?.indexable || !origin) return { title: t('catalogo.metaTitle') };
  const title = `${t('catalogo.metaTitle')} | ${seo.academy.name}`;
  const description = truncate(t('catalogo.metaDescription', { name: seo.academy.name }));
  const canonical = canonicalUrl(origin, '/catalog');
  // Sin portada ni logo, la imagen con sus iniciales y su color.
  const image =
    absoluteUrl(origin, seo.academy.coverUrl ?? seo.academy.logoUrl) ??
    canonicalUrl(origin, ACADEMY_OG_PATH);
  const largeImage = Boolean(seo.academy.coverUrl) || !seo.academy.logoUrl;
  const indexable = seo.courses.length > 0 && (courses?.length ?? 0) > 0;
  return {
    title: { absolute: title },
    description,
    ...(indexable ? { robots: { index: true, follow: true } } : {}),
    metadataBase: new URL(origin),
    alternates: { canonical },
    openGraph: {
      type: 'website',
      siteName: seo.academy.name,
      title,
      description,
      locale: ogLocale(await getLocale()),
      url: canonical,
      images: [{ url: image }],
    },
    twitter: {
      card: largeImage ? 'summary_large_image' : 'summary',
      title,
      description,
      images: [image],
    },
  };
}

export default async function CatalogoPage() {
  const [{ courses, seo, origin }, brand] = await Promise.all([load(), loadBrand()]);
  const brandCss = brand ? brandStyle(brand.brandHue, brand.brandSaturation) : null;
  const listed =
    seo?.indexable && courses
      ? courses.filter((c) => seo.courses.some((s) => s.slug === c.slug)).map((c) => c.slug)
      : [];
  return (
    <>
      {/* El color del aula ya en el HTML (sin parpadeo al hidratar). */}
      {brandCss ? <style dangerouslySetInnerHTML={{ __html: brandCss }} /> : null}
      {seo?.indexable && origin && listed.length > 0 ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(catalogJsonLd(listed, seo, origin)) }}
        />
      ) : null}
      <Suspense fallback={<div className="skeleton h-96 w-full rounded-3xl" />}>
        <CatalogoView
          // Sin el HTML de la descripción: la tarjeta solo enseña texto plano.
          initialCourses={courses?.map(({ descriptionHtml: _html, ...c }) => c)}
          initialBrand={
            brand
              ? {
                  name: brand.name,
                  logoUrl: brand.logoUrl,
                  brandHue: brand.brandHue,
                  brandSaturation: brand.brandSaturation,
                }
              : undefined
          }
        />
      </Suspense>
    </>
  );
}
