'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/stat-card';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import { surveysAdminApi, type SurveyListItem, type SurveyResults } from '@/modules/surveys';

/// Panel admin de mod.surveys (bloque 2): listado de encuestas con nº de
/// respuestas y resultados agregados (NPS, medias, respuestas libres). Las
/// respuestas son anónimas: aquí solo se ven agregados y textos sin autor.

function dateLabel(iso: string): string {
  return formatDate(iso, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function AdminEncuestasPage() {
  const t = useTranslations('adminEngagement');
  const tErrors = useTranslations('errors');
  const [surveys, setSurveys] = useState<SurveyListItem[] | null>(null);
  const [selected, setSelected] = useState<SurveyResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const { surveys: list } = await surveysAdminApi.list();
    setSurveys(list);
  }, []);

  useEffect(() => {
    reload().catch((e) => {
      setError(apiErrorMessage(e, tErrors));
    });
  }, [reload, tErrors]);

  async function openResults(id: string) {
    setBusy(true);
    setError(null);
    try {
      setSelected(await surveysAdminApi.results(id));
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  async function closeSurvey(id: string) {
    setBusy(true);
    setError(null);
    try {
      await surveysAdminApi.close(id);
      await reload();
      if (selected?.id === id) await openResults(id);
    } catch (e) {
      setError(apiErrorMessage(e, tErrors));
    } finally {
      setBusy(false);
    }
  }

  if (surveys === null) {
    return (
      <div className="mx-auto max-w-5xl space-y-2">
        <div className="skeleton h-40 w-full" />
        <div className="skeleton h-40 w-full" />
      </div>
    );
  }

  const npsQuestion = selected?.questions.find((q) => q.nps !== null);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-text">{t('surveys.title')}</h1>
        <p className="mt-1 text-sm text-text-muted">{t('surveys.subtitle')}</p>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      <Card data-testid="surveys-list-card">
        <CardHeader>
          <CardTitle>{t('surveys.listTitle')}</CardTitle>
          <CardDescription>{t('surveys.listDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {surveys.length === 0 ? (
            <p className="text-sm text-text-subtle">{t('surveys.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border-soft text-left text-xs text-text-subtle">
                    <th className="py-2 pr-3">{t('surveys.thSurvey')}</th>
                    <th className="py-2 pr-3">{t('surveys.thDate')}</th>
                    <th className="py-2 pr-3">{t('surveys.thStatus')}</th>
                    <th className="py-2 pr-3">{t('surveys.thResponses')}</th>
                    <th className="py-2 pr-3" />
                  </tr>
                </thead>
                <tbody>
                  {surveys.map((s) => (
                    <tr key={s.id} className="border-b border-border-soft">
                      <td className="py-2 pr-3 font-medium text-text">{s.title}</td>
                      <td className="py-2 pr-3 text-text-muted">{dateLabel(s.createdAt)}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={s.status === 'OPEN' ? 'success' : 'muted'}>
                          {s.status === 'OPEN'
                            ? t('surveys.statusOpen')
                            : t('surveys.statusClosed')}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 text-text">{s.responseCount}</td>
                      <td className="py-2 pr-3">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void openResults(s.id)}
                          >
                            {t('surveys.results')}
                          </Button>
                          {s.status === 'OPEN' ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void closeSurvey(s.id)}
                            >
                              {t('surveys.close')}
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {selected ? (
        <Card data-testid="survey-results-card">
          <CardHeader>
            <CardTitle>{selected.title}</CardTitle>
            <CardDescription>
              {t('surveys.responseCount', { count: selected.responseCount })} ·{' '}
              {dateLabel(selected.createdAt)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <StatCard
                label={t('surveys.npsLabel')}
                value={npsQuestion?.nps ? npsQuestion.nps.score : '—'}
                hint={t('surveys.npsHint')}
                icon="chart"
                tone={
                  npsQuestion?.nps && npsQuestion.nps.score >= 30
                    ? 'success'
                    : npsQuestion?.nps && npsQuestion.nps.score < 0
                      ? 'warn'
                      : 'info'
                }
              />
              <StatCard
                label={t('surveys.responsesLabel')}
                value={selected.responseCount}
                hint={t('surveys.responsesHint')}
                icon="users"
                tone="info"
              />
              <StatCard
                label={t('surveys.detractorsLabel')}
                value={npsQuestion?.nps ? npsQuestion.nps.detractors : '—'}
                hint={
                  npsQuestion?.nps
                    ? t('surveys.promotersHint', { count: npsQuestion.nps.promoters })
                    : undefined
                }
                icon="bell"
                tone="neutral"
              />
            </div>

            {selected.questions.map((q) => (
              <div key={q.id} className="space-y-1.5">
                <p className="text-sm font-semibold text-text">
                  {q.position}. {q.label}
                </p>
                {q.nps ? (
                  <p className="text-sm text-text-muted">
                    {t.rich('surveys.npsLine', {
                      score: q.nps.score,
                      promoters: q.nps.promoters,
                      passives: q.nps.passives,
                      detractors: q.nps.detractors,
                      answerCount: q.answerCount,
                      strong: (chunks) => <strong className="text-text">{chunks}</strong>,
                    })}
                  </p>
                ) : q.average !== null ? (
                  <p className="text-sm text-text-muted">
                    {t.rich('surveys.avgLine', {
                      average: q.average,
                      answerCount: q.answerCount,
                      strong: (chunks) => <strong className="text-text">{chunks}</strong>,
                    })}
                  </p>
                ) : q.texts.length > 0 ? (
                  <ul className="space-y-1.5">
                    {q.texts.map((text, i) => (
                      <li
                        key={i}
                        className="rounded-lg border border-border-soft bg-bg-subtle p-2.5 text-sm text-text"
                      >
                        {text}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-text-subtle">{t('surveys.noAnswers')}</p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
