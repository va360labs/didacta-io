'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CourseStatusBadge } from '@/components/course-status-badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { coursesApi, type Course } from '@/lib/courses';

export default function CatalogPage() {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    void coursesApi
      .list({ status: 'PUBLISHED' })
      .then((data) => {
        if (!aborted) setCourses(data);
      })
      .catch((e) => {
        if (!aborted) setError(e instanceof ApiHttpError ? e.message : 'Error al cargar catálogo');
      });
    return () => {
      aborted = true;
    };
  }, []);

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Catálogo</h1>
        <p className="mt-1 text-sm text-neutral-500">Cursos publicados disponibles en tu tenant.</p>
      </header>

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {courses && courses.length === 0 ? (
        <p className="text-sm text-neutral-500">No hay cursos publicados todavía.</p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {(courses ?? []).map((c) => (
          <Link key={c.id} href={`/cursos/${c.slug}` as never}>
            <Card className="h-full transition hover:border-neutral-400 dark:hover:border-neutral-600">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-lg">{c.title}</CardTitle>
                  <CourseStatusBadge status={c.status} />
                </div>
                {c.category ? (
                  <CardDescription className="mt-1 text-xs uppercase tracking-wider">
                    {c.category}
                  </CardDescription>
                ) : null}
              </CardHeader>
              <CardContent>
                <p className="line-clamp-3 text-sm text-neutral-600 dark:text-neutral-400">
                  {c.description ?? 'Sin descripción.'}
                </p>
                {c.estimatedMinutes ? (
                  <p className="mt-2 text-xs text-neutral-500">≈ {c.estimatedMinutes} min</p>
                ) : null}
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}
