'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { StatCard } from '@/components/stat-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import {
  learningApi,
  type EnrollmentProgressDetail,
  type StudentLessonProgress,
  type StudentProgressModule,
} from '@/lib/learning';

type ProgressStatus = EnrollmentProgressDetail['status'];

// Labels de estado en el catálogo `formadorCursos.enrollStatus.*`.
const STATUS_VARIANT: Record<ProgressStatus, 'success' | 'warning' | 'muted'> = {
  ACTIVE: 'warning',
  COMPLETED: 'success',
  CANCELLED: 'muted',
  PAUSED: 'muted',
};

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  return formatDate(iso, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Formatea segundos vistos a un texto compacto: '2h 5m' / '5m 12s' / '0s'. */
function formatWatch(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Estado visual de una lección a partir de su progreso (label vía catálogo). */
function lessonStatus(lesson: StudentLessonProgress): {
  key: 'completed' | 'inProgress' | 'notStarted';
  variant: 'success' | 'warning' | 'muted';
} {
  if (lesson.completed) return { key: 'completed', variant: 'success' };
  if (lesson.watchedSeconds > 0) return { key: 'inProgress', variant: 'warning' };
  return { key: 'notStarted', variant: 'muted' };
}

/** Escapa un valor para una celda CSV. */
function csvEscape(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

/** CSV con el detalle por lección (lessonTitle, type, watchedSeconds, completed, completedAt). */
function progressToCsv(detail: EnrollmentProgressDetail): string {
  const header = ['lesson_title', 'type', 'watched_seconds', 'completed', 'completed_at'];
  const lines: string[] = [];
  for (const mod of detail.modules) {
    for (const lesson of mod.lessons) {
      lines.push(
        [
          lesson.lessonTitle,
          lesson.type,
          lesson.watchedSeconds,
          lesson.completed,
          lesson.completedAt,
        ]
          .map(csvEscape)
          .join(','),
      );
    }
  }
  return [header.join(','), ...lines].join('\n');
}

export default function AlumnoProgresoPage() {
  const t = useTranslations('formadorCursos');
  const tErrors = useTranslations('errors');
  const params = useParams<{ id: string; enrollmentId: string }>();
  const courseId = params?.id;
  const enrollmentId = params?.enrollmentId;
  const [detail, setDetail] = useState<EnrollmentProgressDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!courseId || !enrollmentId) return;
    let cancelled = false;
    (async () => {
      try {
        setError(null);
        const data = await learningApi.getEnrollmentProgressDetail(courseId, enrollmentId);
        if (!cancelled) setDetail(data);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorLoadProgress'),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [courseId, enrollmentId]);

  function handleExport() {
    if (!detail) return;
    const csv = progressToCsv(detail);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `progreso-${enrollmentId}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const displayName =
    detail?.userName ?? detail?.userEmail ?? (detail ? detail.userId.slice(0, 8) : '');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" asChild className="self-start">
          <Link href={`/formador/cursos/${courseId}/alumnos` as never}>{t('back')}</Link>
        </Button>
      </div>

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl font-bold tracking-tight">
              {detail ? displayName : t('progressTitle')}
            </h1>
            {detail ? (
              <Badge variant={STATUS_VARIANT[detail.status]}>
                {t(`enrollStatus.${detail.status}`)}
              </Badge>
            ) : null}
          </div>
          {detail?.userName && detail.userEmail ? (
            <p className="mt-1 text-text-muted">{detail.userEmail}</p>
          ) : (
            <p className="mt-1 text-text-muted">{t('progressSubtitle')}</p>
          )}
        </div>
        <Button variant="secondary" onClick={handleExport} disabled={!detail}>
          {t('exportCsv')}
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

      {!detail && !error ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="skeleton h-24 w-full" />
            <div className="skeleton h-24 w-full" />
            <div className="skeleton h-24 w-full" />
          </div>
          <div className="space-y-2">
            <div className="skeleton h-12 w-full" />
            <div className="skeleton h-12 w-full" />
            <div className="skeleton h-12 w-full" />
          </div>
        </>
      ) : null}

      {detail ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label={t('statWatchTotal')} value={formatWatch(detail.totalWatchedSeconds)} />
            <StatCard
              label={t('statLessonsCompleted')}
              value={`${detail.lessonsCompleted}/${detail.lessonsTotal}`}
            />
            <StatCard label={t('statProgress')} value={`${detail.progressPercent}%`} />
          </div>

          {detail.modules.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
                <h3 className="font-display text-xl font-semibold">{t('noLessonsTitle')}</h3>
                <p className="max-w-md text-text-muted">{t('noLessonsBody')}</p>
              </CardContent>
            </Card>
          ) : (
            detail.modules.map((mod: StudentProgressModule) => (
              <Card key={mod.moduleId}>
                <CardHeader>
                  <CardTitle className="text-base">{mod.moduleTitle}</CardTitle>
                  <CardDescription>
                    {t('lessonsWithCount', { count: mod.lessons.length })}
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-y border-border bg-surface-2 text-left text-xs uppercase tracking-wide text-text-muted">
                          <th className="px-6 py-3">{t('colLesson')}</th>
                          <th className="px-3 py-3">{t('colWatch')}</th>
                          <th className="px-3 py-3">{t('colStatus')}</th>
                          <th className="px-6 py-3 text-right">{t('colLastActivity')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mod.lessons.map((lesson) => {
                          const st = lessonStatus(lesson);
                          return (
                            <tr
                              key={lesson.lessonId}
                              className="border-b border-border last:border-0 hover:bg-surface-2"
                            >
                              <td className="px-6 py-3">
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold text-text">
                                    {lesson.lessonTitle}
                                  </span>
                                  <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                                    {lesson.type}
                                  </span>
                                </div>
                              </td>
                              <td className="px-3 py-3 text-xs tabular-nums text-text-muted">
                                {formatWatch(lesson.watchedSeconds)}
                                {lesson.durationMinutes !== null ? (
                                  <span className="text-text-subtle">
                                    {' '}
                                    {t('watchOfDuration', { minutes: lesson.durationMinutes })}
                                  </span>
                                ) : null}
                              </td>
                              <td className="px-3 py-3">
                                <Badge variant={st.variant}>{t(`lessonState.${st.key}`)}</Badge>
                              </td>
                              <td className="px-6 py-3 text-right text-xs tabular-nums text-text-muted">
                                {shortDate(lesson.lastAccessedAt)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </>
      ) : null}
    </div>
  );
}
