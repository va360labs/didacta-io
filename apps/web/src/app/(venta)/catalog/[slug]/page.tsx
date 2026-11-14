/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { cache, Suspense } from 'react';
import { publicHost } from '@/lib/academy-locale';
import {
  canonicalOrigin,
  canonicalUrl,
  courseJsonLd,
  fichaPath,
  htmlToText,
  ogLocale,
  serializeJsonLd,
  truncate,
  type PublicSeo,
} from '@/lib/seo';
import { brandStyle } from '@/lib/academy-home';
import {
  fetchPublicBrand,
  fetchPublicCatalog,
  fetchPublicSeo,
  requestOrigin,
  type ServerCatalogCourse,
} from '@/lib/seo-server';
import { FichaVentaView } from './ficha-venta-view';

/**
 * Ficha PÚBLICA de venta de un curso suelto (viaje 2): visible sin sesión.
 * Muestra las opciones de compra reales de mod.billing y lanza el checkout
 * anónimo de Stripe. La ficha completa del alumno (temario, progreso) sigue
 * en /courses/[slug] tras iniciar sesión.
 *
 * Se pinta en el SERVIDOR con el curso dentro: su título, descripción y precio
 * están en el HTML sin ejecutar JavaScript, que es lo que lee un buscador (la
 * ficha de un curso a la venta SÍ se indexa cuando el aula tiene su portada
 * pública encendida; ver `lib/seo.ts`). Un curso que no está a la venta da 404
 * de verdad. Si la API no contesta en ese momento, la ficha cae al camino de
 * antes (la pide el navegador) y no se indexa.
 */

interface PageProps {
  params: Promise<{ slug: string }>;
}

type Loaded =
  | { status: 'found'; course: ServerCatalogCourse }
  | { status: 'missing' }
  | { status: 'unknown' };

/** Curso, indexación y origen: una vez por petición (metadatos + página). */
const load = cache(
  async (
    slug: string,
  ): Promise<{ loaded: Loaded; seo: PublicSeo | null; origin: string | null }> => {
    const h = await headers();
    const host = publicHost(h);
    const xff = h.get('x-forwarded-for');
    const [courses, seo] = await Promise.all([
      fetchPublicCatalog(host, xff),
      fetchPublicSeo(host, xff),
    ]);
    const course = courses?.find((c) => c.slug === slug);
    const loaded: Loaded = course
      ? { status: 'found', course }
      : courses
        ? { status: 'missing' }
        : { status: 'unknown' };
    return { loaded, seo, origin: canonicalOrigin(seo, requestOrigin(h, host)) };
  },
);

/** ¿Se indexa esta ficha? Aula con portada pública y curso a la venta. */
function indexableSeo(seo: PublicSeo | null, slug: string) {
  return seo?.indexable && seo.courses.some((c) => c.slug === slug) ? seo : null;
}

async function descriptionFor(course: ServerCatalogCourse, academyName: string | null) {
  const text = htmlToText(course.description);
  if (text) return truncate(text);
  const t = await getTranslations('publicSite.ficha');
  return academyName
    ? t('metaDescription', { title: course.title, name: academyName })
    : course.title;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const { loaded, seo, origin } = await load(slug);
  if (loaded.status !== 'found') {
    const t = await getTranslations('publicSite');
    return { title: t('ficha.metaTitle') };
  }
  const { course } = loaded;
  const academyName = seo?.indexable ? seo.academy.name : null;
  const title = academyName ? `${course.title} | ${academyName}` : course.title;
  const description = await descriptionFor(course, academyName);
  const canonical = origin ? canonicalUrl(origin, fichaPath(course.slug)) : null;
  const image = course.thumbnailUrl;
  return {
    // Con el nombre del aula, el título es completo y no lleva el sufijo de
    // la plataforma; sin él (aula sin portada), el de siempre.
    title: academyName ? { absolute: title } : title,
    description,
    ...(indexableSeo(seo, course.slug)
      ? { robots: { index: true, follow: true, 'max-image-preview': 'large' as const } }
      : {}),
    ...(origin ? { metadataBase: new URL(origin) } : {}),
    // Con `?ref=` es la misma ficha: el canonical, a la URL limpia.
    ...(canonical ? { alternates: { canonical } } : {}),
    openGraph: {
      type: 'website',
      title,
      description,
      locale: ogLocale(await getLocale()),
      ...(academyName ? { siteName: academyName } : {}),
      ...(canonical ? { url: canonical } : {}),
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: {
      card: image ? 'summary_large_image' : 'summary',
      title,
      description,
      ...(image ? { images: [image] } : {}),
    },
  };
}

export default async function FichaVentaPage({ params }: PageProps) {
  const { slug } = await params;
  const { loaded, seo, origin } = await load(slug);
  if (loaded.status === 'missing') notFound();

  if (loaded.status === 'unknown') {
    return (
      <Suspense fallback={<div className="skeleton h-96 w-full rounded-3xl" />}>
        <FichaVentaView />
      </Suspense>
    );
  }

  const { course } = loaded;
  const indexable = indexableSeo(seo, course.slug);
  const h = await headers();
  const brand = await fetchPublicBrand(publicHost(h), h.get('x-forwarded-for'));
  const brandCss = brand ? brandStyle(brand.brandHue, brand.brandSaturation) : null;
  return (
    <>
      {/* El color del aula ya en el HTML: sin él, el botón de compra salía en
          el azul de Didacta y cambiaba al del aula al hidratar. */}
      {brandCss ? <style dangerouslySetInnerHTML={{ __html: brandCss }} /> : null}
      {indexable && origin ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: serializeJsonLd(
              courseJsonLd(
                course,
                await descriptionFor(course, indexable.academy.name),
                indexable,
                origin,
              ),
            ),
          }}
        />
      ) : null}
      <FichaVentaView
        initialCourse={course}
        initialBrand={brand ? { name: brand.name, logoUrl: brand.logoUrl } : undefined}
        // HTML saneado por la API (la frontera autoritativa): pintado aquí, en
        // el servidor, el navegador lo recibe tal cual y no lo vuelve a tocar.
        description={
          course.descriptionHtml ? (
            <div
              className="prose prose-slate max-w-none leading-relaxed prose-p:text-text-muted prose-a:text-brand-700"
              dangerouslySetInnerHTML={{ __html: course.descriptionHtml }}
            />
          ) : null
        }
      />
    </>
  );
}
