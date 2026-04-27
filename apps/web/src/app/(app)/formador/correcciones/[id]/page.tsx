'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { assessmentsApi, type AttemptStatus } from '@/lib/assessments';

const OPEN_TYPES = new Set(['SHORT_ANSWER', 'LONG_ANSWER']);

const STATUS_VARIANT: Record<AttemptStatus, 'success' | 'warning' | 'muted' | 'danger'> = {
  GRADED: 'success',
  PENDING_REVIEW: 'warning',
  SUBMITTED: 'warning',
  IN_PROGRESS: 'muted',
  EXPIRED: 'danger',
  ABANDONED: 'muted',
};

const STATUS_LABEL: Record<AttemptStatus, string> = {
  GRADED: 'Calificado',
  PENDING_REVIEW: 'Pendiente de revisión',
  SUBMITTED: 'Enviado',
  IN_PROGRESS: 'En progreso',
  EXPIRED: 'Expirado',
  ABANDONED: 'Abandonado',
};

interface Grade {
  scoreEarned: string;
  feedback: string;
}

export default function CorreccionDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<Awaited<
    ReturnType<typeof assessmentsApi.getAttemptForFormador>
  > | null>(null);
  const [grades, setGrades] = useState<Record<string, Grade>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      } catch (e) {
        setError(e instanceof ApiHttpError ? e.message : 'Error al cargar');
      }
    })();
  }, [params?.id]);

  if (error)
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" className="self-start">
          <Link href="/formador/correcciones">← Volver a pendientes</Link>
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
      setError(e instanceof ApiHttpError ? e.message : 'Error al calificar');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-6">
      <Button asChild variant="ghost" className="self-start">
        <Link href="/formador/correcciones">← Volver a pendientes</Link>
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
                  {STATUS_LABEL[data.status]}
                </Badge>
                <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-mono text-white/85">
                  {data.id.slice(0, 8)}…
                </span>
              </div>
              <h1 className="font-display text-3xl font-bold tracking-tight">{data.quiz.title}</h1>
              <p className="mt-1 text-sm text-white/80">
                {openAnswered} {openAnswered === 1 ? 'pregunta abierta' : 'preguntas abiertas'} para
                corregir
                {data.submittedAt
                  ? ` · enviado el ${new Date(data.submittedAt).toLocaleString('es-AR')}`
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
            <p className="text-xs font-medium text-text-muted">total preguntas</p>
          </div>
          <div className="p-4 text-center">
            <p className="font-display text-2xl font-bold tabular-nums text-text">{openAnswered}</p>
            <p className="text-xs font-medium text-text-muted">a corregir</p>
          </div>
          <div className="p-4 text-center">
            <p className="font-display text-2xl font-bold tabular-nums text-text">
              {totalScore}
              <span className="text-base font-medium text-text-muted">/{totalPoints}</span>
            </p>
            <p className="text-xs font-medium text-text-muted">puntos parciales</p>
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
            Este intento ya no está pendiente de revisión (status actual:{' '}
            <strong>{STATUS_LABEL[data.status]}</strong>). Solo se pueden calificar intentos
            pendientes.
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
                          {q.points} {q.points === 1 ? 'pt' : 'pts'}
                        </span>
                        {isOpen ? (
                          <Badge variant="warning" className="text-[10px]">
                            <Icon name="edit" size={10} />
                            Manual
                          </Badge>
                        ) : (
                          <Badge variant="muted" className="text-[10px]">
                            Auto-corregida
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
                        <p className="label-uppercase text-text-muted">Respuesta del alumno</p>
                        <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-text">
                          {ans?.textAnswer ?? <em className="text-text-subtle">(en blanco)</em>}
                        </p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
                        <div className="space-y-1.5">
                          <label className="label-uppercase text-text-muted">
                            Puntos (max {q.points})
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
                            Feedback (opcional)
                          </label>
                          <Textarea
                            rows={3}
                            value={grades[q.id]?.feedback ?? ''}
                            disabled={!isPending}
                            placeholder="Comentario para el alumno (qué hizo bien, qué mejorar)…"
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
                    </>
                  ) : (
                    <div className="space-y-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        {ans?.isCorrect ? (
                          <Badge variant="success" dot>
                            Correcta
                          </Badge>
                        ) : (
                          <Badge variant="danger" dot>
                            Incorrecta
                          </Badge>
                        )}
                        <span className="text-xs tabular-nums text-text-muted">
                          {ans?.scoreEarned ?? 0}/{q.points} pts
                        </span>
                      </div>
                      {q.type === 'FILL_IN_BLANK' ? (
                        <div className="space-y-1.5">
                          <p className="text-sm text-text">
                            Respuesta del alumno:{' '}
                            <strong className="font-mono">
                              {ans?.textAnswer || '(en blanco)'}
                            </strong>
                          </p>
                          <p className="text-xs text-text-subtle">
                            Aceptadas: {q.acceptedAnswers.join(' · ') || '(ninguna)'}
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
                                    aria-label="correcta"
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
                                    aria-label="incorrecta"
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
                                    Marcada por el alumno
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
            Total parcial:{' '}
            <strong className="text-text tabular-nums">
              {totalScore}/{totalPoints}
            </strong>{' '}
            puntos. Al enviar, el alumno verá el resultado y la lección quedará completada si
            aprobó.
          </p>
          <Button onClick={handleSubmitGrades} disabled={submitting} size="lg">
            {submitting ? 'Calificando…' : 'Enviar calificación'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
