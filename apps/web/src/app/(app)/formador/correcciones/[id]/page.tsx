'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { assessmentsApi } from '@/lib/assessments';

const OPEN_TYPES = new Set(['SHORT_ANSWER', 'LONG_ANSWER']);

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
        // Pre-rellena grades con el scoreEarned actual de cada respuesta abierta.
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
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  if (!data) return <p className="text-sm text-neutral-500">Cargando…</p>;

  const isPending = data.status === 'PENDING_REVIEW';

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
      <Link
        href="/formador/correcciones"
        className="text-xs text-neutral-500 underline decoration-dotted hover:decoration-solid"
      >
        ← Volver a pendientes
      </Link>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{data.quiz.title}</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Attempt {data.id.slice(0, 8)}… · status <strong>{data.status}</strong>
          {data.submittedAt ? ` · enviado ${new Date(data.submittedAt).toLocaleString()}` : ''}
        </p>
        {!isPending ? (
          <p className="mt-2 rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            Este attempt ya no está en PENDING_REVIEW (status actual: {data.status}). Solo se puede
            calificar attempts pendientes.
          </p>
        ) : null}
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      <ol className="space-y-4">
        {data.quiz.questions.map((q, idx) => {
          const ans = data.answers.find((a) => a.questionId === q.id);
          const isOpen = OPEN_TYPES.has(q.type);
          return (
            <li key={q.id}>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {idx + 1}. {q.prompt}
                  </CardTitle>
                  <CardDescription>
                    {q.type} · {q.points} pt{q.points === 1 ? '' : 's'}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {isOpen ? (
                    <>
                      <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
                        <p className="text-xs uppercase tracking-wider text-neutral-500">
                          Respuesta del alumno
                        </p>
                        <p className="mt-1 whitespace-pre-wrap">
                          {ans?.textAnswer ?? <em className="text-neutral-500">(en blanco)</em>}
                        </p>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-[120px_1fr]">
                        <div className="space-y-1">
                          <label className="text-xs uppercase tracking-wider text-neutral-500">
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
                        <div className="space-y-1">
                          <label className="text-xs uppercase tracking-wider text-neutral-500">
                            Feedback (opcional)
                          </label>
                          <Textarea
                            rows={2}
                            value={grades[q.id]?.feedback ?? ''}
                            disabled={!isPending}
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
                    <div className="space-y-2 text-sm">
                      <p className="text-xs uppercase tracking-wider text-neutral-500">
                        Auto-corregida · {ans?.isCorrect ? '✓ correcta' : '✗ incorrecta'} ·{' '}
                        {ans?.scoreEarned ?? 0}/{q.points} pts
                      </p>
                      {q.type === 'FILL_IN_BLANK' ? (
                        <p>
                          Respuesta del alumno: <strong>{ans?.textAnswer || '(en blanco)'}</strong>
                          <br />
                          <span className="text-xs text-neutral-500">
                            Aceptadas: {q.acceptedAnswers.join(' · ') || '(ninguna)'}
                          </span>
                        </p>
                      ) : (
                        <ul className="space-y-1">
                          {q.options.map((o) => {
                            const checked = ans?.selectedOptionIds.includes(o.id);
                            return (
                              <li key={o.id} className="flex items-center gap-2">
                                <span
                                  className={`inline-block h-2 w-2 rounded-full ${
                                    o.isCorrect
                                      ? 'bg-green-500'
                                      : 'bg-neutral-300 dark:bg-neutral-700'
                                  }`}
                                  aria-label={o.isCorrect ? 'correcta' : 'incorrecta'}
                                />
                                <span
                                  className={
                                    checked ? 'font-medium underline decoration-dotted' : ''
                                  }
                                >
                                  {o.label}
                                  {checked ? ' ← marcada por el alumno' : ''}
                                </span>
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
        <Button onClick={handleSubmitGrades} disabled={submitting}>
          {submitting ? 'Calificando…' : 'Enviar calificación'}
        </Button>
      ) : null}
    </section>
  );
}
