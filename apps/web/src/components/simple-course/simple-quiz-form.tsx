'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icon';
import { coursesApi, type CourseLesson } from '@/lib/courses';
import { cn } from '@/lib/utils';
import { assessmentsApi } from '@/modules/assessments';
import {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  PASS_THRESHOLDS,
  draftFromQuiz,
  draftProblem,
  emptyDraft,
  emptyQuestion,
  questionPayloads,
  questionsChanged,
  setMultiple,
  toggleCorrect,
  type DraftQuestion,
  type QuizDraft,
} from './quiz-draft';

const inputCls =
  'w-full rounded-xl border border-border bg-surface px-4 text-base text-text outline-none focus:border-brand-600 focus:ring-4 focus:ring-brand-100';

/**
 * Lección de CUESTIONARIO en el editor sencillo: título, nota para aprobar y
 * preguntas de una o varias respuestas correctas, todo en el mismo formulario.
 * Por debajo usa el módulo de evaluaciones de siempre (`mod.assessments`): un
 * quiz enlazado a la lección y publicado al guardar, el mismo que resuelve el
 * alumno en la lección y que se edita en el modo completo.
 *
 * Al crear, la lección aparece solo cuando el cuestionario ya tiene sus
 * preguntas: un fallo a medias no deja una lección vacía en el curso.
 */
