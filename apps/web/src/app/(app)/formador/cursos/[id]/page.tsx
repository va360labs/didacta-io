'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CourseEditor } from './course-editor';
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
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  if (!course) return <p className="text-sm text-neutral-500">Cargando…</p>;
  return <CourseEditor initial={course} onChange={reload} />;
}
