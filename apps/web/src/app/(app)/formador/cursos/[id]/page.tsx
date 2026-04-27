'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CourseEditor } from './course-editor';
import { InvitationsPanel } from './invitations-panel';
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
      <CourseEditor initial={course} onChange={reload} />
      <InvitationsPanel courseId={course.id} />
    </div>
  );
}
