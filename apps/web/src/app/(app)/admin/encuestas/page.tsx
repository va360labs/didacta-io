'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/stat-card';
import { ApiHttpError } from '@/lib/api-client';
import { surveysAdminApi, type SurveyListItem, type SurveyResults } from '@/modules/surveys';

/// Panel admin de mod.surveys (bloque 2): listado de encuestas con nº de
/// respuestas y resultados agregados (NPS, medias, respuestas libres). Las
/// respuestas son anónimas: aquí solo se ven agregados y textos sin autor.

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function AdminEncuestasPage() {
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
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar las encuestas.');
    });
  }, [reload]);

  async function openResults(id: string) {
    setBusy(true);
    setError(null);
    try {
      setSelected(await surveysAdminApi.results(id));
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar los resultados.');
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
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cerrar la encuesta.');
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
        <h1 className="text-xl font-bold text-text">Encuestas</h1>
        <p className="mt-1 text-sm text-text-muted">
          Feedback anónimo de la comunidad. La encuesta post-clase se crea sola al terminar cada
          directo; aquí ves los agregados (NPS, medias) y las respuestas libres.
        </p>
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
          <CardTitle>Todas las encuestas</CardTitle>
          <CardDescription>Las más recientes primero.</CardDescription>
        </CardHeader>
        <CardContent>
          {surveys.length === 0 ? (
            <p className="text-sm text-text-subtle">
              Aún no hay encuestas. Se crean automáticamente al terminar cada clase en directo.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border-soft text-left text-xs text-text-subtle">
                    <th className="py-2 pr-3">Encuesta</th>
                    <th className="py-2 pr-3">Fecha</th>
                    <th className="py-2 pr-3">Estado</th>
                    <th className="py-2 pr-3">Respuestas</th>
                    <th className="py-2 pr-3" />
                  </tr>
                </thead>
                <tbody>
                  {surveys.map((s) => (
                    <tr key={s.id} className="border-b border-border-soft">
                      <td className="py-2 pr-3 font-medium text-text">{s.title}</td>
                      <td className="py-2 pr-3 text-text-muted">{formatDate(s.createdAt)}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={s.status === 'OPEN' ? 'success' : 'muted'}>
                          {s.status === 'OPEN' ? 'Abierta' : 'Cerrada'}
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
                            Resultados
                          </Button>
                          {s.status === 'OPEN' ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void closeSurvey(s.id)}
                            >
                              Cerrar
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
              {selected.responseCount} respuesta{selected.responseCount !== 1 ? 's' : ''} ·{' '}
              {formatDate(selected.createdAt)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <StatCard
                label="NPS"
                value={npsQuestion?.nps ? npsQuestion.nps.score : '—'}
                hint="promotores − detractores"
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
                label="Respuestas"
                value={selected.responseCount}
                hint="anónimas"
                icon="users"
                tone="info"
              />
              <StatCard
                label="Detractores"
                value={npsQuestion?.nps ? npsQuestion.nps.detractors : '—'}
                hint={npsQuestion?.nps ? `${npsQuestion.nps.promoters} promotores` : undefined}
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
                    NPS <strong className="text-text">{q.nps.score}</strong> · {q.nps.promoters}{' '}
                    promotores · {q.nps.passives} pasivos · {q.nps.detractors} detractores (
                    {q.answerCount} respuestas)
                  </p>
                ) : q.average !== null ? (
                  <p className="text-sm text-text-muted">
                    Media <strong className="text-text">{q.average}</strong> / 5 ({q.answerCount}{' '}
                    respuestas)
                  </p>
                ) : q.texts.length > 0 ? (
                  <ul className="space-y-1.5">
                    {q.texts.map((t, i) => (
                      <li
                        key={i}
                        className="rounded-lg border border-border-soft bg-bg-subtle p-2.5 text-sm text-text"
                      >
                        {t}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-text-subtle">Sin respuestas todavía.</p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
