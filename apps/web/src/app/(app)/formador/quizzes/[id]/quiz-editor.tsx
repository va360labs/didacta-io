'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, type IconName } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import {
  assessmentsApi,
  type FormadorQuestion,
  type QuestionType,
  type QuizFormadorView,
  type QuizStatus,
} from '@/modules/assessments';

const QUESTION_TYPES: QuestionType[] = [
  'SINGLE_CHOICE',
  'MULTIPLE_CHOICE',
  'TRUE_FALSE',
  'FILL_IN_BLANK',
  'SHORT_ANSWER',
  'LONG_ANSWER',
];

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
  const t = useTranslations('formadorAula');
  const tErrors = useTranslations('errors');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function withRefresh(action: () => Promise<unknown>) {
    setError(null);
    setPending(true);
    try {
      await action();
      await onChange();
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('quizEditor.unexpectedError'),
      );
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
    if (!confirm(t('quizEditor.confirmDeleteQuestion'))) return;
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
                  {t(`quizStatus.${initial.status}`)}
                </Badge>
                <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-semibold text-white">
                  {t('quizEditor.quizBadge')}
                </span>
                {initial.lessonId ? (
                  <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-semibold text-white">
                    {t('quizEditor.linkedToLesson')}
                  </span>
                ) : (
                  <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-medium text-white/70">
                    {t('quizEditor.noLinkedLesson')}
                  </span>
                )}
              </div>
              <h1 className="font-display text-3xl font-bold tracking-tight text-white">
                {initial.title}
              </h1>
              {initial.description ? (
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/85">
                  {initial.description}
                </p>
              ) : null}
            </div>
            {initial.status === 'DRAFT' ? (
              <Button onClick={handlePublish} disabled={pending || initial.questions.length === 0}>
                <Icon name="check" size={16} />
                {t('quizEditor.publishQuiz')}
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
              {t('quizEditor.questionsMetric', { count: initial.questions.length })}
            </p>
          </div>
          <div className="p-4 text-center">
            <p className="font-display text-2xl font-bold tabular-nums text-text">{totalPoints}</p>
            <p className="text-xs font-medium text-text-muted">
              {t('quizEditor.pointsMetric', { count: totalPoints })}
            </p>
          </div>
          <div className="p-4 text-center">
            <p className="font-display text-2xl font-bold tabular-nums text-text">
              {initial.passThreshold}%
            </p>
            <p className="text-xs font-medium text-text-muted">{t('quizEditor.passMetric')}</p>
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
              <CardTitle className="text-base">{t('quizEditor.settingsTitle')}</CardTitle>
              <CardDescription>{t('quizEditor.settingsDescription')}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form action={handleSaveSettings} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="title">{t('quizEditor.titleLabel')}</Label>
              <Input id="title" name="title" defaultValue={initial.title} required />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="description">{t('quizEditor.descriptionLabel')}</Label>
              <Textarea
                id="description"
                name="description"
                rows={2}
                defaultValue={initial.description ?? ''}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="passThreshold">{t('quizEditor.passThresholdLabel')}</Label>
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
              <Label htmlFor="maxAttempts">{t('quizEditor.maxAttemptsLabel')}</Label>
              <Input
                id="maxAttempts"
                name="maxAttempts"
                type="number"
                min={1}
                defaultValue={initial.maxAttempts ?? ''}
                placeholder={t('quizEditor.noLimitPlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timeLimitMinutes">{t('quizEditor.timeLimitLabel')}</Label>
              <Input
                id="timeLimitMinutes"
                name="timeLimitMinutes"
                type="number"
                min={1}
                defaultValue={initial.timeLimitMinutes ?? ''}
                placeholder={t('quizEditor.noLimitPlaceholder')}
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
                <span className="font-medium text-text">{t('quizEditor.shuffleQuestions')}</span>
                <span className="text-text-subtle">{t('quizEditor.shuffleQuestionsHint')}</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="showFeedback"
                  defaultChecked={initial.showFeedback}
                  className="h-4 w-4 rounded border-border-strong"
                />
                <span className="font-medium text-text">{t('quizEditor.showFeedback')}</span>
                <span className="text-text-subtle">{t('quizEditor.showFeedbackHint')}</span>
              </label>
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? t('quizEditor.saving') : t('quizEditor.saveSettings')}
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
              <CardTitle className="text-base">{t('quizEditor.questionsTitle')}</CardTitle>
              <CardDescription>
                {t('quizEditor.questionsSummary', {
                  questions: initial.questions.length,
                  points: totalPoints,
                })}
                {initial.questions.length === 0 ? ` ${t('quizEditor.needOneQuestion')}` : ''}
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
                {t('quizEditor.emptyTitle')}
              </h3>
              <p className="mx-auto mt-1 max-w-md text-sm text-text-muted">
                {t('quizEditor.emptyHint')}
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
  const t = useTranslations('formadorAula');
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
              {t(`qtype.${question.type}`)}
            </Badge>
            <span className="text-xs tabular-nums text-text-muted">
              {t('quizEditor.pointsShort', { points: question.points })}
            </span>
          </div>
          <p className="text-sm leading-snug text-text">{question.prompt}</p>
        </div>
        <button
          type="button"
          onClick={onDelete}
          disabled={pending}
          aria-label={t('quizEditor.deleteQuestion')}
          title={t('quizEditor.deleteQuestion')}
          className="rounded p-1.5 text-text-disabled transition-colors hover:bg-danger-50 hover:text-danger-700 disabled:opacity-50"
        >
          <Icon name="trash" size={16} />
        </button>
      </header>

      <div className="px-4 py-3">
        {question.type === 'FILL_IN_BLANK' ? (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
              {t('quizEditor.acceptedAnswersTitle')}
            </p>
            {question.acceptedAnswers.length === 0 ? (
              <p className="text-sm italic text-warning-700">{t('quizEditor.noneDefined')}</p>
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
            <span>{t('quizEditor.openQuestionNotice')}</span>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {question.options.map((o) => (
              <li key={o.id} className="flex items-center gap-2.5 text-sm">
                {o.isCorrect ? (
                  <span
                    aria-label={t('quizEditor.correctOption')}
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
                    aria-label={t('quizEditor.incorrectOption')}
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
              <strong className="font-semibold text-text">{t('quizEditor.feedbackTitle')}</strong>{' '}
              {question.feedback}
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
  const t = useTranslations('formadorAula');
  const tErrors = useTranslations('errors');
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
        { label: t('quizEditor.trueLabel'), isCorrect: false },
        { label: t('quizEditor.falseLabel'), isCorrect: false },
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
              { label: t('quizEditor.trueLabel'), isCorrect: false },
              { label: t('quizEditor.falseLabel'), isCorrect: false },
            ]
          : [
              { label: '', isCorrect: false },
              { label: '', isCorrect: false },
            ],
      );
      setOpen(false);
      await onAdded();
    } catch (err) {
      setError(
        err instanceof ApiHttpError ? apiErrorMessage(err, tErrors) : t('quizEditor.addError'),
      );
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
        {t('quizEditor.addQuestion')}
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
        {t('quizEditor.newQuestion')}
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="qtype">{t('quizEditor.questionTypeLabel')}</Label>
          <Select
            id="qtype"
            value={type}
            onChange={(e) => setType_(e.target.value as QuestionType)}
          >
            {QUESTION_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`qtypeOption.${value}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="qpoints">{t('quizEditor.pointsLabel')}</Label>
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
        <Label htmlFor="qprompt">{t('quizEditor.promptLabel')}</Label>
        <Textarea
          id="qprompt"
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
          placeholder={t('quizEditor.promptPlaceholder')}
        />
      </div>

      {type === 'FILL_IN_BLANK' ? (
        <div className="space-y-1.5">
          <Label htmlFor="qaccepted">{t('quizEditor.acceptedAnswersLabel')}</Label>
          <Textarea
            id="qaccepted"
            rows={3}
            value={acceptedAnswersText}
            onChange={(e) => setAcceptedAnswersText(e.target.value)}
            placeholder={t('quizEditor.acceptedAnswersPlaceholder')}
            required
            className="font-mono text-sm"
          />
          <p className="flex items-start gap-1.5 text-xs text-text-subtle">
            <Icon name="sparkles" size={12} className="mt-0.5 shrink-0 text-brand-500" />
            {t('quizEditor.acceptedAnswersHint')}
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
            {t.rich('quizEditor.openTypeWarning', {
              strong: (chunks) => <strong>{chunks}</strong>,
              code: (chunks) => <code>{chunks}</code>,
            })}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            {t('quizEditor.optionsTitle')}
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
                aria-label={t('quizEditor.markOptionCorrect', { number: idx + 1 })}
              />
              <Input
                value={opt.label}
                onChange={(e) => updateOption(idx, { label: e.target.value })}
                placeholder={t('quizEditor.optionPlaceholder', { number: idx + 1 })}
                required
                disabled={type === 'TRUE_FALSE'}
                className="border-0 bg-transparent shadow-none focus-visible:ring-1"
              />
              {type !== 'TRUE_FALSE' && options.length > 2 ? (
                <button
                  type="button"
                  onClick={() => removeOption(idx)}
                  aria-label={t('quizEditor.removeOption', { number: idx + 1 })}
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
              {t('quizEditor.addOption')}
            </Button>
          ) : null}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="qfeedback">{t('quizEditor.feedbackLabel')}</Label>
        <Input
          id="qfeedback"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder={t('quizEditor.feedbackPlaceholder')}
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
          {submitting ? t('quizEditor.adding') : t('quizEditor.addQuestion')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setOpen(false)}
          disabled={submitting}
        >
          {t('quizEditor.cancel')}
        </Button>
      </div>
    </form>
  );
}
