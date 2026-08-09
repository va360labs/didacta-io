'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDateTime } from '@/lib/i18n/format';
import { labelOr } from '@/lib/i18n/labels';
import { assessmentsApi, type AttemptStatus } from '@/modules/assessments';
import { aiGraderApi, type Suggestion } from '@/modules/ai-grader';

const OPEN_TYPES = new Set(['SHORT_ANSWER', 'LONG_ANSWER']);

const STATUS_VARIANT: Record<AttemptStatus, 'success' | 'warning' | 'muted' | 'danger'> = {
  GRADED: 'success',
  PENDING_REVIEW: 'warning',
  SUBMITTED: 'warning',
  IN_PROGRESS: 'muted',
  EXPIRED: 'danger',
  ABANDONED: 'muted',
};

interface Grade {
  scoreEarned: string;
  feedback: string;
}

export default function CorreccionDetailPage() {
  const t = useTranslations('formadorAula');
  const tErrors = useTranslations('errors');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<Awaited<
    ReturnType<typeof assessmentsApi.getAttemptForFormador>
  > | null>(null);
  const [grades, setGrades] = useState<Record<string, Grade>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNotice, setSuggestNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!params?.id) return;
    void (async () => {
      try {
        const result = await assessmentsApi.getAttemptForFormador(params.id);
        setData(result);
        const initial: Record<string, Grade> = {};
        for (const q of result.quiz.questions) {
          if (!OPEN_TYPES.has(q.type)) continue;
          const ans = result.answers.find((a) => a.questionId === q.id);
          initial[q.id] = {
            scoreEarned: String(ans?.scoreEarned ?? 0),
            feedback: ans?.gradedFeedback ?? '',
          };
        }
        setGrades(initial);

        // Carga sugerencias IA persistidas si las hay (no llama al modelo).
        try {
          const persisted = await aiGraderApi.listSuggestions(result.id);
          const byQuestion: Record<string, Suggestion> = {};
          for (const s of persisted) byQuestion[s.questionId] = s;
          setSuggestions(byQuestion);
        } catch {
          // mod.ai-grader puede no estar activo en el tenant: ignorar
          // silenciosamente y simplemente no mostrar el panel IA.
        }
      } catch (e) {
        setError(
          e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('correccionDetail.loadError'),
        );
      }
    })();
  }, [params?.id]);

  async function handleSuggestAll(force = false) {
    if (!data) return;
    setSuggesting(true);
    setSuggestNotice(null);
    try {
      const r = await aiGraderApi.suggestForAttempt(data.id, force);
      const byQuestion: Record<string, Suggestion> = {};
      for (const s of r.generated) byQuestion[s.questionId] = s;
      setSuggestions(byQuestion);
      const parts = [t('correccionDetail.suggestionsGenerated', { count: r.generated.length })];
      if (r.skipped.length > 0) {
        parts.push(t('correccionDetail.suggestionsSkipped', { count: r.skipped.length }));
      }
      parts.push(
        t('correccionDetail.tokensUsed', {
          tokens: r.tokensUsed.input + r.tokensUsed.output,
        }),
      );
      setSuggestNotice(parts.join(' '));
    } catch (e) {
      setSuggestNotice(
        e instanceof ApiHttpError
          ? apiErrorMessage(e, tErrors)
          : t('correccionDetail.suggestError'),
      );
    } finally {
      setSuggesting(false);
    }
  }

  function applySuggestionToForm(s: Suggestion) {
    setGrades((prev) => ({
      ...prev,
      [s.questionId]: {
        scoreEarned: String(s.proposedScore),
        feedback: s.overallFeedback,
      },
    }));
    // Marca como aplicada en background (audit-only, no bloquea la UI).
    void aiGraderApi.markApplied(s.id).catch(() => {
      /* tolerar fallo: la auditoría es best-effort */
    });
  }

  if (error)
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" className="self-start">
          <Link href="/formador/correcciones">{t('correccionDetail.backToPending')}</Link>
        </Button>
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      </div>
    );
  if (!data)
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-32" />
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-48 w-full" />
        <div className="skeleton h-48 w-full" />
      </div>
    );

  const isPending = data.status === 'PENDING_REVIEW';
  const openAnswered = data.quiz.questions.filter((q) => OPEN_TYPES.has(q.type)).length;
  const totalScore = Object.values(grades).reduce((s, g) => s + (Number(g.scoreEarned) || 0), 0);
  const totalPoints = data.quiz.questions.reduce((s, q) => s + q.points, 0);

  async function handleSubmitGrades() {
    if (!data) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = Object.entries(grades).map(([questionId, g]) => ({
        questionId,
        scoreEarned: Number(g.scoreEarned),
        feedback: g.feedback || undefined,
      }));
      await assessmentsApi.gradeAttempt(data.id, payload);
      router.push('/formador/correcciones');
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('correccionDetail.gradeError'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-6">
      <Button asChild variant="ghost" className="self-start">
        <Link href="/formador/correcciones">{t('correccionDetail.backToPending')}</Link>
      </Button>

      {/* === Hero === */}
      <Card className="overflow-hidden p-0">
        <div
          className="px-6 py-6 text-white"
          style={{
            background: 'linear-gradient(135deg, #0D1B2A 0%, #1E5AA8 100%)',
          }}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge variant={STATUS_VARIANT[data.status]} dot>
                  {labelOr(t, `attemptStatus.${data.status}`, data.status)}
                </Badge>
                <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-mono text-white/85">
                  {data.id.slice(0, 8)}…
                </span>
              </div>
              <h1 className="font-display text-3xl font-bold tracking-tight text-white">
                {data.quiz.title}
              </h1>
              <p className="mt-1 text-sm text-white/80">
                {t('correccionDetail.openToGrade', { count: openAnswered })}
                {data.submittedAt
                  ? ` · ${t('correccionDetail.sentOnDate', {
                      date: formatDateTime(data.submittedAt),
                    })}`
                  : ''}
              </p>
            </div>
          </div>
        </div>

        {/* Métricas en footer */}
        <div className="grid grid-cols-3 divide-x divide-border-soft border-t border-border bg-surface-2">
          <div className="p-4 text-center">
            <p className="font-display text-2xl font-bold tabular-nums text-text">
              {data.quiz.questions.length}
            </p>
            <p className="text-xs font-medium text-text-muted">
              {t('correccionDetail.totalQuestionsMetric')}
            </p>
          </div>
          <div className="p-4 text-center">
            <p className="font-display text-2xl font-bold tabular-nums text-text">{openAnswered}</p>
            <p className="text-xs font-medium text-text-muted">
              {t('correccionDetail.toGradeMetric')}
            </p>
          </div>
          <div className="p-4 text-center">
            <p className="font-display text-2xl font-bold tabular-nums text-text">
              {totalScore}
              <span className="text-base font-medium text-text-muted">/{totalPoints}</span>
            </p>
            <p className="text-xs font-medium text-text-muted">
              {t('correccionDetail.partialPointsMetric')}
            </p>
          </div>
        </div>
      </Card>

      {!isPending ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg p-4 text-sm"
          style={{
            background: 'var(--didacta-warn-bg)',
            color: 'var(--didacta-warn-fg)',
          }}
        >
          <Icon name="alert" size={18} className="mt-0.5 shrink-0" />
          <p>
            {t.rich('correccionDetail.notPendingAlert', {
              strong: (chunks) => <strong>{chunks}</strong>,
              status: labelOr(t, `attemptStatus.${data.status}`, data.status),
            })}
          </p>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {isPending && openAnswered > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-trust-100 bg-trust-50/40 p-3">
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-semibold text-text">{t('correccionDetail.aiPanelTitle')}</p>
            <p className="text-xs text-text-subtle">{t('correccionDetail.aiPanelHint')}</p>
            {suggestNotice ? <p className="mt-1 text-xs text-text">{suggestNotice}</p> : null}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void handleSuggestAll(false)}
              disabled={suggesting}
            >
              {suggesting ? t('correccionDetail.suggesting') : t('correccionDetail.suggestWithAi')}
            </Button>
            {Object.keys(suggestions).length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void handleSuggestAll(true)}
                disabled={suggesting}
              >
                {t('correccionDetail.regenerate')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <ol className="space-y-4">
        {data.quiz.questions.map((q, idx) => {
          const ans = data.answers.find((a) => a.questionId === q.id);
          const isOpen = OPEN_TYPES.has(q.type);
          const numberLabel = `${idx + 1}`.padStart(2, '0');
          return (
            <li key={q.id}>
              <Card>
                <CardHeader>
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-md font-display text-xs font-bold tabular-nums"
                      style={{
                        background: 'var(--didacta-info-bg)',
                        color: 'var(--didacta-info-fg)',
                      }}
                    >
                      {numberLabel}
                    </span>
                    <div className="min-w-0 flex-1">
                      <CardTitle className="text-base leading-snug">{q.prompt}</CardTitle>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                        <span className="tabular-nums">
                          {t('correccionDetail.pointsShort', { points: q.points })}
                        </span>
                        {isOpen ? (
                          <Badge variant="warning" className="text-[10px]">
                            <Icon name="edit" size={10} />
                            {t('correccionDetail.manualBadge')}
                          </Badge>
                        ) : (
                          <Badge variant="muted" className="text-[10px]">
                            {t('correccionDetail.autoGradedBadge')}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {isOpen ? (
                    <>
                      <div className="rounded-lg border border-border bg-surface-2 p-3">
                        <p className="label-uppercase text-text-muted">
                          {t('correccionDetail.studentAnswer')}
                        </p>
                        <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-text">
                          {ans?.textAnswer ?? (
                            <em className="text-text-subtle">
                              {t('correccionDetail.blankAnswer')}
                            </em>
                          )}
                        </p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
                        <div className="space-y-1.5">
                          <label className="label-uppercase text-text-muted">
                            {t('correccionDetail.pointsMax', { points: q.points })}
                          </label>
                          <Input
                            type="number"
                            min={0}
                            max={q.points}
                            value={grades[q.id]?.scoreEarned ?? '0'}
                            disabled={!isPending}
                            onChange={(e) =>
                              setGrades((prev) => ({
                                ...prev,
                                [q.id]: {
                                  scoreEarned: e.target.value,
                                  feedback: prev[q.id]?.feedback ?? '',
                                },
                              }))
                            }
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="label-uppercase text-text-muted">
                            {t('correccionDetail.feedbackLabel')}
                          </label>
                          <Textarea
                            rows={3}
                            value={grades[q.id]?.feedback ?? ''}
                            disabled={!isPending}
                            placeholder={t('correccionDetail.feedbackPlaceholder')}
                            onChange={(e) =>
                              setGrades((prev) => ({
                                ...prev,
                                [q.id]: {
                                  scoreEarned: prev[q.id]?.scoreEarned ?? '0',
                                  feedback: e.target.value,
                                },
                              }))
                            }
                          />
                        </div>
                      </div>
                      {suggestions[q.id] ? (
                        <div className="rounded-lg border border-trust-100 bg-trust-50/40 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <Badge variant="info" className="text-[10px]">
                                {t('correccionDetail.aiSuggestionBadge')}
                              </Badge>
                              <span className="text-xs text-text-subtle">
                                {t('correccionDetail.suggestionMeta', {
                                  score: suggestions[q.id]!.proposedScore,
                                  points: q.points,
                                  provider: suggestions[q.id]!.provider,
                                })}
                                {suggestions[q.id]!.model ? ` · ${suggestions[q.id]!.model}` : ''}
                              </span>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => applySuggestionToForm(suggestions[q.id]!)}
                              disabled={!isPending}
                            >
                              {t('correccionDetail.applyToForm')}
                            </Button>
                          </div>
                          <p className="mt-2 whitespace-pre-wrap text-sm text-text">
                            {suggestions[q.id]!.overallFeedback}
                          </p>
                          {suggestions[q.id]!.perCriterion.length > 0 ? (
                            <ul className="mt-2 space-y-1 text-xs text-text-subtle">
                              {suggestions[q.id]!.perCriterion.map((c, ci) => (
                                <li key={ci}>
                                  <span className="font-semibold text-text">
                                    {c.name} ({c.score}):
                                  </span>{' '}
                                  {c.justification}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="space-y-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        {ans?.isCorrect ? (
                          <Badge variant="success" dot>
                            {t('correccionDetail.correctBadge')}
                          </Badge>
                        ) : (
                          <Badge variant="danger" dot>
                            {t('correccionDetail.incorrectBadge')}
                          </Badge>
                        )}
                        <span className="text-xs tabular-nums text-text-muted">
                          {t('correccionDetail.scoreOutOf', {
                            score: ans?.scoreEarned ?? 0,
                            points: q.points,
                          })}
                        </span>
                      </div>
                      {q.type === 'FILL_IN_BLANK' ? (
                        <div className="space-y-1.5">
                          <p className="text-sm text-text">
                            {t('correccionDetail.studentAnswerColon')}{' '}
                            <strong className="font-mono">
                              {ans?.textAnswer || t('correccionDetail.blankAnswer')}
                            </strong>
                          </p>
                          <p className="text-xs text-text-subtle">
                            {t('correccionDetail.acceptedList', {
                              answers:
                                q.acceptedAnswers.join(' · ') || t('correccionDetail.noneAccepted'),
                            })}
                          </p>
                        </div>
                      ) : (
                        <ul className="space-y-1.5">
                          {q.options.map((o) => {
                            const checked = ans?.selectedOptionIds.includes(o.id) ?? false;
                            return (
                              <li key={o.id} className="flex items-center gap-2.5 text-sm">
                                {o.isCorrect ? (
                                  <span
                                    aria-label={t('correccionDetail.correctOption')}
                                    className="grid h-5 w-5 shrink-0 place-items-center rounded-full"
                                    style={{
                                      background: 'var(--didacta-success-bg)',
                                      color: 'var(--didacta-success-fg)',
                                    }}
                                  >
                                    <Icon name="check" size={12} strokeWidth={3} />
                                  </span>
                                ) : (
                                  <span
                                    aria-label={t('correccionDetail.incorrectOption')}
                                    className="h-5 w-5 shrink-0 rounded-full border-2 border-border-strong bg-transparent"
                                  />
                                )}
                                <span
                                  className={
                                    checked
                                      ? 'flex-1 font-semibold text-text'
                                      : 'flex-1 text-text-muted'
                                  }
                                >
                                  {o.label}
                                </span>
                                {checked ? (
                                  <Badge variant="info" className="shrink-0 text-[10px]">
                                    {t('correccionDetail.markedByStudent')}
                                  </Badge>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ol>

      {isPending ? (
        <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 shadow-lg">
          <p className="text-sm text-text-muted">
            {t.rich('correccionDetail.totalFooter', {
              strong: (chunks) => <strong className="text-text tabular-nums">{chunks}</strong>,
              score: totalScore,
              total: totalPoints,
            })}
          </p>
          <Button onClick={handleSubmitGrades} disabled={submitting} size="lg">
            {submitting ? t('correccionDetail.grading') : t('correccionDetail.submitGrades')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
