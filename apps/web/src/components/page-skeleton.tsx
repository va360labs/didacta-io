'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';

/**
 * Esqueleto de carga del aula: lo que se ve mientras se decide adónde va quien
 * acaba de entrar, en vez de una pantalla en blanco (grabación de la primera
 * venta, 14-nov-2026: tras entrar, `/home` salía en blanco ~1 s antes de la
 * comunidad).
 *
 * Calca el armazón de la comunidad, que es donde aterriza casi todo el mundo:
 * la barra de «Escribe algo», tres publicaciones y la columna del aula. Mismos
 * bloques `.skeleton` que el feed cuando aún no tiene publicaciones, así que al
 * llegar la página no salta nada de sitio.
 */
export function PageSkeleton() {
  const t = useTranslations('shell');
  return (
    <div
      className="grid gap-6 lg:grid-cols-[1fr_320px]"
      aria-busy="true"
      data-testid="pagina-cargando"
    >
      <span className="sr-only" role="status">
        {t('loading')}
      </span>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="skeleton h-[66px] w-full rounded-2xl" />
        <div className="flex gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-9 w-24 rounded-full" />
          ))}
        </div>
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-32 w-full" />
        ))}
      </div>
      <div className="hidden flex-col gap-4 lg:flex">
        <div className="skeleton h-64 w-full rounded-2xl" />
        <div className="skeleton h-28 w-full rounded-2xl" />
      </div>
    </div>
  );
}

/**
 * Lo mismo a pantalla completa, para cuando aún no hay armazón: el shell
 * espera a saber quién entra (sesión, asistentes pendientes) y en qué modo
 * está el aula, y pintar un menú para cambiarlo luego sería peor. Mismo fondo
 * que el aula y el contenido en su sitio.
 */
export function AppLoadingScreen() {
  return (
    <div className="min-h-dvh bg-bg-subtle">
      <div className="mx-auto max-w-[1180px] px-4 pt-[84px] pb-24 lg:px-6">
        <PageSkeleton />
      </div>
    </div>
  );
}
