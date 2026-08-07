'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CourseCard, type CourseCardData } from '@/components/course-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ApiHttpError } from '@/lib/api-client';
import {
  splitCoursesBySection,
  type CatalogEnrollmentInfo as EnrollmentInfo,
} from '@/lib/catalog-sections';
import { coursesApi, type Course } from '@/lib/courses';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { labelOr } from '@/lib/i18n/labels';
import { learningApi, type Enrollment } from '@/lib/learning';
import { useTenantDisplayName } from '@/lib/tenant-context';

const ALL_CATEGORIES = '__all__';
const ALL_LANGUAGES = '__all__';

export function CatalogView() {
  const router = useRouter();
  const params = useSearchParams();
  const tenantName = useTenantDisplayName();
  const t = useTranslations('alumnoAprendizaje');
  const tErrors = useTranslations('errors');

  const initialQ = params.get('q') ?? '';
  const initialCategory = params.get('category') ?? ALL_CATEGORIES;

  const [courses, setCourses] = useState<Course[] | null>(null);
  const [enrollments, setEnrollments] = useState<Map<string, EnrollmentInfo>>(new Map());
  /**
   * Las matrículas llegan en paralelo al listado. Hasta que estén, no sabemos
   * qué cursos son "míos": si pintáramos ya, todo caería en "Otros cursos" y
   * los cursos del alumno saltarían de sección a la vista. Esperamos a ambos.
   */
  const [enrollmentsLoaded, setEnrollmentsLoaded] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // El input se actualiza al teclear; `debouncedQ` es lo que efectivamente
  // dispara la búsqueda y se sincroniza con la URL — así evitamos hacer
  // un fetch por cada tecla.
  const [searchInput, setSearchInput] = useState(initialQ);
  const [debouncedQ, setDebouncedQ] = useState(initialQ);
  const [category, setCategory] = useState(initialCategory);
  // Filtro por idioma del curso: puramente client-side (el idioma ya viene en
  // el listado), sin sincronizar con la URL. Solo se ofrece cuando el catálogo
  // cargado tiene más de un idioma distinto.
  const [language, setLanguage] = useState(ALL_LANGUAGES);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // Sincroniza filtros activos con la URL para que el estado sea
  // compartible/recuperable al refrescar.
  useEffect(() => {
    const next = new URLSearchParams();
    if (debouncedQ) next.set('q', debouncedQ);
    if (category && category !== ALL_CATEGORIES) next.set('category', category);
    const qs = next.toString();
    router.replace(qs ? `/cursos?${qs}` : '/cursos', { scroll: false });
  }, [debouncedQ, category, router]);

  // Categorías: se cargan una vez. No filtran a sí mismas: queremos
  // mostrar todas las disponibles aunque el usuario haya filtrado por
  // texto y eso reduzca el listado.
  useEffect(() => {
    let aborted = false;
    void coursesApi
      .listCategories()
      .then((list) => {
        if (!aborted) setCategories(list);
      })
      .catch(() => {
        // Si falla la carga de categorías el filtro queda vacío pero el
        // listado sigue funcionando — no rompe la página.
      });
    return () => {
      aborted = true;
    };
  }, []);

  // Listado de cursos: re-fetch cuando cambian los filtros activos.
  useEffect(() => {
    let aborted = false;
    setCourses(null);
    void coursesApi
      .list({
        status: 'PUBLISHED',
        ...(debouncedQ ? { q: debouncedQ } : {}),
        ...(category && category !== ALL_CATEGORIES ? { category } : {}),
      })
      .then((list) => {
        if (aborted) return;
        setCourses(list);
        setError(null);
      })
      .catch((e) => {
        if (aborted) return;
        setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('catalogLoadError'));
      });
    return () => {
      aborted = true;
    };
    // Deps limitadas a las entradas reales del fetch: `t`/`tErrors` solo
    // componen el mensaje de error, no deciden qué se pide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ, category]);

  // Las matriculaciones del usuario se cargan en paralelo solo en el
  // primer render para no spamear el endpoint en cada keystroke.
  useEffect(() => {
    let aborted = false;
    void learningApi
      .listMine()
      .then((mine) => {
        if (aborted) return;
        setEnrollments(
          new Map(
            mine.map((e: Enrollment) => [
              e.courseId,
              { status: e.status, progressPercent: e.progressPercent },
            ]),
          ),
        );
      })
      .catch(() => {
        // Sin matrículas conocidas el catálogo sigue siendo usable: todo cae en
        // "Otros cursos". No bloqueamos la página por esto.
      })
      .finally(() => {
        if (!aborted) setEnrollmentsLoaded(true);
      });
    return () => {
      aborted = true;
    };
  }, []);

  const hasActiveFilters = useMemo(
    () =>
      debouncedQ.length > 0 ||
      (category !== '' && category !== ALL_CATEGORIES) ||
      language !== ALL_LANGUAGES,
    [debouncedQ, category, language],
  );

  // Idiomas distintos presentes en el catálogo cargado (para el filtro).
  const languages = useMemo(() => {
    const set = new Set<string>();
    for (const c of courses ?? []) {
      if (c.language) set.add(c.language);
    }
    return [...set].sort();
  }, [courses]);

  // Filtro por idioma aplicado en cliente sobre el listado ya cargado.
  const visibleCourses = useMemo(() => {
    const list = courses ?? [];
    return language === ALL_LANGUAGES ? list : list.filter((c) => c.language === language);
  }, [courses, language]);

  const { mine, others } = useMemo(
    () => splitCoursesBySection(visibleCourses, enrollments),
    [visibleCourses, enrollments],
  );

  function toCardData(c: Course): CourseCardData {
    const enrollment = enrollments.get(c.id);
    return {
      id: c.id,
      slug: c.slug,
      title: c.title,
      description: c.description,
      category: c.category,
      estimatedMinutes: c.estimatedMinutes,
      language: c.language,
      thumbnailUrl: c.thumbnailUrl,
      progressPercent: enrollment?.progressPercent ?? null,
      status: enrollment?.status ?? null,
    };
  }

  function clearFilters() {
    setSearchInput('');
    setDebouncedQ('');
    setCategory(ALL_CATEGORIES);
    setLanguage(ALL_LANGUAGES);
  }

  return (
    <section className="space-y-8">
      <header>
        <h1
          className="font-display text-2xl font-bold tracking-tight text-text"
          style={{ letterSpacing: '-0.02em' }}
        >
          {t('catalogTitle')}
        </h1>
        <p className="mt-2 max-w-2xl text-text-muted">{t('catalogSubtitle')}</p>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex-1">
          <Input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchAria')}
          />
        </div>
        <div className="sm:w-64">
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label={t('categoryFilterAria')}
          >
            <option value={ALL_CATEGORIES}>{t('allCategories')}</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>
        {/* Filtro por idioma del curso: aparece solo cuando el catálogo tiene
            más de un idioma (o cuando ya hay uno seleccionado, para poder
            deshacerlo aunque el listado filtrado quede monolingüe). */}
        {languages.length > 1 || language !== ALL_LANGUAGES ? (
          <div className="sm:w-44">
            <Select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              aria-label={t('languageFilterAria')}
            >
              <option value={ALL_LANGUAGES}>{t('allLanguages')}</option>
              {languages.map((lang) => (
                <option key={lang} value={lang}>
                  {labelOr(t, `courseLanguage.${lang}`, lang)}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {hasActiveFilters ? (
          <Button variant="ghost" type="button" onClick={clearFilters}>
            {t('clear')}
          </Button>
        ) : null}
      </div>

      {error ? (
        <Card>
          <CardContent className="p-6">
            <p className="text-danger-700">{error}</p>
          </CardContent>
        </Card>
      ) : courses === null || !enrollmentsLoaded ? (
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <div key={i} className="skeleton h-64 w-full" />
          ))}
        </div>
      ) : courses.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <h3 className="font-display text-2xl font-semibold">
              {hasActiveFilters ? t('noCoursesFiltered') : t('noCoursesYet')}
            </h3>
            <p className="max-w-md text-text-muted">
              {hasActiveFilters ? t('noCoursesFilteredHint') : t('noCoursesYetHint')}
            </p>
            {hasActiveFilters ? (
              <Button variant="ghost" type="button" onClick={clearFilters} className="mt-2">
                {t('clearFilters')}
              </Button>
            ) : (
              <Button asChild className="mt-2">
                <Link href="/formador/cursos/nuevo">{t('createCourse')}</Link>
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-10">
          <CatalogSection
            title={t('myCourses')}
            count={mine.length}
            emptyText={hasActiveFilters ? t('myCoursesEmptyFiltered') : t('myCoursesEmpty')}
          >
            {mine.map((c) => (
              <CourseCard key={c.id} course={toCardData(c)} />
            ))}
          </CatalogSection>

          <CatalogSection
            title={t('otherCourses', { name: tenantName })}
            count={others.length}
            emptyText={hasActiveFilters ? t('otherCoursesEmptyFiltered') : t('otherCoursesEmpty')}
          >
            {others.map((c) => (
              <CourseCard key={c.id} course={toCardData(c)} />
            ))}
          </CatalogSection>
        </div>
      )}
    </section>
  );
}

/**
 * Sección del catálogo con su título y su rejilla. Cuando está vacía mantiene
 * el título y explica por qué: al alumno le orienta más ver "Mis cursos —
 * todavía ninguno" que no ver la sección.
 */
function CatalogSection({
  title,
  count,
  emptyText,
  children,
}: {
  title: string;
  count: number;
  emptyText: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      {/* El contador va FUERA del <h2> a propósito: así el nombre accesible del
          encabezado es siempre el título, estable para lectores de pantalla y
          para los tests, sin depender de cuántos cursos haya. */}
      <div className="flex items-baseline gap-2">
        <h2 className="font-display text-xl font-semibold tracking-tight text-text">{title}</h2>
        {count > 0 ? <span className="text-base font-normal text-text-muted">{count}</span> : null}
      </div>
      {count === 0 ? (
        <p className="text-sm text-text-muted">{emptyText}</p>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{children}</div>
      )}
    </section>
  );
}
