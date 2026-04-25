'use client';

import { useState } from 'react';
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
} from '@/lib/assessments';

const QUESTION_TYPES: { value: QuestionType; label: string }[] = [
  { value: 'SINGLE_CHOICE', label: 'Opción única' },
  { value: 'MULTIPLE_CHOICE', label: 'Opciones múltiples' },
  { value: 'TRUE_FALSE', label: 'Verdadero / Falso' },
  { value: 'FILL_IN_BLANK', label: 'Rellenar el hueco' },
];

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
    await withRefresh(() => assessmentsApi.deleteQuestion(initial.id, qid));
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{initial.title}</h1>
          <p className="mt-1 text-sm text-neutral-500">
            id: <code className="text-xs">{initial.id}</code>
            {initial.lessonId ? ' · vinculado a lección' : ' · sin lección vinculada'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`rounded px-2 py-1 text-xs font-medium ${
              initial.status === 'PUBLISHED'
                ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                : initial.status === 'DRAFT'
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                  : 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300'
            }`}
          >
            {initial.status}
          </span>
          {initial.status === 'DRAFT' ? (
            <Button onClick={handlePublish} disabled={pending || initial.questions.length === 0}>
              Publicar
            </Button>
          ) : null}
        </div>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuración</CardTitle>
          <CardDescription>Umbral, intentos y comportamiento del quiz.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={handleSaveSettings} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="title">Título</Label>
              <Input id="title" name="title" defaultValue={initial.title} required />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="description">Descripción</Label>
              <Textarea
                id="description"
                name="description"
                rows={2}
                defaultValue={initial.description ?? ''}
              />
            </div>
            <div className="space-y-1">
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
            <div className="space-y-1">
              <Label htmlFor="maxAttempts">Máx. intentos (vacío = sin límite)</Label>
              <Input
                id="maxAttempts"
                name="maxAttempts"
                type="number"
                min={1}
                defaultValue={initial.maxAttempts ?? ''}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="timeLimitMinutes">Límite de tiempo (min — vacío = sin límite)</Label>
              <Input
                id="timeLimitMinutes"
                name="timeLimitMinutes"
                type="number"
                min={1}
                defaultValue={initial.timeLimitMinutes ?? ''}
              />
            </div>
            <div className="flex items-center gap-4 sm:col-span-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="shuffleQuestions"
                  defaultChecked={initial.shuffleQuestions}
                />
                Barajar preguntas
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="showFeedback" defaultChecked={initial.showFeedback} />
                Mostrar feedback al alumno
              </label>
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" size="sm" disabled={pending}>
                Guardar configuración
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Preguntas</CardTitle>
          <CardDescription>
            {initial.questions.length} pregunta{initial.questions.length === 1 ? '' : 's'}.
            {initial.questions.length === 0
              ? ' Para publicar el quiz necesitas al menos una pregunta.'
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {initial.questions.map((q) => (
            <QuestionRow
              key={q.id}
              question={q}
              pending={pending}
              onDelete={() => handleDeleteQuestion(q.id)}
            />
          ))}
          <NewQuestionForm quizId={initial.id} pending={pending} onAdded={onChange} />
        </CardContent>
      </Card>
    </section>
  );
}

function QuestionRow({
  question,
  pending,
  onDelete,
}: {
  question: FormadorQuestion;
  pending: boolean;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">
            <span className="mr-2 inline-block rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
              {question.type}
            </span>
            {question.prompt}
          </p>
          <p className="text-xs text-neutral-500">{question.points} pt(s)</p>
        </div>
        <button
          type="button"
          onClick={onDelete}
          disabled={pending}
          className="text-xs text-red-600 underline decoration-dotted hover:decoration-solid"
        >
          Eliminar
        </button>
      </div>
      {question.type === 'FILL_IN_BLANK' ? (
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          Respuestas aceptadas:{' '}
          {question.acceptedAnswers.length === 0 ? (
            <span className="text-amber-600">ninguna</span>
          ) : (
            question.acceptedAnswers.map((a, i) => (
              <span
                key={`${a}-${i}`}
                className="mr-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs dark:bg-neutral-800"
              >
                {a}
              </span>
            ))
          )}
        </p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {question.options.map((o) => (
            <li key={o.id} className="flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  o.isCorrect ? 'bg-green-500' : 'bg-neutral-300 dark:bg-neutral-700'
                }`}
                aria-label={o.isCorrect ? 'correcta' : 'incorrecta'}
              />
              <span>{o.label}</span>
            </li>
          ))}
        </ul>
      )}
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
      await assessmentsApi.addQuestion(quizId, {
        type,
        prompt,
        feedback: feedback || undefined,
        points: Number(points),
        ...(type === 'FILL_IN_BLANK'
          ? { acceptedAnswers: acceptedAnswers ?? [] }
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
      await onAdded();
    } catch (err) {
      setError(err instanceof ApiHttpError ? err.message : 'Error al añadir');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-md border border-dashed border-neutral-300 p-4 dark:border-neutral-700"
    >
      <p className="text-sm font-medium">Añadir pregunta</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="qtype">Tipo</Label>
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
        <div className="space-y-1">
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
      <div className="space-y-1">
        <Label htmlFor="qprompt">Enunciado</Label>
        <Textarea
          id="qprompt"
          rows={2}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
        />
      </div>
      {type === 'FILL_IN_BLANK' ? (
        <div className="space-y-1">
          <Label htmlFor="qaccepted">Respuestas aceptadas (una por línea)</Label>
          <Textarea
            id="qaccepted"
            rows={3}
            value={acceptedAnswersText}
            onChange={(e) => setAcceptedAnswersText(e.target.value)}
            placeholder={'París\nParis\nFRANCIA, capital'}
            required
          />
          <p className="text-xs text-neutral-500">
            La comparación es insensible a mayúsculas, acentos y espaciado: "Paris" coincidirá con
            "PARÍS".
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wider text-neutral-500">
            Opciones (marca las correctas)
          </p>
          {options.map((opt, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                type={type === 'MULTIPLE_CHOICE' ? 'checkbox' : 'radio'}
                name="correct-marker"
                checked={opt.isCorrect}
                onChange={() => updateOption(idx, { isCorrect: !opt.isCorrect })}
              />
              <Input
                value={opt.label}
                onChange={(e) => updateOption(idx, { label: e.target.value })}
                placeholder={`Opción ${idx + 1}`}
                required
                disabled={type === 'TRUE_FALSE'}
              />
              {type !== 'TRUE_FALSE' && options.length > 2 ? (
                <button
                  type="button"
                  onClick={() => removeOption(idx)}
                  className="text-xs text-red-600 underline decoration-dotted"
                >
                  Quitar
                </button>
              ) : null}
            </div>
          ))}
          {type !== 'TRUE_FALSE' && options.length < 10 ? (
            <Button type="button" variant="ghost" size="sm" onClick={addOption}>
              + opción
            </Button>
          ) : null}
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor="qfeedback">Feedback (opcional)</Label>
        <Input
          id="qfeedback"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Pista o explicación que verá el alumno"
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="sm" disabled={submitting || pending}>
        {submitting ? 'Añadiendo…' : 'Añadir pregunta'}
      </Button>
    </form>
  );
}
