'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CourseStatusBadge } from '@/components/course-status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { coursesApi, type Course } from '@/lib/courses';

export default function FormadorCoursesPage() {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const data = await coursesApi.list();
      setCourses(data);
    } catch (e) {
      setError(
        e instanceof ApiHttpError
          ? e.message
          : 'No pudimos cargar tus cursos. Probá refrescar la página.',
      );
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Mis cursos</h1>
          <p className="mt-1 text-text-muted">
            Cursos creados en tu organización: borradores, publicados y archivados.
          </p>
        </div>
        <Button asChild>
          <Link href="/formador/cursos/nuevo">Crear curso nuevo</Link>
        </Button>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {courses === null ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-32 w-full" />
          ))}
        </div>
      ) : courses.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <h3 className="font-display text-2xl font-semibold">Aún no tenés cursos</h3>
            <p className="max-w-md text-text-muted">
              Empezá creando tu primer curso. Vas a poder añadir módulos, lecciones, quizzes y
              certificados después.
            </p>
            <Button asChild className="mt-2">
              <Link href="/formador/cursos/nuevo">Crear mi primer curso</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {courses.map((c) => (
            <Link
              key={c.id}
              href={`/formador/cursos/${c.id}` as never}
              className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              <Card interactive className="h-full">
                <CardContent className="space-y-3 p-5">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-display text-lg font-semibold leading-tight">{c.title}</h3>
                    <CourseStatusBadge status={c.status} />
                  </div>
                  <p className="text-xs text-text-subtle font-mono">/{c.slug}</p>
                  <p className="line-clamp-2 text-sm text-text-muted leading-relaxed">
                    {c.description ?? 'Sin descripción todavía.'}
                  </p>
                  <p className="text-xs text-text-subtle tabular-nums">
                    Actualizado{' '}
                    {new Date(c.updatedAt).toLocaleDateString('es-AR', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
