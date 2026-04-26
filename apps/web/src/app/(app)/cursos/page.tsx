'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
        if (!aborted) {
          setError(
            e instanceof ApiHttpError
              ? e.message
              : 'No pudimos cargar el catálogo. Probá refrescar la página.',
          );
        }
      });
    return () => {
      aborted = true;
    };
  }, []);

  return (
    <section className="space-y-8">
      <header>
        <h1 className="font-display text-4xl font-extrabold tracking-tight text-text">
          Catálogo de cursos
        </h1>
        <p className="mt-2 max-w-2xl text-text-muted">
          Explorá los cursos publicados de tu organización. Hacé clic en uno para ver el detalle y
          matricularte.
        </p>
      </header>

      {error ? (
        <Card>
          <CardContent className="p-6">
            <p className="text-danger-700">{error}</p>
          </CardContent>
        </Card>
      ) : courses === null ? (
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skeleton h-56 w-full" />
          ))}
        </div>
      ) : courses.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <h3 className="font-display text-2xl font-semibold">Aún no hay cursos publicados</h3>
            <p className="max-w-md text-text-muted">
              Cuando un formador publique el primer curso, aparecerá acá. Si sos formador, podés
              empezar a crear uno.
            </p>
            <Button asChild className="mt-2">
              <Link href="/formador/cursos/nuevo">Crear un curso</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {courses.map((c) => (
            <Link
              key={c.id}
              href={`/cursos/${c.slug}` as never}
              className="group block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              <Card interactive className="flex h-full flex-col overflow-hidden">
                {/* Thumbnail / cover */}
                {c.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={c.thumbnailUrl}
                    alt=""
                    className="h-40 w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div
                    className="flex h-40 items-center justify-center text-text-on-brand"
                    style={{
                      background: `linear-gradient(135deg, hsl(var(--brand-h) 70% 45%), hsl(var(--brand-h) 78% 22%))`,
                    }}
                  >
                    <span className="font-display text-3xl font-extrabold opacity-30">
                      {c.title.charAt(0).toUpperCase()}
                    </span>
                  </div>
                )}

                <CardContent className="flex flex-1 flex-col gap-3 p-5">
                  {c.category ? (
                    <Badge variant="primary" className="w-fit">
                      {c.category}
                    </Badge>
                  ) : null}

                  <h3 className="font-display text-lg font-semibold leading-tight text-text group-hover:text-brand-700">
                    {c.title}
                  </h3>

                  <p className="line-clamp-3 text-sm text-text-muted leading-relaxed">
                    {c.description ?? 'Sin descripción.'}
                  </p>

                  <div className="mt-auto flex items-center gap-3 text-xs text-text-subtle">
                    {c.estimatedMinutes ? (
                      <span className="tabular-nums">≈ {c.estimatedMinutes} min</span>
                    ) : null}
                    {c.language ? (
                      <span className="label-uppercase tracking-wider">{c.language}</span>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
