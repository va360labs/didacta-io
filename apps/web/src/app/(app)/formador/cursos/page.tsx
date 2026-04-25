'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CourseStatusBadge } from '@/components/course-status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
      setError(e instanceof ApiHttpError ? e.message : 'Error al cargar cursos');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Mis cursos</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Cursos creados en este tenant. Borradores y publicados.
          </p>
        </div>
        <Link href="/formador/cursos/nuevo">
          <Button>Nuevo curso</Button>
        </Link>
      </header>

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {(courses ?? []).map((c) => (
          <Link key={c.id} href={`/formador/cursos/${c.id}` as never}>
            <Card className="h-full transition hover:border-neutral-400 dark:hover:border-neutral-600">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-lg">{c.title}</CardTitle>
                  <CourseStatusBadge status={c.status} />
                </div>
                <p className="mt-1 text-xs text-neutral-500">slug: {c.slug}</p>
              </CardHeader>
              <CardContent>
                <p className="line-clamp-2 text-sm text-neutral-600 dark:text-neutral-400">
                  {c.description ?? 'Sin descripción.'}
                </p>
                <p className="mt-3 text-xs text-neutral-400">
                  Última actualización: {new Date(c.updatedAt).toLocaleString('es-ES')}
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {courses?.length === 0 ? (
        <p className="text-sm text-neutral-500">No tenés cursos todavía. Empezá creando uno.</p>
      ) : null}
    </section>
  );
}
