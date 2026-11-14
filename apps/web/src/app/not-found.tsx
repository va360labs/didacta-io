/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { AcademyMark } from '@/components/academy-mark';
import { PoweredByDidacta } from '@/components/powered-by-didacta';
import { publicHost } from '@/lib/academy-locale';
import { fetchPublicBrandCached } from '@/lib/seo-server';

/**
 * 404 del AULA (cualquier ruta que no existe en su dominio). Antes salía la
 * página genérica de Next, en inglés y sin marca. Ahora lleva la del aula —su
 * logo o, sin él, sus iniciales sobre su color— y, al pie, «Powered by
 * Didacta», como el resto de pantallas del aula.
 *
 * Un dominio que no es de ningún aula no llega aquí (el middleware le contesta
 * un 404 pelado), y el sitio público tiene su propio 404 sin marca
 * (`app/site/not-found.tsx`).
 */
export default async function AulaNotFound() {
  const t = await getTranslations('common.notFound');
  const h = await headers();
  const brand = await fetchPublicBrandCached(publicHost(h), h.get('x-forwarded-for'));
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg-subtle px-4 py-12">
      <title>{brand ? `${t('metaTitle')} | ${brand.name}` : t('metaTitle')}</title>
      <div className="w-full max-w-md rounded-3xl border border-border bg-surface p-8 text-center shadow-sm">
        <a
          href="/"
          className="mx-auto inline-flex max-w-full items-center gap-2.5"
          aria-label={brand?.name}
          data-testid="not-found-brand"
        >
          {brand?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.logoUrl} alt="" className="h-10 w-auto max-w-[200px] object-contain" />
          ) : (
            <AcademyMark
              name={brand?.name}
              neutral={!brand}
              hue={brand?.brandHue}
              saturation={brand?.brandSaturation}
              size={40}
            />
          )}
          {brand && !brand.logoUrl ? (
            <span className="truncate text-[17px] font-bold text-text">{brand.name}</span>
          ) : null}
        </a>
        <h1 className="mt-6 font-display text-2xl font-bold tracking-tight text-text">
          {t('title')}
        </h1>
        <p className="mt-2 text-text-muted">{t('body')}</p>
        <a
          href="/"
          className="mt-6 inline-flex h-11 items-center rounded-xl bg-brand-600 px-5 font-semibold text-white transition-colors hover:bg-brand-700"
        >
          {t('backHome')}
        </a>
      </div>
      <PoweredByDidacta slug={brand?.slug ?? null} className="mt-8" />
    </main>
  );
}
