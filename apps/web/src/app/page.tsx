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

/** Origen público de la petición, para las URL absolutas de Open Graph. */
async function requestOrigin(): Promise<string | null> {
  const h = await headers();
  const host = publicHost(h);
  if (!host) return null;
  const proto =
    h.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
    (/^(localhost|127\.|\[::1\])|\.localhost(:|$)/.test(host) ? 'http' : 'https');
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}

/** `og:locale` en el formato de Open Graph. */
function ogLocale(locale: string): string {
  return locale.toLowerCase().startsWith('en') ? 'en_US' : 'es_ES';
}

export async function generateMetadata(): Promise<Metadata> {
  const home = await loadHome();
  if (!home || !home.enabled) return {};
  const t = await getTranslations('publicSite.portada');
  const locale = await getLocale();
  const origin = await requestOrigin();
  const { academy } = home;
  const title = academy.name || t('metaFallbackTitle');
  const description = academy.description ?? t('metaDescription', { name: title });
  const image = academy.coverUrl ?? academy.logoUrl;
  return {
    // El nombre del aula, sin el sufijo de la plataforma: es su página.
    title: { absolute: title },
    description,
    ...(origin ? { metadataBase: new URL(origin) } : {}),
    openGraph: {
      type: 'website',
      siteName: title,
      title,
      description,
      locale: ogLocale(locale),
      ...(origin ? { url: `${origin}/` } : {}),
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
  return (
    <AcademyHomeView home={home} refCode={referralFromQuery(sp.ref)} preview={sp.preview === '1'} />
  );
}
