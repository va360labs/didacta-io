'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { CourseCard, type CourseCardData } from '@/components/course-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ApiHttpError } from '@/lib/api-client';
import { coursesApi, type Course } from '@/lib/courses';
import { learningApi, type Enrollment } from '@/lib/learning';

interface EnrollmentInfo {
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  progressPercent: number;
}

const ALL_CATEGORIES = '__all__';

export function CatalogView() {
  const router = useRouter();
  const params = useSearchParams();

  const initialQ = params.get('q') ?? '';
  const initialCategory = params.get('category') ?? ALL_CATEGORIES;

  const [courses, setCourses] = useState<Course[] | null>(null);
  const [enrollments, setEnrollments] = useState<Map<string, EnrollmentInfo>>(new Map());
  const [categories, setCategories] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // El input se actualiza al teclear; `debouncedQ` es lo que efectivamente
  // dispara la búsqueda y se sincroniza con la URL — así evitamos hacer
  // un fetch por cada tecla.
  const [searchInput, setSearchInput] = useState(initialQ);
  const [debouncedQ, setDebouncedQ] = useState(initialQ);
  const [category, setCategory] = useState(initialCategory);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(searchInput.trim()), 300);
    return () => window.clearTimeout(t);
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
        setError(
          e instanceof ApiHttpError
            ? e.message
            : 'No pudimos cargar el catálogo. Prueba refrescar la página.',
        );
      });
    return () => {
      aborted = true;
    };
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
      .catch((): Enrollment[] => []);
    return () => {
      aborted = true;
    };
  }, []);

  const hasActiveFilters = useMemo(
    () => debouncedQ.length > 0 || (category !== '' && category !== ALL_CATEGORIES),
    [debouncedQ, category],
  );

  function clearFilters() {
    setSearchInput('');
    setDebouncedQ('');
    setCategory(ALL_CATEGORIES);
  }

  return (
    <section className="space-y-8">
      <header>
        <h1
          className="font-display text-4xl font-extrabold tracking-tight text-text"
          style={{ letterSpacing: '-0.02em' }}
        >
          Catálogo de cursos
        </h1>
        <p className="mt-2 max-w-2xl text-text-muted">
          Explora los cursos publicados de tu organización. Haz clic en uno para ver el detalle y
          matricularte.
        </p>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex-1">
          <Input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Buscar por título o descripción..."
            aria-label="Buscar cursos"
          />
        </div>
        <div className="sm:w-64">
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Filtrar por temática"
          >
            <option value={ALL_CATEGORIES}>Todas las temáticas</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>
        {hasActiveFilters ? (
          <Button variant="ghost" type="button" onClick={clearFilters}>
            Limpiar
          </Button>
        ) : null}
      </div>

      {error ? (
        <Card>
          <CardContent className="p-6">
            <p className="text-danger-700">{error}</p>
          </CardContent>
        </Card>
      ) : courses === null ? (
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <div key={i} className="skeleton h-64 w-full" />
          ))}
        </div>
      ) : courses.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <h3 className="font-display text-2xl font-semibold">
              {hasActiveFilters
                ? 'No encontramos cursos con esos filtros'
                : 'Aún no hay cursos publicados'}
            </h3>
            <p className="max-w-md text-text-muted">
              {hasActiveFilters
                ? 'Probá con otra búsqueda o limpiá los filtros para ver todo el catálogo.'
                : 'Cuando un formador publique el primer curso, aparecerá acá. Si sos formador, podés empezar a crear uno.'}
            </p>
            {hasActiveFilters ? (
              <Button variant="ghost" type="button" onClick={clearFilters} className="mt-2">
                Limpiar filtros
              </Button>
            ) : (
              <Button asChild className="mt-2">
                <Link href="/formador/cursos/nuevo">Crear un curso</Link>
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {courses.map((c) => {
            const enrollment = enrollments.get(c.id);
            const data: CourseCardData = {
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
            return <CourseCard key={c.id} course={data} />;
          })}
        </div>
      )}
    </section>
  );
}
