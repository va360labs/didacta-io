'use client';

import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { InvitationsPanel } from './invitations-panel';

// El editor de curso arrastra librerías pesadas (tiptap ~200KB + dnd-kit ~100KB).
// Lo cargamos bajo demanda (chunk aparte) para que la página pinte el esqueleto
// al instante y el editor llegue después, sin lastrar el bundle de la ruta.
const CourseEditor = dynamic(() => import('./course-editor').then((m) => m.CourseEditor), {
  ssr: false,
  loading: () => <div className="skeleton h-64 w-full" />,
});
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { ApiHttpError } from '@/lib/api-client';
import { coursesApi, type CourseDetail } from '@/lib/courses';

export default function CourseEditorPage() {
  const params = useParams<{ id: string }>();
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    if (!params?.id) return;
    try {
      setCourse(await coursesApi.get(params.id));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'Error al cargar el curso');
    }
  }

  useEffect(() => {
    void reload();
  }, [params?.id]);

  if (error)
    return (
      <div
        role="alert"
        className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
      >
        {error}
      </div>
    );

  if (!course)
    return (
      <div className="space-y-6">
        <div className="skeleton h-20 w-full" />
        <div className="skeleton h-48 w-full" />
        <div className="skeleton h-64 w-full" />
      </div>
    );

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button variant="secondary" asChild>
          <Link href={`/formador/cursos/${course.id}/alumnos` as never}>
            <Icon name="users" size={16} />
            Ver alumnos
          </Link>
        </Button>
      </div>
      <CourseEditor initial={course} onChange={reload} />
      <InvitationsPanel courseId={course.id} />
    </div>
  );
}
