'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import { assessmentsApi, type AttemptSummary } from '@/modules/assessments';

interface PendingAttempt extends AttemptSummary {
  quiz: { id: string; title: string; lessonId: string | null };
  answers: { id: string; questionId: string }[];
}

export default function CorreccionesPage() {
  const t = useTranslations('formadorAula');
  const tErrors = useTranslations('errors');
  const [pending, setPending] = useState<PendingAttempt[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function formatRelative(iso: string): string {
    try {
      const d = new Date(iso);
      const now = Date.now();
      const diffMs = now - d.getTime();
      const days = Math.floor(diffMs / 86_400_000);
      if (days < 1) return t('correcciones.today');
      if (days === 1) return t('correcciones.yesterday');
      if (days < 7) return t('correcciones.daysAgo', { days });
      return formatDate(d, { day: '2-digit', month: 'short' });
    } catch {
      return iso;
    }
  }

  async function reload() {
    try {
      setPending(await assessmentsApi.listPendingReview());
      setError(null);
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('correcciones.loadError'),
      );
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight">
          {t('correcciones.title')}
        </h1>
        <p className="mt-1 max-w-3xl text-text-muted">{t('correcciones.intro')}</p>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {pending === null ? (
        <div className="space-y-3">
          <div className="skeleton h-20 w-full" />
          <div className="skeleton h-20 w-full" />
        </div>
      ) : pending.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <div
              aria-hidden="true"
              className="grid h-20 w-20 place-items-center rounded-2xl"
              style={{
                background: 'var(--didacta-success-bg)',
                color: 'var(--didacta-success-fg)',
              }}
            >
              <Icon name="check" size={36} />
            </div>
            <h3 className="font-display text-xl font-semibold">{t('correcciones.emptyTitle')}</h3>
            <p className="max-w-md text-text-muted">{t('correcciones.emptyHint')}</p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {pending.map((p) => (
            <li key={p.id}>
              <Link
                href={`/formador/correcciones/${p.id}`}
                className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                <Card interactive>
                  <CardContent className="flex flex-wrap items-start justify-between gap-3 p-5">
                    <div className="min-w-0 flex-1 space-y-1">
                      <h3 className="font-display text-lg font-semibold text-text">
                        {p.quiz.title}
                      </h3>
                      <p className="text-sm text-text-muted">
                        {t('correcciones.answersToGrade', { count: p.answers.length })}
                      </p>
                      <p className="text-xs text-text-subtle tabular-nums">
                        {t('correcciones.sentAt', {
                          when: p.submittedAt
                            ? formatRelative(p.submittedAt)
                            : t('correcciones.unknownTime'),
                        })}
                      </p>
                    </div>
                    <Badge variant="warning">{t('correcciones.pendingBadge')}</Badge>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
