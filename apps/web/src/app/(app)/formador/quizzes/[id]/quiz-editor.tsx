'use client';

import { useState } from 'react';
import { Icon, type IconName } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import {
  assessmentsApi,
  type FormadorQuestion,
  type QuestionType,
  type QuizFormadorView,
  type QuizStatus,
} from '@/lib/assessments';

const QUESTION_TYPES: { value: QuestionType; label: string }[] = [
  { value: 'SINGLE_CHOICE', label: 'Opción única' },
  { value: 'MULTIPLE_CHOICE', label: 'Opciones múltiples' },
  { value: 'TRUE_FALSE', label: 'Verdadero / Falso' },
  { value: 'FILL_IN_BLANK', label: 'Rellenar el hueco' },
  { value: 'SHORT_ANSWER', label: 'Respuesta corta (corrección manual)' },
  { value: 'LONG_ANSWER', label: 'Respuesta larga (corrección manual)' },
];

const QTYPE_LABEL: Record<QuestionType, string> = {
  SINGLE_CHOICE: 'Opción única',
  MULTIPLE_CHOICE: 'Opciones múltiples',
  TRUE_FALSE: 'V/F',
  FILL_IN_BLANK: 'Rellenar hueco',
  SHORT_ANSWER: 'Respuesta corta',
  LONG_ANSWER: 'Respuesta larga',
};

const QTYPE_ICON: Record<QuestionType, IconName> = {
  SINGLE_CHOICE: 'circle',
  MULTIPLE_CHOICE: 'check',
  TRUE_FALSE: 'help',
  FILL_IN_BLANK: 'edit',
  SHORT_ANSWER: 'message',
  LONG_ANSWER: 'book',
};

const STATUS_VARIANT: Record<QuizStatus, 'success' | 'warning' | 'muted'> = {
  PUBLISHED: 'success',
  DRAFT: 'warning',
  ARCHIVED: 'muted',
};

const STATUS_LABEL: Record<QuizStatus, string> = {
  PUBLISHED: 'Publicado',
  DRAFT: 'Borrador',
  ARCHIVED: 'Archivado',
};

interface DraftOption {
  label: string;
  isCorrect: boolean;
}

