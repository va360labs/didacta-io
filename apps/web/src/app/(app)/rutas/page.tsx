'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  listPaths,
  listMyPaths,
  type LearningPath,
  type LearningPathWithEnrolledAt,
} from '@/lib/learning-paths';

type Tab = 'todas' | 'mis-rutas';

function PathCard({ path, href }: { path: LearningPath; href: string }) {
  const t = useTranslations('alumnoAprendizaje');
  const enrolled = path.enrollment;
  const progress = enrolled?.progressPercent ?? 0;
  const isCompleted = enrolled?.status === 'COMPLETED';

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-text">{path.title}</h2>
            {isCompleted && (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">
                {t('pathCompleted')}
              </span>
            )}
          </div>
          {path.description && (
            <p className="mt-1 line-clamp-2 text-sm text-text-muted">{path.description}</p>
          )}
          <div className="mt-2 flex items-center gap-4 text-xs text-text-muted">
            <span>{t('courseCount', { count: path.courseCount })}</span>
            {path.estimatedMinutes && (
              <span>{t('hoursApprox', { hours: Math.round(path.estimatedMinutes / 60) })}</span>
            )}
          </div>
        </div>
        {!isCompleted && (
          <Link
            href={href}
            className="shrink-0 rounded-lg border border-(--didacta-trust) px-4 py-2 text-sm font-semibold text-(--didacta-trust) hover:bg-(--didacta-trust)/10"
          >
            {enrolled ? t('continue') : t('viewPath')}
          </Link>
        )}
      </div>
      {enrolled && progress > 0 && (
        <div className="mt-3 border-t border-border pt-3">
          <div className="mb-1 flex justify-between text-xs text-text-muted">
            <span>{t('progress')}</span>
            <span>{progress}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-(--didacta-trust)"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default function RutasPage() {
  const t = useTranslations('alumnoAprendizaje');
  const [tab, setTab] = useState<Tab>('todas');
  const [paths, setPaths] = useState<LearningPath[]>([]);
  const [myPaths, setMyPaths] = useState<LearningPathWithEnrolledAt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listPaths(), listMyPaths()])
      .then(([all, mine]) => {
        setPaths(all);
        setMyPaths(mine);
      })
      .catch(() => setError(t('pathsLoadError')))
      .finally(() => setLoading(false));
    // Deps vacías: es la carga inicial. `t` solo compone el mensaje de error.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const displayPaths = tab === 'mis-rutas' ? myPaths : paths;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-text">{t('pathsTitle')}</h1>
        <p className="mt-1 text-sm text-text-muted">{t('pathsSubtitle')}</p>
      </div>

      <div className="flex gap-1 rounded-lg border border-border bg-surface p-1 w-fit">
        {(['todas', 'mis-rutas'] as const).map((tabId) => (
          <button
            key={tabId}
            onClick={() => setTab(tabId)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === tabId ? 'bg-(--didacta-trust) text-white' : 'text-text-muted hover:text-text'
            }`}
          >
            {tabId === 'todas' ? t('allPaths') : t('myPaths')}
          </button>
        ))}
      </div>

      {loading && (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-xl border border-border bg-surface"
            />
          ))}
        </div>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}

      {!loading && !error && displayPaths.length === 0 && (
        <div className="rounded-xl border border-border bg-surface p-10 text-center">
          <p className="text-text-muted">
            {tab === 'mis-rutas' ? t('myPathsEmpty') : t('pathsEmpty')}
          </p>
          {tab === 'mis-rutas' && (
            <button
              onClick={() => setTab('todas')}
              className="mt-3 text-sm font-medium text-(--didacta-trust) hover:underline"
            >
              {t('explorePaths')}
            </button>
          )}
        </div>
      )}

      {!loading && !error && displayPaths.length > 0 && (
        <div className="space-y-4">
          {displayPaths.map((path) => (
            <PathCard key={path.id} path={path} href={`/rutas/${path.slug}`} />
          ))}
        </div>
      )}
    </div>
  );
}
