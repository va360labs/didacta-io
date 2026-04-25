'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
        message: e instanceof ApiHttpError ? e.message : 'No se pudo cargar el quiz',
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
        message: e instanceof ApiHttpError ? e.message : 'No se pudo iniciar el intento',
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
        message: e instanceof ApiHttpError ? e.message : 'Error al enviar el intento',
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

  if (state.kind === 'loading') return <p className="text-sm text-neutral-500">Cargando quiz…</p>;
  if (state.kind === 'empty')
    return (
      <Empty hint="Esta lección está marcada como QUIZ pero aún no tiene un quiz vinculado. Pídele al formador que lo asocie." />
    );
  if (state.kind === 'error')
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {state.message}
      </p>
    );

  if (state.kind === 'idle') {
    const lastSubmitted = state.attempts.find((a) => a.status === 'SUBMITTED');
    const submittedCount = state.attempts.filter((a) => a.status === 'SUBMITTED').length;
    const reachedLimit =
      state.quiz.maxAttempts !== null && submittedCount >= state.quiz.maxAttempts;

    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{state.quiz.title}</CardTitle>
          <CardDescription>
            {state.quiz.questions.length} preguntas · umbral{' '}
            <strong>{state.quiz.passThreshold}%</strong>
            {state.quiz.timeLimitMinutes ? ` · ${state.quiz.timeLimitMinutes} min` : ''}
            {state.quiz.maxAttempts ? ` · máx. ${state.quiz.maxAttempts} intentos` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {state.quiz.description ? (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {state.quiz.description}
            </p>
          ) : null}
          {lastSubmitted ? (
            <p
              className={`text-sm ${
                lastSubmitted.passed
                  ? 'text-green-700 dark:text-green-400'
                  : 'text-amber-700 dark:text-amber-400'
              }`}
            >
              Último intento: {lastSubmitted.scorePercent ?? 0}%{' '}
              {lastSubmitted.passed ? '· APROBADO ✓' : '· no aprobado'}
            </p>
          ) : null}
          {reachedLimit ? (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Has alcanzado el máximo de intentos permitidos.
            </p>
          ) : (
            <Button onClick={handleStart} disabled={pending}>
              {pending ? 'Iniciando…' : lastSubmitted ? 'Reintentar' : 'Iniciar quiz'}
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
          <CardTitle className="text-lg">{state.quiz.title}</CardTitle>
          <CardDescription>
            Responde todas las preguntas y envía. Umbral de aprobación: {state.quiz.passThreshold}%.
            {state.attempt.expiresAt
              ? ` Tiempo límite hasta ${new Date(state.attempt.expiresAt).toLocaleTimeString()}.`
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {state.quiz.questions.map((q, idx) => (
            <fieldset key={q.id} className="space-y-2">
              <legend className="text-sm font-medium">
                {idx + 1}. {q.prompt}
                <span className="ml-2 text-xs text-neutral-500">
                  ({q.points} pt{q.points === 1 ? '' : 's'} ·{' '}
                  {q.type === 'MULTIPLE_CHOICE'
                    ? 'múltiples respuestas'
                    : q.type === 'FILL_IN_BLANK'
                      ? 'rellena el hueco'
                      : 'una respuesta'}
                  )
                </span>
              </legend>
              {q.type === 'FILL_IN_BLANK' ? (
                <input
                  type="text"
                  value={textAnswers[q.id] ?? ''}
                  onChange={(e) => setTextAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  placeholder="Escribe tu respuesta…"
                  className="block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              ) : q.type === 'SHORT_ANSWER' || q.type === 'LONG_ANSWER' ? (
                <textarea
                  rows={q.type === 'LONG_ANSWER' ? 6 : 2}
                  value={textAnswers[q.id] ?? ''}
                  onChange={(e) => setTextAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  placeholder="Escribe tu respuesta… (la corregirá manualmente el formador)"
                  className="block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              ) : (
                <div className="space-y-1">
                  {q.options.map((o) => {
                    const checked = (answers[q.id] ?? []).includes(o.id);
                    return (
                      <label
                        key={o.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                      >
                        <input
                          type={q.type === 'MULTIPLE_CHOICE' ? 'checkbox' : 'radio'}
                          name={`q-${q.id}`}
                          checked={checked}
                          onChange={(e) => setSelected(q, o.id, e.target.checked)}
                        />
                        <span className="text-sm">{o.label}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </fieldset>
          ))}
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? 'Enviando…' : 'Enviar respuestas'}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // result
  const a = state.attempt;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          Resultado · {a.scorePercent ?? 0}% {a.passed ? '✓' : '✗'}
        </CardTitle>
        <CardDescription>
          {a.scoreEarned ?? 0} de {a.scoreMax ?? 0} puntos · umbral {state.quiz.passThreshold}%
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p
          className={`text-sm font-medium ${
            a.passed ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'
          }`}
        >
          {a.passed
            ? '¡Aprobado! La lección queda marcada como completada automáticamente.'
            : 'No alcanzaste el umbral. Puedes reintentar si el quiz lo permite.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={pending}>
          Volver al quiz
        </Button>
      </CardContent>
    </Card>
  );
}

function Empty({ hint }: { hint: string }) {
  return (
    <div className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
      {hint}
    </div>
  );
}
