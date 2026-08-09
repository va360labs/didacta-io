'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { labelOr } from '@/lib/i18n/labels';
import {
  listPathsFormador,
  publishPath,
  archivePath,
  restorePath,
  type LearningPath,
  type LearningPathStatus,
} from '@/lib/learning-paths';

const STATUS_COLORS: Record<LearningPathStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  PUBLISHED: 'bg-green-100 text-green-700',
  ARCHIVED: 'bg-amber-100 text-amber-700',
};

export default function FormadorRutasPage() {
  const t = useTranslations('formadorAula');
  const [paths, setPaths] = useState<LearningPath[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<LearningPathStatus | 'TODAS'>('TODAS');
  const [actionId, setActionId] = useState<string | null>(null);

  useEffect(() => {
    listPathsFormador()
      .then(setPaths)
      .finally(() => setLoading(false));
  }, []);

  async function handlePublish(path: LearningPath) {
    setActionId(path.id);
    try {
      const updated = await publishPath(path.id);
      setPaths((prev) =>
        prev.map((p) => (p.id === updated.id ? { ...p, status: updated.status } : p)),
      );
    } finally {
      setActionId(null);
    }
  }

  async function handleArchive(path: LearningPath) {
    if (!confirm(t('rutas.confirmArchive', { title: path.title }))) return;
    setActionId(path.id);
    try {
      const updated = await archivePath(path.id);
      setPaths((prev) =>
        prev.map((p) => (p.id === updated.id ? { ...p, status: updated.status } : p)),
      );
    } finally {
      setActionId(null);
    }
  }

  async function handleRestore(path: LearningPath) {
    setActionId(path.id);
    try {
      const updated = await restorePath(path.id);
      setPaths((prev) =>
        prev.map((p) => (p.id === updated.id ? { ...p, status: updated.status } : p)),
      );
    } finally {
      setActionId(null);
    }
  }

  const filtered = filter === 'TODAS' ? paths : paths.filter((p) => p.status === filter);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-text">{t('rutas.title')}</h1>
          <p className="mt-1 text-sm text-text-muted">{t('rutas.subtitle')}</p>
        </div>
        <Link
          href="/formador/rutas/nueva"
          className="rounded-lg bg-(--didacta-trust) px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          {t('rutas.newPath')}
        </Link>
      </div>

      <div className="flex gap-2">
        {(['TODAS', 'DRAFT', 'PUBLISHED', 'ARCHIVED'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              filter === s
                ? 'border-(--didacta-trust) bg-(--didacta-trust) text-white'
                : 'border-border text-text-muted hover:text-text'
            }`}
          >
            {s === 'TODAS' ? t('rutas.filterAll') : t(`rutaStatus.${s}`)}
          </button>
        ))}
      </div>

      {loading && (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-xl border border-border bg-surface"
            />
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="rounded-xl border border-border bg-surface p-10 text-center">
          <p className="text-text-muted">{t('rutas.emptyState')}</p>
          <Link
            href="/formador/rutas/nueva"
            className="mt-3 inline-block text-sm font-medium text-(--didacta-trust) hover:underline"
          >
            {t('rutas.createFirst')}
          </Link>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-background">
                <th className="px-4 py-3 text-left font-medium text-text-muted">
                  {t('rutas.colTitle')}
                </th>
                <th className="px-4 py-3 text-left font-medium text-text-muted">
                  {t('rutas.colStatus')}
                </th>
                <th className="px-4 py-3 text-left font-medium text-text-muted">
                  {t('rutas.colCourses')}
                </th>
                <th className="px-4 py-3 text-left font-medium text-text-muted">
                  {t('rutas.colEnrolled')}
                </th>
                <th className="px-4 py-3 text-right font-medium text-text-muted">
                  {t('rutas.colActions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((path) => {
                const busy = actionId === path.id;
                return (
                  <tr key={path.id} className="hover:bg-background/50">
                    <td className="px-4 py-3 font-medium text-text">
                      <Link href={`/formador/rutas/${path.id}`} className="hover:underline">
                        {path.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_COLORS[path.status]}`}
                      >
                        {labelOr(t, `rutaStatus.${path.status}`, path.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-text-muted">{path.courseCount}</td>
                    <td className="px-4 py-3 text-text-muted">—</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <Link
                          href={`/formador/rutas/${path.id}`}
                          className="rounded-md border border-border px-3 py-1 text-xs hover:bg-background"
                        >
                          {t('rutas.edit')}
                        </Link>
                        {path.status !== 'ARCHIVED' && (
                          <button
                            onClick={() => handlePublish(path)}
                            disabled={busy}
                            className="rounded-md border border-border px-3 py-1 text-xs hover:bg-background disabled:opacity-50"
                          >
                            {path.status === 'PUBLISHED'
                              ? t('rutas.unpublish')
                              : t('rutas.publish')}
                          </button>
                        )}
                        {path.status !== 'ARCHIVED' ? (
                          <button
                            onClick={() => handleArchive(path)}
                            disabled={busy}
                            className="rounded-md border border-border px-3 py-1 text-xs text-amber-600 hover:bg-amber-50 disabled:opacity-50"
                          >
                            {t('rutas.archive')}
                          </button>
                        ) : (
                          <button
                            onClick={() => handleRestore(path)}
                            disabled={busy}
                            className="rounded-md border border-border px-3 py-1 text-xs hover:bg-background disabled:opacity-50"
                          >
                            {t('rutas.restore')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
