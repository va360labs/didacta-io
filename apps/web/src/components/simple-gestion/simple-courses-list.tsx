'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { coursesApi, type Course } from '@/lib/courses';
import { cn } from '@/lib/utils';

/**
 * «Cursos» del creador en MODO SENCILLO: sus cursos con su estado y un botón
 * claro para crear otro (solo título; el enlace se genera solo). Sin cursos,
 * un estado vacío que explica qué es un curso y lleva a crear el primero.
 */
export function SimpleCoursesList() {
  const t = useTranslations('modoSencilloGestion.cursos');
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    coursesApi
      .list()
      .then(setCourses)
      .catch(() => setError(t('cargaError')));
  }, [t]);

  return (
    <div className="mx-auto max-w-[880px]" data-testid="cursos-sencillo">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] leading-tight font-extrabold tracking-tight text-text">
            {t('titulo')}
          </h1>
          <p className="mt-1 text-text-muted">{t('sub')}</p>
        </div>
        {courses && courses.length > 0 ? (
          <Link
            href="/studio/courses/new"
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700"
          >
            <Icon name="plus" size={17} />
            {t('nuevo')}
          </Link>
        ) : null}
      </header>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-xl bg-danger-50 p-3 text-sm font-semibold text-danger-700"
        >
          {error}
        </p>
      ) : null}

      {courses === null && !error ? (
        <div className="skeleton mt-6 h-40 w-full" />
      ) : courses && courses.length === 0 ? (
        <section className="mt-6 rounded-2xl border border-border bg-surface px-6 py-10 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-brand-50 text-brand-700">
            <Icon name="book" size={24} />
          </span>
          <h2 className="mt-4 text-lg font-bold text-text">{t('vacioTitulo')}</h2>
          <p className="mx-auto mt-2 max-w-[54ch] text-text-muted">{t('vacioTexto')}</p>
          <Link
            href="/studio/courses/new"
            className="mt-5 inline-flex h-11 items-center gap-2 rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700"
          >
            <Icon name="plus" size={17} />
            {t('vacioBoton')}
          </Link>
        </section>
      ) : courses ? (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {courses.map((c) => {
            const published = c.status === 'PUBLISHED';
            return (
              <li key={c.id}>
                <Link
                  href={`/studio/courses/${c.id}`}
                  className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface hover:border-border-strong"
                >
                  {c.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.thumbnailUrl} alt="" className="h-28 w-full object-cover" />
                  ) : (
                    <div className="h-28 bg-[linear-gradient(135deg,hsl(var(--brand-h)_70%_88%),hsl(174_60%_86%))]" />
                  )}
                  <div className="flex flex-1 items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <div className="truncate font-bold text-text">{c.title}</div>
                      <span
                        className={cn(
                          'mt-1 inline-block rounded-full px-2.5 py-0.5 text-xs font-bold',
                          published
                            ? 'bg-success-50 text-success-700'
                            : 'bg-bg-subtle text-text-subtle',
                        )}
                      >
                        {published ? t('publicado') : t('borrador')}
                      </span>
                    </div>
                    <span className="text-sm font-semibold text-brand-600">{t('editar')}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