export function QuizEditor({
  initial,
  onChange,
}: {
  initial: QuizFormadorView;
  onChange: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function withRefresh(action: () => Promise<unknown>) {
    setError(null);
    setPending(true);
    try {
      await action();
      await onChange();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'Error inesperado');
    } finally {
      setPending(false);
    }
  }

  async function handleSaveSettings(form: FormData) {
    await withRefresh(() =>
      assessmentsApi.updateQuiz(initial.id, {
        title: String(form.get('title')),
        description: form.get('description') ? String(form.get('description')) : undefined,
        passThreshold: Number(form.get('passThreshold')),
        maxAttempts: form.get('maxAttempts') ? Number(form.get('maxAttempts')) : undefined,
        timeLimitMinutes: form.get('timeLimitMinutes')
          ? Number(form.get('timeLimitMinutes'))
          : undefined,
        shuffleQuestions: form.get('shuffleQuestions') === 'on',
        showFeedback: form.get('showFeedback') === 'on',
      }),
    );
  }

  async function handlePublish() {
    await withRefresh(() => assessmentsApi.publishQuiz(initial.id));
  }

  async function handleDeleteQuestion(qid: string) {
    if (!confirm('¿Eliminar esta pregunta? La acción no se puede deshacer.')) return;
    await withRefresh(() => assessmentsApi.deleteQuestion(initial.id, qid));
  }

  const totalPoints = initial.questions.reduce((acc, q) => acc + q.points, 0);

  return (
    <section className="space-y-6">
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
                <Badge variant={STATUS_VARIANT[initial.status]} dot>
                  {STATUS_LABEL[initial.status]}
                </Badge>
                <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-semibold text-white">
                  Quiz
                </span>
                {initial.lessonId ? (
                  <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-semibold text-white">
                    Vinculado a lección
                  </span>
                ) : (
                  <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-medium text-white/70">
                    Sin lección vinculada
                  </span>
                )}
              </div>
              <h1 className="font-display text-3xl font-bold tracking-tight">{initial.title}</h1>
              {initial.description ? (
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/85">
                  {initial.description}
                </p>
              ) : null}
            </div>
            {initial.status === 'DRAFT' ? (
              <Button onClick={handlePublish} disabled={pending || initial.questions.length === 0}>
                <Icon name="check" size={16} />
                Publicar quiz
              </Button>
            ) : null}
          </div>
        </div>

        {/* Métricas */}
        <div className="grid grid-cols-3 divide-x divide-border-soft border-t border-border bg-surface-2">
          <div className="p-4 text-center">
            <p className="font-display text-2xl font-bold tabular-nums text-text">
              {initial.questions.length}
            </p>
            <p className="text-xs font-medium text-text-muted">
              {initial.questions.length === 1 ? 'pregunta' : 'preguntas'}
            </p>
          </div>
          <div className="p-4 text-center">
            <p className="font-display text-2xl font-bold tabular-nums text-text">{totalPoints}</p>
            <p className="text-xs font-medium text-text-muted">
              {totalPoints === 1 ? 'punto' : 'puntos totales'}
            </p>
          </div>
          <div className="p-4 text-center">
            <p className="font-display text-2xl font-bold tabular-nums text-text">
              {initial.passThreshold}%
            </p>
            <p className="text-xs font-medium text-text-muted">aprobación</p>
          </div>
        </div>
      </Card>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {/* === Configuración === */}
      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
              style={{
                background: 'var(--didacta-info-bg)',
                color: 'var(--didacta-info-fg)',
              }}
            >
              <Icon name="cog" size={18} />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-base">Configuración</CardTitle>
              <CardDescription>Umbral, intentos y comportamiento del quiz.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form action={handleSaveSettings} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="title">Título</Label>
              <Input id="title" name="title" defaultValue={initial.title} required />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="description">Descripción</Label>
              <Textarea
                id="description"
                name="description"
                rows={2}
                defaultValue={initial.description ?? ''}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="passThreshold">Umbral de aprobación (%)</Label>
              <Input
                id="passThreshold"
                name="passThreshold"
                type="number"
                min={0}
                max={100}
                defaultValue={initial.passThreshold}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="maxAttempts">Máx. intentos</Label>
              <Input
                id="maxAttempts"
                name="maxAttempts"
                type="number"
                min={1}
                defaultValue={initial.maxAttempts ?? ''}
                placeholder="Sin límite"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timeLimitMinutes">Límite de tiempo (min)</Label>
              <Input
                id="timeLimitMinutes"
                name="timeLimitMinutes"
                type="number"
                min={1}
                defaultValue={initial.timeLimitMinutes ?? ''}
                placeholder="Sin límite"
              />
            </div>
            <div className="space-y-2 rounded-lg border border-border-soft bg-surface-2 p-3 sm:col-span-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="shuffleQuestions"
                  defaultChecked={initial.shuffleQuestions}
                  className="h-4 w-4 rounded border-border-strong"
                />
                <span className="font-medium text-text">Barajar preguntas</span>
                <span className="text-text-subtle">— cada alumno ve un orden distinto.</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="showFeedback"
                  defaultChecked={initial.showFeedback}
                  className="h-4 w-4 rounded border-border-strong"
                />
                <span className="font-medium text-text">Mostrar feedback al alumno</span>
                <span className="text-text-subtle">— al finalizar el intento.</span>
              </label>
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? 'Guardando…' : 'Guardar configuración'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* === Preguntas === */}
      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
              style={{
                background: 'var(--didacta-info-bg)',
                color: 'var(--didacta-info-fg)',
              }}
            >
              <Icon name="help" size={18} />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-base">Preguntas</CardTitle>
              <CardDescription>
                {initial.questions.length}{' '}
                {initial.questions.length === 1 ? 'pregunta' : 'preguntas'} · {totalPoints}{' '}
                {totalPoints === 1 ? 'punto' : 'puntos'}.
                {initial.questions.length === 0
                  ? ' Para publicar el quiz necesitás al menos una pregunta.'
                  : ''}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {initial.questions.length === 0 ? (
            <div className="rounded-2xl border-2 border-dashed border-border-strong bg-surface-2 px-6 py-10 text-center">
              <div
                aria-hidden="true"
                className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl"
                style={{
                  background: 'var(--didacta-info-bg)',
                  color: 'var(--didacta-info-fg)',
                }}
              >
                <Icon name="help" size={28} />
              </div>
              <h3 className="font-display text-lg font-semibold text-text">
                Empezá añadiendo tu primera pregunta
              </h3>
              <p className="mx-auto mt-1 max-w-md text-sm text-text-muted">
                Tipo de pregunta, enunciado y opciones. Podés mezclar tipos en un mismo quiz.
              </p>
            </div>
          ) : (
            initial.questions.map((q, idx) => (
              <QuestionRow
                key={q.id}
                index={idx}
                question={q}
                pending={pending}
                onDelete={() => handleDeleteQuestion(q.id)}
              />
            ))
          )}
          <NewQuestionForm quizId={initial.id} pending={pending} onAdded={onChange} />
        </CardContent>
      </Card>
    </section>
  );
}

