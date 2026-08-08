'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Vista del catálogo público de cursos sueltos:
 *   - Cabecera con marca del tenant (logo/nombre reales) y contador real.
 *   - Chips de filtrado por categoría REAL del catálogo.
 *   - Parrilla de tarjetas: portada, categoría, duración, precio (tachado y
 *     % de descuento si los hay) y enlace a la ficha pública de venta.
 * Cero datos inventados: todo sale de la API del tenant. Mismo shell (venta)
 * que /unete — sin gate de sesión.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { formatDuration } from '@/lib/i18n/format';
import { useTenantContext } from '@/lib/tenant-context';
import { formatCents } from '@/lib/membership';
import { featuredOption, getPublicCatalog, type CatalogCourse } from '@/lib/catalog';

export function CatalogoView() {
  const t = useTranslations('publicSite');
  const tCommon = useTranslations('common');
  // Área pública: se pinta en SSR, donde el singleton de `user-prefs` está
  // vacío. Sin `locale` explícito el importe del servidor y el del cliente no
  // coinciden → mismatch de hidratación.
  const locale = useLocale();
  const { tenant } = useTenantContext();
  const [courses, setCourses] = useState<CatalogCourse[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState('Todos');

  useEffect(() => {
    let cancelled = false;
    getPublicCatalog()
      .then((r) => {
        if (!cancelled) setCourses(r.courses);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return (
      <div className="mx-auto max-w-lg rounded-3xl border border-border bg-surface p-8 text-center shadow-sm">
        <p className="text-text-muted">{t('catalogo.loadError')}</p>
      </div>
    );
  }

  if (courses === null) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-text-muted">
        {t('loading')}
      </div>
    );
  }

  const categories = [...new Set(courses.map((c) => c.category).filter((x): x is string => !!x))];
  const chips = categories.length > 0 ? ['Todos', ...categories] : [];
  const visible = filter === 'Todos' ? courses : courses.filter((c) => c.category === filter);

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      {/* ── Cabecera con marca del tenant ── */}
      <header className="space-y-3 text-center">
        {tenant?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={tenant.logoUrl}
            alt={tenant?.name ?? ''}
            className="mx-auto h-12 w-auto rounded-lg bg-white/95 p-1"
          />
        ) : tenant?.name ? (
          <span className="inline-flex items-center rounded-lg border border-border bg-surface px-4 py-2 text-xl font-extrabold text-text">
            {tenant.name}
          </span>
        ) : null}
        <h1 className="font-display text-3xl font-bold tracking-tight text-text">
          {t('catalogo.title')}
        </h1>
        {courses.length > 0 ? (
          <p className="text-text-muted">
            {t('catalogo.coursesAvailable', { count: courses.length })}
          </p>
        ) : null}
        <p className="text-sm text-text-subtle">
          {t.rich('catalogo.haveAccount', {
            link: (chunks) => (
              <Link href="/signin" className="font-medium text-brand-700 hover:underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </header>

      {courses.length === 0 ? (
        <div className="mx-auto max-w-lg rounded-3xl border border-border bg-surface p-8 text-center shadow-sm">
          <p className="text-text-muted">{t('catalogo.emptyCatalog')}</p>
        </div>
      ) : (
        <>
          {/* Chips de filtrado por categoría real */}
          {chips.length > 0 ? (
            <div className="flex flex-wrap justify-center gap-2">
              {chips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => setFilter(chip)}
                  className={
                    chip === filter
                      ? 'rounded-full bg-brand-600 px-4 py-1.5 text-sm font-medium text-white'
                      : 'rounded-full border border-border bg-surface px-4 py-1.5 text-sm text-text-muted hover:bg-surface-2'
                  }
                >
                  {chip === 'Todos' ? t('catalogo.filterAll') : chip}
                </button>
              ))}
            </div>
          ) : null}

          {/* Parrilla de cursos a la venta */}
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" data-testid="catalogo-grid">
            {visible.map((course) => {
              const option = featuredOption(course.options);
              return (
                <Link
                  key={course.id}
                  href={`/catalogo/${course.slug}`}
                  className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition hover:shadow-md"
                  data-testid="catalogo-card"
                >
                  {course.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={course.thumbnailUrl}
                      alt=""
                      className="aspect-video w-full object-cover"
                    />
                  ) : (
                    <div className="grid aspect-video w-full place-items-center bg-surface-2 text-text-subtle">
                      <Icon name="book" size={32} />
                    </div>
                  )}
                  <div className="flex flex-1 flex-col gap-2 p-5">
                    <div className="flex items-center gap-2 text-xs text-text-subtle">
                      {course.category ? (
                        <span className="rounded-full bg-surface-3 px-2 py-0.5 text-text-muted">
                          {course.category}
                        </span>
                      ) : null}
                      {course.estimatedMinutes ? (
                        <span className="inline-flex items-center gap-1">
                          <Icon name="clock" size={13} />
                          {formatDuration(course.estimatedMinutes, tCommon)}
                        </span>
                      ) : null}
                    </div>
                    <h2 className="font-semibold text-text group-hover:text-brand-700">
                      {course.title}
                    </h2>
                    {course.description ? (
                      <p className="line-clamp-2 text-sm text-text-muted">{course.description}</p>
                    ) : null}
                    <div className="mt-auto flex items-end justify-between pt-3">
                      {option ? (
                        <div className="flex items-baseline gap-2">
                          <span className="text-lg font-bold text-text">
                            {formatCents(option.unitAmount, option.currency, { locale })}
                          </span>
                          {option.compareAtAmount ? (
                            <span className="text-sm text-text-subtle line-through">
                              {formatCents(option.compareAtAmount, option.currency, { locale })}
                            </span>
                          ) : null}
                          {option.discountPercent ? (
                            <span className="rounded-full bg-success-100 px-2 py-0.5 text-xs font-semibold text-success-700">
                              {t('discountBadge', { percent: option.discountPercent })}
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <span />
                      )}
                      <span className="inline-flex items-center gap-1 text-sm font-medium text-brand-700">
                        {t('catalogo.viewCourse')}
                        <Icon name="arrow-right" size={15} />
                      </span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>

          <p className="pt-2 text-center text-sm text-text-subtle">
            {t.rich('catalogo.preferAllAccess', {
              link: (chunks) => (
                <Link href="/unete" className="font-medium text-brand-700 hover:underline">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        </>
      )}
    </div>
  );
}
