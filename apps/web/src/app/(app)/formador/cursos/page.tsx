'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CourseStatusBadge } from '@/components/course-status-badge';
import { Icon } from '@/components/icon';
import { NewCourseForm } from '@/components/new-course-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import { coursesApi, type Course } from '@/lib/courses';

export default function FormadorCoursesPage() {
  const t = useTranslations('formadorCursos');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    try {
      const data = await coursesApi.list();
      setCourses(data);
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorLoadCourses'));
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
          <h1 className="font-display text-2xl font-bold tracking-tight">{t('myCoursesTitle')}</h1>
          <p className="mt-1 text-text-muted">{t('myCoursesSubtitle')}</p>
        </div>
        <Button type="button" onClick={() => setShowCreate(true)}>
          <Icon name="plus" size={16} />
          {t('createCourse')}
        </Button>
      </header>

      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title={t('newCourseTitle')}
        description={t('newCourseDialogDescription')}
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
            <h3 className="font-display text-2xl font-semibold">{t('noCoursesTitle')}</h3>
            <p className="max-w-md text-text-muted">{t('noCoursesBody')}</p>
            <Button type="button" onClick={() => setShowCreate(true)} className="mt-2">
              <Icon name="plus" size={16} />
              {t('createFirstCourse')}
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
                    <p className="label-uppercase text-white/60">{c.category ?? t('noCategory')}</p>
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
                    {c.description ?? t('noDescription')}
                  </p>
                  <div className="flex items-center justify-between border-t border-border-soft pt-3 text-xs text-text-subtle">
                    <span className="tabular-nums">
                      {t('updatedAt', {
                        date: formatDate(c.updatedAt, {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                        }),
                      })}
                    </span>
                    <span className="inline-flex items-center gap-1 font-semibold text-brand-600">
                      {t('edit')}
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
