'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CourseStatusBadge } from '@/components/course-status-badge';
import { Icon } from '@/components/icon';
import { NewCourseForm } from '@/components/new-course-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { ApiHttpError } from '@/lib/api-client';
import { coursesApi, type Course } from '@/lib/courses';

export default function FormadorCoursesPage() {
  const router = useRouter();
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    try {
      const data = await coursesApi.list();
      setCourses(data);
    } catch (e) {
      setError(
        e instanceof ApiHttpError
          ? e.message
          : 'No pudimos cargar tus cursos. Prueba refrescar la página.',
      );
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function handleCreated(course: Course) {
    setShowCreate(false);
    router.push(`/formador/cursos/${course.id}` as never);
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Mis cursos</h1>
          <p className="mt-1 text-text-muted">
            Cursos creados en tu organización: borradores, publicados y archivados.
          </p>
        </div>
        <Button type="button" onClick={() => setShowCreate(true)}>
          <Icon name="plus" size={16} />
          Crear curso nuevo
        </Button>
      </header>

      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title="Nuevo curso"
        description="El curso queda en estado borrador hasta que lo publiques. Tras crearlo te llevamos al builder para añadir secciones y lecciones."
        maxWidthClass="max-w-2xl"
      >
        <NewCourseForm onCreated={handleCreated} onCancel={() => setShowCreate(false)} />
      </Dialog>

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
            <div key={i} className="skeleton h-44 w-full" />
          ))}
        </div>
      ) : courses.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <div
              aria-hidden="true"
              className="grid h-20 w-20 place-items-center rounded-2xl"
              style={{
                background: 'var(--didacta-info-bg)',
                color: 'var(--didacta-info-fg)',
              }}
            >
              <Icon name="book" size={40} />
            </div>
            <h3 className="font-display text-2xl font-semibold">Aún no tienes cursos</h3>
            <p className="max-w-md text-text-muted">
              Empieza creando tu primer curso. Vas a poder añadir secciones, lecciones, quizzes y
              certificados después.
            </p>
            <Button type="button" onClick={() => setShowCreate(true)} className="mt-2">
              <Icon name="plus" size={16} />
              Crear mi primer curso
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          {courses.map((c) => (
            <Link
              key={c.id}
              href={`/formador/cursos/${c.id}` as never}
              className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              <Card interactive className="h-full overflow-hidden p-0">
                <div
                  className="relative flex items-center justify-between px-5 py-4 text-white"
                  style={{
                    background: 'linear-gradient(135deg, #0D1B2A 0%, #1E5AA8 100%)',
                  }}
                >
                  <div className="min-w-0">
                    <p className="label-uppercase text-white/60">{c.category ?? 'Sin categoría'}</p>
                    <h3
                      className="mt-1 line-clamp-2 font-display text-lg font-bold leading-tight text-white"
                      style={{ letterSpacing: '-0.01em' }}
                    >
                      {c.title}
                    </h3>
                  </div>
                  <CourseStatusBadge status={c.status} />
                </div>
                <CardContent className="space-y-3 p-5">
                  <p className="font-mono text-xs text-text-subtle">/{c.slug}</p>
                  <p className="line-clamp-2 text-sm leading-relaxed text-text-muted">
                    {c.description ?? 'Sin descripción todavía.'}
                  </p>
                  <div className="flex items-center justify-between border-t border-border-soft pt-3 text-xs text-text-subtle">
                    <span className="tabular-nums">
                      Actualizado{' '}
                      {new Date(c.updatedAt).toLocaleDateString('es-ES', {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </span>
                    <span className="inline-flex items-center gap-1 font-semibold text-brand-600">
                      Editar
                      <Icon name="arrow-right" size={14} />
                    </span>
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
