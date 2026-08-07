'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { StatCard } from '@/components/stat-card';
import { Card, CardContent } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formadorStatsApi, type FormadorStats } from '@/lib/formador-stats';

export default function FormadorDashboardPage() {
  const t = useTranslations('formadorAula');
  const tErrors = useTranslations('errors');
  const [stats, setStats] = useState<FormadorStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setStats(await formadorStatsApi.get());
        setError(null);
      } catch (e) {
        setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('panel.loadError'));
      }
    })();
  }, []);

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-danger-100 bg-danger-50 p-4 text-sm text-danger-700"
      >
        {error}
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-12 w-64" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-32 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <section className="space-y-8">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight">{t('panel.title')}</h1>
        <p className="mt-1 text-text-muted">{t('panel.intro')}</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t('panel.coursesPublished')}
          value={stats.coursesPublished}
          hint={t('panel.coursesDraftHint', { count: stats.coursesDraft })}
          icon="book"
          tone="info"
          href="/formador/cursos"
        />
        <StatCard
          label={t('panel.activeEnrollments')}
          value={stats.totalActiveEnrollments}
          hint={t('panel.completedEnrollmentsHint', { count: stats.totalCompletedEnrollments })}
          icon="users"
          tone="info"
        />
        <StatCard
          label={t('panel.averageProgress')}
          value={`${stats.averageProgressPercent}%`}
          hint={t('panel.averageProgressHint')}
          icon="trending"
          tone="success"
        />
        <StatCard
          label={t('panel.pendingGradings')}
          value={stats.pendingGradings}
          hint={
            stats.pendingGradings > 0 ? t('panel.pendingGradingsHint') : t('panel.upToDateHint')
          }
          icon="check"
          tone={stats.pendingGradings > 0 ? 'warn' : 'success'}
          href="/formador/correcciones"
          highlight={stats.pendingGradings > 0}
        />
      </div>

      <Card>
        <CardContent className="p-6">
          <h2 className="font-display text-lg font-semibold mb-4">{t('panel.shortcuts')}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <ShortcutLink
              href="/formador/cursos"
              label={t('panel.myCourses')}
              hint={t('panel.myCoursesHint')}
            />
            <ShortcutLink
              href="/formador/correcciones"
              label={t('panel.pendingGradings')}
              hint={t('panel.pendingShortcutHint')}
              highlight={stats.pendingGradings > 0}
            />
            <ShortcutLink
              href="/formador/cursos/nuevo"
              label={t('panel.newCourse')}
              hint={t('panel.newCourseHint')}
            />
            <ShortcutLink
              href="/cursos"
              label={t('panel.publicCatalog')}
              hint={t('panel.publicCatalogHint')}
            />
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function ShortcutLink({
  href,
  label,
  hint,
  highlight,
}: {
  href: string;
  label: string;
  hint: string;
  highlight?: boolean;
}): ReactNode {
  return (
    <Link
      href={href as never}
      className={
        highlight
          ? 'flex items-start gap-3 rounded-lg border border-warning-200 bg-warning-50/40 p-4 transition-colors hover:bg-warning-50'
          : 'flex items-start gap-3 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong hover:bg-surface-2'
      }
    >
      <span className="text-brand-500 text-lg" aria-hidden="true">
        →
      </span>
      <div className="flex-1">
        <p className="font-semibold text-text">{label}</p>
        <p className="mt-0.5 text-xs text-text-muted">{hint}</p>
      </div>
    </Link>
  );
}