function QuestionRow({
  index,
  question,
  pending,
  onDelete,
}: {
  index: number;
  question: FormadorQuestion;
  pending: boolean;
  onDelete: () => void;
}) {
  const isOpen = question.type === 'SHORT_ANSWER' || question.type === 'LONG_ANSWER';
  const numberLabel = `${index + 1}`.padStart(2, '0');

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <header className="flex flex-wrap items-start gap-3 border-b border-border-soft bg-surface-2 px-4 py-3">
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
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge variant="info" className="font-mono text-[10px] tracking-wider">
              <Icon name={QTYPE_ICON[question.type]} size={11} />
              {QTYPE_LABEL[question.type]}
            </Badge>
            <span className="text-xs tabular-nums text-text-muted">
              {question.points} {question.points === 1 ? 'pt' : 'pts'}
            </span>
          </div>
          <p className="text-sm leading-snug text-text">{question.prompt}</p>
        </div>
        <button
          type="button"
          onClick={onDelete}
          disabled={pending}
          aria-label="Eliminar pregunta"
          title="Eliminar pregunta"
          className="rounded p-1.5 text-text-disabled transition-colors hover:bg-danger-50 hover:text-danger-700 disabled:opacity-50"
        >
          <Icon name="trash" size={16} />
        </button>
      </header>

      <div className="px-4 py-3">
        {question.type === 'FILL_IN_BLANK' ? (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
              Respuestas aceptadas
            </p>
            {question.acceptedAnswers.length === 0 ? (
              <p className="text-sm italic text-warning-700">Ninguna definida.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {question.acceptedAnswers.map((a, i) => (
                  <code
                    key={`${a}-${i}`}
                    className="rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-text"
                  >
                    {a}
                  </code>
                ))}
              </div>
            )}
          </div>
        ) : isOpen ? (
          <div
            className="flex items-center gap-2 rounded-md p-2 text-xs"
            style={{
              background: 'var(--didacta-warn-bg)',
              color: 'var(--didacta-warn-fg)',
            }}
          >
            <Icon name="alert" size={14} />
            <span>Pregunta abierta — corrección manual requerida.</span>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {question.options.map((o) => (
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
                <span className={o.isCorrect ? 'font-medium text-text' : 'text-text-muted'}>
                  {o.label}
                </span>
              </li>
            ))}
          </ul>
        )}
        {question.feedback ? (
          <p className="mt-3 flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-text-muted">
            <Icon name="sparkles" size={12} className="mt-0.5 shrink-0 text-brand-500" />
            <span>
              <strong className="font-semibold text-text">Feedback:</strong> {question.feedback}
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function NewQuestionForm({
  quizId,
  pending,
  onAdded,
}: {
  quizId: string;
  pending: boolean;
  onAdded: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<QuestionType>('SINGLE_CHOICE');
  const [prompt, setPrompt] = useState('');
  const [options, setOptions] = useState<DraftOption[]>([
    { label: '', isCorrect: false },
    { label: '', isCorrect: false },
  ]);
  const [acceptedAnswersText, setAcceptedAnswersText] = useState('');
  const [points, setPoints] = useState('1');
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setType_(next: QuestionType) {
    setType(next);
    if (next === 'TRUE_FALSE') {
      setOptions([
        { label: 'Verdadero', isCorrect: false },
        { label: 'Falso', isCorrect: false },
      ]);
    }
  }

  function updateOption(idx: number, patch: Partial<DraftOption>) {
    setOptions((prev) => {
      const next = prev.map((o, i) => (i === idx ? { ...o, ...patch } : o));
      if (type === 'SINGLE_CHOICE' && patch.isCorrect) {
        return next.map((o, i) => (i === idx ? o : { ...o, isCorrect: false }));
      }
      if (type === 'TRUE_FALSE' && patch.isCorrect) {
        return next.map((o, i) => (i === idx ? o : { ...o, isCorrect: false }));
      }
      return next;
    });
  }

  function addOption() {
    if (type === 'TRUE_FALSE') return;
    setOptions((prev) => [...prev, { label: '', isCorrect: false }]);
  }

  function removeOption(idx: number) {
    if (type === 'TRUE_FALSE' || options.length <= 2) return;
    setOptions((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const acceptedAnswers =
        type === 'FILL_IN_BLANK'
          ? acceptedAnswersText
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : undefined;
      const isOpen = type === 'SHORT_ANSWER' || type === 'LONG_ANSWER';
      await assessmentsApi.addQuestion(quizId, {
        type,
        prompt,
        feedback: feedback || undefined,
        points: Number(points),
        ...(type === 'FILL_IN_BLANK'
          ? { acceptedAnswers: acceptedAnswers ?? [] }
          : isOpen
            ? {}
            : {
                options: options.map((o) => ({ label: o.label, isCorrect: o.isCorrect })),
              }),
      });
      setPrompt('');
      setFeedback('');
      setPoints('1');
      setAcceptedAnswersText('');
      setOptions(
        type === 'TRUE_FALSE'
          ? [
              { label: 'Verdadero', isCorrect: false },
              { label: 'Falso', isCorrect: false },
            ]
          : [
              { label: '', isCorrect: false },
              { label: '', isCorrect: false },
            ],
      );
      setOpen(false);
      await onAdded();
    } catch (err) {
      setError(err instanceof ApiHttpError ? err.message : 'Error al añadir');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border-strong bg-surface-2 px-4 py-4 text-sm font-semibold text-text-muted transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
      >
        <Icon name="plus" size={18} />
        Añadir pregunta
      </button>
    );
  }

  const isOpenType = type === 'SHORT_ANSWER' || type === 'LONG_ANSWER';

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-xl border border-brand-200 bg-brand-50/40 p-4"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-text">
        <Icon name="plus" size={16} />
        Nueva pregunta
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="qtype">Tipo de pregunta</Label>
          <Select
            id="qtype"
            value={type}
            onChange={(e) => setType_(e.target.value as QuestionType)}
          >
            {QUESTION_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="qpoints">Puntos</Label>
          <Input
            id="qpoints"
            type="number"
            min={1}
            value={points}
            onChange={(e) => setPoints(e.target.value)}
            required
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="qprompt">Enunciado</Label>
        <Textarea
          id="qprompt"
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
          placeholder="¿Cuál es la capital de Francia?"
        />
      </div>

      {type === 'FILL_IN_BLANK' ? (
        <div className="space-y-1.5">
          <Label htmlFor="qaccepted">Respuestas aceptadas (una por línea)</Label>
          <Textarea
            id="qaccepted"
            rows={3}
            value={acceptedAnswersText}
            onChange={(e) => setAcceptedAnswersText(e.target.value)}
            placeholder={'París\nParis\nFRANCIA, capital'}
            required
            className="font-mono text-sm"
          />
          <p className="flex items-start gap-1.5 text-xs text-text-subtle">
            <Icon name="sparkles" size={12} className="mt-0.5 shrink-0 text-brand-500" />
            La comparación es insensible a mayúsculas, acentos y espaciado: "Paris" coincidirá con
            "PARÍS".
          </p>
        </div>
      ) : isOpenType ? (
        <div
          className="flex items-start gap-2 rounded-md p-3 text-xs"
          style={{
            background: 'var(--didacta-warn-bg)',
            color: 'var(--didacta-warn-fg)',
          }}
        >
          <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
          <p>
            Este tipo no se auto-corrige. Cuando un alumno envíe el quiz, el intento quedará en
            <strong> PENDING_REVIEW</strong> hasta que lo corrijas manualmente desde el panel de
            pendientes (<code>/formador/correcciones</code>).
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Opciones (marcá las correctas)
          </p>
          {options.map((opt, idx) => (
            <div
              key={idx}
              className={
                opt.isCorrect
                  ? 'flex items-center gap-2 rounded-md border border-success-200 bg-[var(--didacta-success-bg)]/40 px-2 py-1.5'
                  : 'flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5'
              }
            >
              <input
                type={type === 'MULTIPLE_CHOICE' ? 'checkbox' : 'radio'}
                name="correct-marker"
                checked={opt.isCorrect}
                onChange={() => updateOption(idx, { isCorrect: !opt.isCorrect })}
                className="h-4 w-4"
                aria-label={`Marcar opción ${idx + 1} como correcta`}
              />
              <Input
                value={opt.label}
                onChange={(e) => updateOption(idx, { label: e.target.value })}
                placeholder={`Opción ${idx + 1}`}
                required
                disabled={type === 'TRUE_FALSE'}
                className="border-0 bg-transparent shadow-none focus-visible:ring-1"
              />
              {type !== 'TRUE_FALSE' && options.length > 2 ? (
                <button
                  type="button"
                  onClick={() => removeOption(idx)}
                  aria-label={`Quitar opción ${idx + 1}`}
                  className="rounded p-1 text-text-disabled hover:bg-danger-50 hover:text-danger-700"
                >
                  <Icon name="trash" size={14} />
                </button>
              ) : null}
            </div>
          ))}
          {type !== 'TRUE_FALSE' && options.length < 10 ? (
            <Button type="button" variant="ghost" size="sm" onClick={addOption}>
              <Icon name="plus" size={14} />
              Añadir opción
            </Button>
          ) : null}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="qfeedback">Feedback (opcional)</Label>
        <Input
          id="qfeedback"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Pista o explicación que verá el alumno tras responder"
        />
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-t border-brand-200 pt-3">
        <Button type="submit" size="sm" disabled={submitting || pending}>
          {submitting ? 'Añadiendo…' : 'Añadir pregunta'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setOpen(false)}
          disabled={submitting}
        >
          Cancelar
        </Button>
      </div>
    </form>
  );
}
