'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import {
  assessmentsApi,
  type AlumnoQuestion,
  type AttemptSummary,
  type QuizAlumnoView,
} from '@/lib/assessments';

interface Props {
  quizId: string;
  enrollmentId: string;
  lessonId: string;
  onPassed?: () => void;
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'idle'; quiz: QuizAlumnoView; attempts: AttemptSummary[] }
  | { kind: 'attempt'; quiz: QuizAlumnoView; attempt: AttemptSummary }
  | { kind: 'result'; quiz: QuizAlumnoView; attempt: AttemptSummary };

const QUESTION_TYPE_HINT: Record<string, string> = {
  SINGLE_CHOICE: 'Una respuesta correcta',
  MULTIPLE_CHOICE: 'Una o más respuestas correctas',
  TRUE_FALSE: 'Verdadero o falso',
  FILL_IN_BLANK: 'Rellená el hueco',
  SHORT_ANSWER: 'Respuesta corta · revisión manual',
  LONG_ANSWER: 'Respuesta extensa · revisión manual',
};

export function QuizPlayer({ quizId, enrollmentId, lessonId, onPassed }: Props) {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [pending, setPending] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [textAnswers, setTextAnswers] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!quizId) {
      setState({ kind: 'empty' });
      return;
    }
    try {
      const [quiz, attempts] = await Promise.all([
        assessmentsApi.preview(quizId),
        assessmentsApi.listAttempts(quizId),
      ]);
      setState({ kind: 'idle', quiz, attempts });
    } catch (e) {
      setState({
        kind: 'error',
        message:
          e instanceof ApiHttpError
            ? e.message
            : 'No pudimos cargar el quiz. Probá refrescar la página.',
      });
    }
  }, [quizId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleStart() {
    if (state.kind !== 'idle') return;
    setPending(true);
    try {
      const attempt = await assessmentsApi.startAttempt({ quizId, enrollmentId, lessonId });
      setAnswers({});
      setTextAnswers({});
      setState({ kind: 'attempt', quiz: state.quiz, attempt });
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof ApiHttpError ? e.message : 'No pudimos iniciar tu intento.',
      });
    } finally {
      setPending(false);
    }
  }

  async function handleSubmit() {
    if (state.kind !== 'attempt') return;
    setPending(true);
    try {
      const payload = state.quiz.questions.map((q) => {
        if (q.type === 'FILL_IN_BLANK' || q.type === 'SHORT_ANSWER' || q.type === 'LONG_ANSWER') {
          return {
            questionId: q.id,
            selectedOptionIds: [],
            textAnswer: textAnswers[q.id] ?? '',
          };
        }
        return {
          questionId: q.id,
          selectedOptionIds: answers[q.id] ?? [],
        };
      });
      const submitted = await assessmentsApi.submitAttempt(state.attempt.id, payload);
      setState({ kind: 'result', quiz: state.quiz, attempt: submitted });
      if (submitted.passed) onPassed?.();
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof ApiHttpError ? e.message : 'No pudimos enviar tus respuestas.',
      });
    } finally {
      setPending(false);
    }
  }

  function setSelected(question: AlumnoQuestion, optionId: string, checked: boolean) {
    setAnswers((prev) => {
      const current = prev[question.id] ?? [];
      if (question.type === 'MULTIPLE_CHOICE') {
        const next = checked ? [...current, optionId] : current.filter((id) => id !== optionId);
        return { ...prev, [question.id]: Array.from(new Set(next)) };
      }
      return { ...prev, [question.id]: checked ? [optionId] : [] };
    });
  }

  if (state.kind === 'loading') {
    return (
      <div className="space-y-3">
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-64 w-full" />
      </div>
    );
  }

  if (state.kind === 'empty')
    return (
      <Empty hint="Esta lección está marcada como Quiz pero el formador aún no vinculó las preguntas." />
    );

  if (state.kind === 'error') {
    return (
      <div
        role="alert"
        className="rounded-lg border border-danger-100 bg-danger-50 p-4 text-sm text-danger-700"
      >
        {state.message}
      </div>
    );
  }

  if (state.kind === 'idle') {
    const lastSubmitted = state.attempts.find(
      (a) => a.status === 'SUBMITTED' || a.status === 'GRADED',
    );
    const submittedCount = state.attempts.filter(
      (a) => a.status === 'SUBMITTED' || a.status === 'GRADED',
    ).length;
    const reachedLimit =
      state.quiz.maxAttempts !== null && submittedCount >= state.quiz.maxAttempts;
    const hasPendingReview = state.attempts.some((a) => a.status === 'PENDING_REVIEW');

    return (
      <Card>
        <CardHeader>
          <CardTitle>{state.quiz.title}</CardTitle>
          <CardDescription>
            {state.quiz.questions.length} pregunta{state.quiz.questions.length === 1 ? '' : 's'} ·
            umbral <strong className="text-text">{state.quiz.passThreshold}%</strong>
            {state.quiz.timeLimitMinutes ? ` · ${state.quiz.timeLimitMinutes} min` : ''}
            {state.quiz.maxAttempts ? ` · máx. ${state.quiz.maxAttempts} intentos` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.quiz.description ? (
            <p className="text-sm text-text-muted leading-relaxed">{state.quiz.description}</p>
          ) : null}

          {hasPendingReview ? (
            <div className="rounded-lg border border-brand-200 bg-brand-50 p-3 text-sm">
              <p className="font-semibold text-brand-700">Tu intento está en revisión</p>
              <p className="mt-0.5 text-text">
                El formador está corrigiendo tus respuestas abiertas. Te avisaremos cuando esté
                listo.
              </p>
            </div>
          ) : lastSubmitted ? (
            <div
              className={
                lastSubmitted.passed
                  ? 'rounded-lg border border-success-200 bg-success-50 p-3 text-sm'
                  : 'rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm'
              }
            >
              <p
                className={
                  lastSubmitted.passed
                    ? 'font-semibold text-success-700'
                    : 'font-semibold text-warning-700'
                }
              >
                Último intento: {lastSubmitted.scorePercent ?? 0}%{' '}
                {lastSubmitted.passed ? '· aprobado' : '· no aprobado'}
              </p>
            </div>
          ) : null}

          {reachedLimit ? (
            <div className="rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm text-warning-700">
              Alcanzaste el máximo de intentos permitidos.
            </div>
          ) : (
            <Button onClick={handleStart} disabled={pending} size="lg">
              {pending ? 'Iniciando…' : lastSubmitted ? 'Reintentar quiz' : 'Empezar quiz'}
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  if (state.kind === 'attempt') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{state.quiz.title}</CardTitle>
          <CardDescription>
            Respondé todas las preguntas y enviá. Umbral de aprobación:{' '}
            <strong className="text-text">{state.quiz.passThreshold}%</strong>.
            {state.attempt.expiresAt
              ? ` Tenés tiempo hasta las ${new Date(state.attempt.expiresAt).toLocaleTimeString('es-AR')}.`
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-8">
          {state.quiz.questions.map((q, idx) => (
            <fieldset key={q.id} className="space-y-3">
              <legend className="block w-full">
                <span className="font-display text-base font-semibold text-text">
                  <span className="text-text-subtle tabular-nums">
                    {String(idx + 1).padStart(2, '0')}.
                  </span>{' '}
                  {q.prompt}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-2">
                  <Badge variant="muted" className="text-[10px]">
                    {QUESTION_TYPE_HINT[q.type] ?? q.type}
                  </Badge>
                  <span className="text-xs text-text-subtle">
                    {q.points} pt{q.points === 1 ? '' : 's'}
                  </span>
                </span>
              </legend>

              {q.type === 'FILL_IN_BLANK' ? (
                <Input
                  type="text"
                  value={textAnswers[q.id] ?? ''}
                  onChange={(e) => setTextAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  placeholder="Escribí tu respuesta…"
                />
              ) : q.type === 'SHORT_ANSWER' || q.type === 'LONG_ANSWER' ? (
                <Textarea
                  rows={q.type === 'LONG_ANSWER' ? 8 : 3}
                  value={textAnswers[q.id] ?? ''}
                  onChange={(e) => setTextAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  placeholder="Escribí tu respuesta — el formador la corregirá manualmente."
                />
              ) : (
                <div className="space-y-1">
                  {q.options.map((o) => {
                    const checked = (answers[q.id] ?? []).includes(o.id);
                    return (
                      <label
                        key={o.id}
                        className={
                          checked
                            ? 'flex cursor-pointer items-center gap-3 rounded-md border border-brand-200 bg-brand-50 p-3 transition-colors'
                            : 'flex cursor-pointer items-center gap-3 rounded-md border border-border bg-surface p-3 transition-colors hover:border-border-strong hover:bg-surface-2'
                        }
                      >
                        <input
                          type={q.type === 'MULTIPLE_CHOICE' ? 'checkbox' : 'radio'}
                          name={`q-${q.id}`}
                          checked={checked}
                          onChange={(e) => setSelected(q, o.id, e.target.checked)}
                          className="h-4 w-4 accent-brand-500"
                        />
                        <span className="text-sm leading-relaxed">{o.label}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </fieldset>
          ))}
          <Button onClick={handleSubmit} disabled={pending} size="lg" className="w-full sm:w-auto">
            {pending ? 'Enviando…' : 'Enviar respuestas'}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // result
  const a = state.attempt;
  const isPendingReview = a.status === 'PENDING_REVIEW';

  return (
    <Card>
      <CardContent className="p-8 text-center">
        {/* Hero icon + title — color depende del estado */}
        <div
          className={
            isPendingReview
              ? 'mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-brand-50 text-brand-700 text-3xl'
              : a.passed
                ? 'mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-success-50 text-success-700 text-3xl'
                : 'mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-warning-50 text-warning-700 text-3xl'
          }
          aria-hidden="true"
        >
          {isPendingReview ? '⏳' : a.passed ? '✓' : '↻'}
        </div>

        <h3 className="font-display mt-4 text-2xl font-bold tracking-tight">
          {isPendingReview
            ? 'En revisión por tu formador'
            : a.passed
              ? '¡Lo lograste!'
              : 'No alcanzaste el umbral'}
        </h3>

        {!isPendingReview ? (
          <p className="mt-2 text-text-muted">
            <span className="font-display text-4xl font-extrabold text-text tabular-nums">
              {a.scorePercent ?? 0}%
            </span>
            <span className="ml-2 text-sm">
              ({a.scoreEarned ?? 0} de {a.scoreMax ?? 0} puntos · umbral {state.quiz.passThreshold}
              %)
            </span>
          </p>
        ) : null}

        <p className="mt-4 text-sm text-text-muted leading-relaxed max-w-md mx-auto">
          {isPendingReview
            ? 'Tu intento contiene respuestas abiertas. Cuando el formador termine de corregir, vas a poder ver el resultado y, si aprobaste, la lección queda completada automáticamente.'
            : a.passed
              ? 'La lección queda marcada como completada. Si era la última que te faltaba, tu certificado se está emitiendo en este momento.'
              : 'Si el quiz lo permite, podés reintentar. Repasá las lecciones anteriores y volvé cuando estés listo.'}
        </p>

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button variant="secondary" onClick={() => void load()} disabled={pending}>
            Volver al quiz
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Empty({ hint }: { hint: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border-strong bg-surface-2 px-6 py-12 text-center text-sm text-text-muted">
      {hint}
    </div>
  );
}
