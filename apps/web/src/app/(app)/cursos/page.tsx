'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CourseCard, type CourseCardData } from '@/components/course-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { coursesApi, type Course } from '@/lib/courses';
import { learningApi, type Enrollment } from '@/lib/learning';

interface EnrollmentInfo {
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  progressPercent: number;
}

export default function CatalogPage() {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [enrollments, setEnrollments] = useState<Map<string, EnrollmentInfo>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    void Promise.all([
      coursesApi.list({ status: 'PUBLISHED' }),
      learningApi.listMine().catch((): Enrollment[] => []),
    ])
      .then(([list, mine]) => {
        if (aborted) return;
        setCourses(list);
        setEnrollments(
          new Map(
            mine.map((e: Enrollment) => [
              e.courseId,
              { status: e.status, progressPercent: e.progressPercent },
            ]),
          ),
        );
      })
      .catch((e) => {
        if (aborted) return;
        setError(
          e instanceof ApiHttpError
            ? e.message
            : 'No pudimos cargar el catálogo. Probá refrescar la página.',
        );
      });
    return () => {
      aborted = true;
    };
  }, []);

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
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <div key={i} className="skeleton h-64 w-full" />
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
