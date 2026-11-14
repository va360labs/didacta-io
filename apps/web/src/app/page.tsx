/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { cache } from 'react';
import { AcademyHomeView } from '@/components/academy-home/academy-home-view';
import { publicHost } from '@/lib/academy-locale';
import { fetchAcademyHome, referralFromQuery } from '@/lib/academy-home';
import {
  academyJsonLd,
  canonicalOrigin,
  canonicalUrl,
  ogLocale,
  serializeJsonLd,
  truncate,
} from '@/lib/seo';
import { fetchPublicSeo, requestOrigin } from '@/lib/seo-server';

/**
 * La raíz del aula.
 *
 * Con la «Página pública de la academia» activada (por defecto en el modo
 * sencillo), quien entra SIN sesión ve la portada del aula con sus opciones de
 * acceso, como la página «About» de un grupo de Skool. Quien tiene sesión va a
 * su inicio de siempre (`/home`): lo hace la propia portada en el navegador,
 * porque la sesión vive en el almacenamiento del navegador y el servidor no la
 * ve.
 *
 * Con el ajuste apagado, o si la API no contesta, lo de siempre: `/home`, que
 * lleva a la comunidad a quien tiene sesión y al acceso a quien no.
 */

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Una sola llamada a la API por petición (metadatos + página). */
const loadHome = cache(async () => {
  const h = await headers();
  return fetchAcademyHome(publicHost(h), h.get('x-forwarded-for'));
});

/**
 * Indexación del aula (dominio canónico, datos para el JSON-LD) y origen de la
 * petición. La API la cachea por aula y este servidor por host.
 */
const loadSeo = cache(async () => {
  const h = await headers();
  const host = publicHost(h);
  const seo = await fetchPublicSeo(host, h.get('x-forwarded-for'));
  return { seo, origin: canonicalOrigin(seo, requestOrigin(h, host)) };
});

export async function generateMetadata(): Promise<Metadata> {
  const home = await loadHome();
  if (!home || !home.enabled) return {};
  const t = await getTranslations('publicSite.portada');
  const locale = await getLocale();
  const { origin } = await loadSeo();
  const { academy } = home;
  const title = academy.name || t('metaFallbackTitle');
  const description = truncate(academy.description ?? t('metaDescription', { name: title }));
  const image = academy.coverUrl ?? academy.logoUrl;
  const canonical = origin ? canonicalUrl(origin, '/') : null;
  return {
    // El nombre del aula, sin el sufijo de la plataforma: es su página.
    title: { absolute: title },
    description,
    // Decisión de Valentín: la portada pública SÍ se indexa (lo demás del aula
    // sigue con el `noindex` del layout raíz). Con `?ref=` o `?preview=1` es la
    // misma página: el canonical, siempre a la URL limpia.
    robots: { index: true, follow: true, 'max-image-preview': 'large' },
    ...(origin ? { metadataBase: new URL(origin) } : {}),
    ...(canonical ? { alternates: { canonical } } : {}),
    openGraph: {
      type: 'website',
      siteName: title,
      title,
      description,
      locale: ogLocale(locale),
      ...(canonical ? { url: canonical } : {}),
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: {
      card: academy.coverUrl ? 'summary_large_image' : 'summary',
      title,
      description,
      ...(image ? { images: [image] } : {}),
    },
  };
}

export default async function RootPage({ searchParams }: { searchParams: SearchParams }) {
  const home = await loadHome();
  if (!home || !home.enabled) redirect('/home');
  const sp = await searchParams;
  const { seo, origin } = await loadSeo();
  return (
    <>
      {/* Datos estructurados de la academia, solo con datos reales del aula. */}
      {seo?.indexable && origin ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(academyJsonLd(seo, origin)) }}
        />
      ) : null}
      <AcademyHomeView
        home={home}
        refCode={referralFromQuery(sp.ref)}
        preview={sp.preview === '1'}
      />
    </>
  );
}
