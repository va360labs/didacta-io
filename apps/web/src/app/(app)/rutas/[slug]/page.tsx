'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  getPath,
  enrollPath,
  cancelEnrollment,
  type LearningPathDetail,
} from '@/lib/learning-paths';

export default function RutaDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const t = useTranslations('alumnoAprendizaje');

  const [path, setPath] = useState<LearningPathDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  useEffect(() => {
    getPath(slug)
      .then(setPath)
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [slug]);

  async function handleEnroll() {
    if (!path) return;
    setEnrolling(true);
    try {
      const enrollment = await enrollPath(path.id);
      setPath((prev) =>
        prev
          ? {
              ...prev,
              enrollment: {
                status: enrollment.status,
                progressPercent: enrollment.progressPercent,
              },
            }
          : prev,
      );
    } finally {
      setEnrolling(false);
    }
  }

  async function handleCancel() {
    if (!path) return;
    setCancelling(true);
    try {
      await cancelEnrollment(path.id);
      setPath((prev) => (prev ? { ...prev, enrollment: null } : prev));
      setShowCancelConfirm(false);
    } finally {
      setCancelling(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-64 animate-pulse rounded bg-border" />
        <div className="h-4 w-96 animate-pulse rounded bg-border" />
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-xl border border-border bg-surface"
            />
          ))}
        </div>
      </div>
    );
  }

  if (notFound || !path) {
    return (
      <div className="flex flex-col items-center gap-4 py-20">
        <p className="text-text-muted">{t('pathNotFound')}</p>
        <Link href="/rutas" className="text-sm font-medium text-(--didacta-trust) hover:underline">
          {t('backToPaths')}
        </Link>
      </div>
    );
  }

  const enrolled = path.enrollment;
  const courses = path.courses ?? [];
  const progress = enrolled?.progressPercent ?? 0;
  const isCompleted = enrolled?.status === 'COMPLETED';
  const isArchived = path.status === 'ARCHIVED';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/rutas"
            className="mb-2 flex items-center gap-1 text-xs text-text-muted hover:text-text"
          >
            {t('backToPathsBreadcrumb')}
          </Link>
          <h1 className="font-display text-2xl font-bold text-text">{path.title}</h1>
          {path.description && <p className="mt-1 text-sm text-text-muted">{path.description}</p>}
          <div className="mt-2 flex items-center gap-4 text-xs text-text-muted">
            <span>{t('courseCount', { count: path.courseCount })}</span>
            {path.estimatedMinutes && (
              <span>{t('hoursEstimated', { hours: Math.round(path.estimatedMinutes / 60) })}</span>
            )}
            <span className="capitalize">
              {path.sequenceType === 'LINEAR' ? t('sequential') : t('flexible')}
            </span>
          </div>
        </div>

        <div className="shrink-0 flex flex-col items-end gap-2">
          {isArchived ? (
            <span className="rounded-lg border border-border px-4 py-2 text-sm text-text-muted">
              {t('pathArchived')}
            </span>
          ) : isCompleted ? (
            <span className="rounded-lg bg-green-100 px-4 py-2 text-sm font-semibold text-green-700">
              {t('pathCompletedFull')}
            </span>
          ) : enrolled ? (
            <>
              {path.nextStep && (
                <Link
                  href={path.nextStep.courseUrl}
                  className="rounded-lg bg-(--didacta-trust) px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
                >
                  {t('continue')}
                </Link>
              )}
              <button
                onClick={() => setShowCancelConfirm(true)}
                className="text-xs text-text-muted hover:text-red-500"
              >
                {t('abandonPath')}
              </button>
            </>
          ) : (
            <button
              onClick={handleEnroll}
              disabled={enrolling}
              className="rounded-lg bg-(--didacta-trust) px-5 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {enrolling ? t('enrolling') : t('enrollPath')}
            </button>
          )}
        </div>
      </div>

      {isArchived && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {t('pathArchivedNotice')}
        </div>
      )}

      {enrolled && !isCompleted && (
        <div className="rounded-xl border border-border bg-surface p-4">
          <div className="mb-2 flex justify-between text-sm">
            <span className="font-medium text-text">{t('yourProgress')}</span>
            <span className="text-text-muted">{progress}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-(--didacta-trust) transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-muted">
          {t('pathCourses')}
        </h2>
        {courses.length === 0 ? (
          <p className="text-sm text-text-muted">{t('pathNoCourses')}</p>
        ) : (
          <div className="space-y-3">
            {courses.map((c, idx) => {
              const isLinearBlocked =
                path.sequenceType === 'LINEAR' &&
                idx > 0 &&
                progress < idx * (100 / path.courseCount);
              return (
                <div
                  key={c.id}
                  className={`flex items-center gap-4 rounded-xl border border-border bg-surface p-4 ${isLinearBlocked ? 'opacity-50' : ''}`}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border text-sm font-semibold text-text-muted">
                    {idx + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text">
                      {t('courseNumber', { number: idx + 1 })}
                    </p>
                    <p className="text-xs text-text-muted">{c.courseId}</p>
                  </div>
                  {isLinearBlocked && (
                    <span className="text-xs text-text-muted">{t('lockedChip')}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showCancelConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-xl">
            <h3 className="font-semibold text-text">{t('abandonConfirmTitle')}</h3>
            <p className="mt-2 text-sm text-text-muted">{t('abandonConfirmBody')}</p>
            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setShowCancelConfirm(false)}
                className="flex-1 rounded-lg border border-border px-4 py-2 text-sm font-medium text-text"
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="flex-1 rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {cancelling ? t('abandoning') : t('abandonYes')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
