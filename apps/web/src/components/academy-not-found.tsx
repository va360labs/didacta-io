'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import { AcademyMark } from '@/components/academy-mark';
import { PoweredByDidacta } from '@/components/powered-by-didacta';
import { useTenantContext } from '@/lib/tenant-context';

/**
 * 404 del AULA con su marca —su logo o, sin él, sus iniciales sobre su color—
 * y, al pie, «Powered by Didacta». Lo monta `app/not-found.tsx`.
 *
 * Es de cliente a propósito: la marca sale del contexto del aula que el
 * navegador ya pide en todas las pantallas. Un 404 de SERVIDOR que esperase a
 * la API retrasaba el envío de TODAS las páginas (Next prepara el 404 raíz en
 * cada petición) y el `<title>` acababa pintado en el `<body>`.
 */
export function AcademyNotFound() {
  const t = useTranslations('common.notFound');
  const { tenant, loading } = useTenantContext();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg-subtle px-4 py-12">
      <title>{tenant ? `${t('metaTitle')} | ${tenant.name}` : t('metaTitle')}</title>
      <div className="w-full max-w-md rounded-3xl border border-border bg-surface p-8 text-center shadow-sm">
        <a
          href="/"
          className="mx-auto inline-flex min-h-10 max-w-full items-center gap-2.5"
          aria-label={tenant?.name}
          data-testid="not-found-brand"
        >
          {loading ? (
            // Sin el contexto todavía, un hueco del tamaño de la marca.
            <span aria-hidden="true" className="block h-10 w-10 rounded-lg bg-bg-subtle" />
          ) : tenant?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={tenant.logoUrl} alt="" className="h-10 w-auto max-w-[200px] object-contain" />
          ) : (
            <AcademyMark
              name={tenant?.name}
              neutral={!tenant}
              hue={tenant?.brandHue}
              saturation={tenant?.brandSaturation}
              size={40}
            />
          )}
          {tenant && !tenant.logoUrl ? (
            <span className="truncate text-[17px] font-bold text-text">{tenant.name}</span>
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
      <PoweredByDidacta className="mt-8" />
    </main>
  );
}
