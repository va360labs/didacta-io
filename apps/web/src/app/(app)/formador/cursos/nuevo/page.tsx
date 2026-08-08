'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { NewCourseForm } from '@/components/new-course-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { Course } from '@/lib/courses';

/**
 * Página standalone de creación de curso. Mantenida como deep-link
 * (compartible, bookmarkable). El flujo principal desde /formador/cursos
 * usa un Dialog modal con el mismo `<NewCourseForm>`.
 */
export default function NuevoCursoPage() {
  const t = useTranslations('formadorCursos');
  const router = useRouter();

  function handleCreated(course: Course) {
    router.push(`/formador/cursos/${course.id}` as never);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Button asChild variant="ghost" className="self-start">
        <Link href="/formador/cursos">{t('backToMyCourses')}</Link>
      </Button>

      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg"
              style={{
                background: 'var(--didacta-info-bg)',
                color: 'var(--didacta-info-fg)',
              }}
            >
              <Icon name="book" size={20} />
            </span>
            <div className="min-w-0">
              <CardTitle>{t('newCourseTitle')}</CardTitle>
              <CardDescription>{t('newCoursePageDescription')}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <NewCourseForm
            onCreated={handleCreated}
            onCancel={() => router.push('/formador/cursos')}
          />
        </CardContent>
      </Card>
    </div>
  );
}