export function SimpleQuizForm({
  lesson,
  getModuleId,
  onCancel,
  onSaved,
}: {
  lesson?: CourseLesson;
  getModuleId?: () => Promise<string>;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations('modoSencillo.curso');
  const tq = useTranslations('modoSencillo.curso.quiz');
  const quizId =
    typeof (lesson?.content as Record<string, unknown> | undefined)?.quizId === 'string'
      ? ((lesson!.content as Record<string, unknown>).quizId as string)
      : null;
  const [title, setTitle] = useState(lesson?.title ?? '');
  const [draft, setDraft] = useState<QuizDraft>(emptyDraft);
  const [loaded, setLoaded] = useState<QuizDraft | null>(null);
  const [published, setPublished] = useState(false);
  const [loading, setLoading] = useState(Boolean(quizId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!quizId) return;
    let cancelled = false;
    assessmentsApi
      .getQuizForFormador(quizId)
      .then((quiz) => {
        if (cancelled) return;
        const d = draftFromQuiz(quiz);
        setDraft(d);
        setLoaded(d);
        setPublished(quiz.status === 'PUBLISHED');
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(t('error'));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [quizId, t]);

  function updateQuestion(i: number, next: DraftQuestion) {
    setDraft((d) => ({ ...d, questions: d.questions.map((q, j) => (j === i ? next : q)) }));
  }

  function problemText(): string | null {
    const p = draftProblem(title, draft);
    if (!p) return null;
    return 'n' in p ? tq(`errores.${p.code}`, { n: p.n }) : tq(`errores.${p.code}`);
  }

  async function addQuestions(id: string) {
    for (const q of questionPayloads(draft)) await assessmentsApi.addQuestion(id, q);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = problemText();
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    const name = title.trim();
    try {
      if (lesson && quizId) {
        await assessmentsApi.updateQuiz(quizId, {
          title: name,
          passThreshold: draft.passThreshold,
        });
        if (!loaded || questionsChanged(loaded, draft)) {
          const current = await assessmentsApi.getQuizForFormador(quizId);
          for (const q of current.questions) await assessmentsApi.deleteQuestion(quizId, q.id);
          await addQuestions(quizId);
        }
        if (!published) await assessmentsApi.publishQuiz(quizId);
        if (name !== lesson.title) await coursesApi.updateLesson(lesson.id, { title: name });
      } else {
        // 1) El cuestionario con sus preguntas; 2) la lección que lo enseña;
        // 3) el enlace de vuelta (el intento cuenta para esa lección) y publicar.
        const quiz = await assessmentsApi.createQuiz({
          title: name,
          passThreshold: draft.passThreshold,
        });
        await addQuestions(quiz.id);
        const mid = await getModuleId!();
        const created = await coursesApi.addLesson(mid, {
          type: 'QUIZ',
          title: name,
          content: { quizId: quiz.id },
        });
        await assessmentsApi.updateQuiz(quiz.id, { lessonId: created.id });
        await assessmentsApi.publishQuiz(quiz.id);
      }
      await onSaved();
    } catch {
      setError(t('error'));
      setSaving(false);
    }
  }

  if (loading) return <div className="skeleton h-48 w-full" />;

  return (
    <form onSubmit={submit} className="grid gap-4" data-testid="form-cuestionario" noValidate>
      <div>
        <label htmlFor="quiz-titulo" className="text-sm font-semibold text-text">
          {t('tituloLeccion')}
        </label>
        <input
          id="quiz-titulo"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={tq('tituloPlaceholder')}
          maxLength={200}
          className={cn(inputCls, 'mt-1.5 h-12')}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="quiz-aprobado" className="text-sm font-semibold text-text">
          {tq('aprobado')}
        </label>
        <select
          id="quiz-aprobado"
          value={draft.passThreshold}
          onChange={(e) => setDraft((d) => ({ ...d, passThreshold: Number(e.target.value) }))}
          className="h-10 rounded-xl border border-border bg-surface px-3 text-sm font-semibold text-text outline-none focus:border-brand-600"
        >
          {(PASS_THRESHOLDS as readonly number[]).includes(draft.passThreshold) ? null : (
            <option value={draft.passThreshold}>
              {tq('aprobadoOpcion', { pct: draft.passThreshold })}
            </option>
          )}
          {PASS_THRESHOLDS.map((pct) => (
            <option key={pct} value={pct}>
              {tq('aprobadoOpcion', { pct })}
            </option>
          ))}
        </select>
        <span className="text-sm text-text-muted">{tq('aprobadoAyuda')}</span>
      </div>

      <ol className="grid gap-3">
        {draft.questions.map((q, i) => (
          <li
            key={i}
            className="rounded-2xl border border-border bg-bg-subtle/60 p-4"
            data-testid="pregunta"
          >
            <div className="flex items-center justify-between gap-3">
              <label htmlFor={`pregunta-${i}`} className="text-sm font-bold text-text">
                {tq('pregunta', { n: i + 1 })}
              </label>
              {draft.questions.length > 1 ? (
                <button
                  type="button"
                  onClick={() =>
                    setDraft((d) => ({ ...d, questions: d.questions.filter((_, j) => j !== i) }))
                  }
                  className="inline-flex items-center gap-1 text-sm font-semibold text-text-muted hover:text-danger-700"
                >
                  <Icon name="trash" size={14} />
                  {tq('quitarPregunta')}
                </button>
              ) : null}
            </div>
            <input
              id={`pregunta-${i}`}
              value={q.prompt}
              onChange={(e) => updateQuestion(i, { ...q, prompt: e.target.value })}
              placeholder={tq('preguntaPlaceholder')}
              maxLength={2000}
              className={cn(inputCls, 'mt-1.5 h-11')}
            />
            <p className="mt-3 text-xs font-semibold text-text-muted">
              {q.multiple ? tq('marcaCorrectas') : tq('marcaCorrecta')}
            </p>
            <ul className="mt-1.5 grid gap-2">
              {q.options.map((o, k) => (
                <li key={k} className="flex items-center gap-2">
                  <button
                    type="button"
                    role={q.multiple ? 'checkbox' : 'radio'}
                    aria-checked={o.correct}
                    aria-label={tq('correctaAria', { n: k + 1 })}
                    onClick={() => updateQuestion(i, toggleCorrect(q, k))}
                    className={cn(
                      'grid h-9 w-9 shrink-0 place-items-center border-2 transition-colors',
                      q.multiple ? 'rounded-lg' : 'rounded-full',
                      o.correct
                        ? 'border-success-600 bg-success-600 text-white'
                        : 'border-border-strong bg-surface text-transparent hover:border-success-600',
                    )}
                  >
                    <Icon name="check" size={16} />
                  </button>
                  <input
                    value={o.label}
                    onChange={(e) =>
                      updateQuestion(i, {
                        ...q,
                        options: q.options.map((x, j) =>
                          j === k ? { ...x, label: e.target.value } : x,
                        ),
                      })
                    }
                    placeholder={tq('respuestaPlaceholder', { n: k + 1 })}
                    aria-label={tq('respuestaPlaceholder', { n: k + 1 })}
                    maxLength={500}
                    className={cn(inputCls, 'h-10 min-w-0 flex-1 text-[15px]')}
                  />
                  {q.options.length > 2 ? (
                    <button
                      type="button"
                      onClick={() =>
                        updateQuestion(i, { ...q, options: q.options.filter((_, j) => j !== k) })
                      }
                      aria-label={tq('quitarRespuesta', { n: k + 1 })}
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-text-subtle hover:bg-surface hover:text-text"
                    >
                      <Icon name="x" size={16} />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              {q.options.length < MAX_OPTIONS ? (
                <button
                  type="button"
                  onClick={() =>
                    updateQuestion(i, {
                      ...q,
                      options: [...q.options, { label: '', correct: false }],
                    })
                  }
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:underline"
                >
                  <Icon name="plus" size={14} />
                  {tq('anadirRespuesta')}
                </button>
              ) : (
                <span />
              )}
              <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-text-muted">
                <input
                  type="checkbox"
                  checked={q.multiple}
                  onChange={(e) => updateQuestion(i, setMultiple(q, e.target.checked))}
                  className="h-4 w-4 accent-brand-600"
                />
                {tq('varias')}
              </label>
            </div>
          </li>
        ))}
      </ol>

      {draft.questions.length < MAX_QUESTIONS ? (
        <button
          type="button"
          onClick={() => setDraft((d) => ({ ...d, questions: [...d.questions, emptyQuestion()] }))}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed border-border-strong font-semibold text-text-muted hover:border-brand-600 hover:text-brand-700"
          data-testid="anadir-pregunta"
        >
          <Icon name="plus" size={16} />
          {tq('anadirPregunta')}
        </button>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm font-semibold text-danger-700">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="h-11 rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          data-testid="guardar-leccion"
        >
          {saving ? t('guardando') : t('guardar')}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-semibold text-text-muted">
          {t('cancelar')}
        </button>
      </div>
    </form>
  );
}
