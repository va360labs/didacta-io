'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import nextDynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon, type IconName } from '@/components/icon';

// tiptap (~200KB) solo se baja al abrir el editor de una lección.
const RichTextEditor = nextDynamic(
  () => import('@/components/rich-text-editor').then((m) => m.RichTextEditor),
  { ssr: false, loading: () => <div className="skeleton h-40 w-full rounded-md" /> },
);
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate } from '@/lib/i18n/format';
import { assessmentsApi } from '@/modules/assessments';
import { coursesApi, type CourseLesson, type LessonType } from '@/lib/courses';
import { scormApi, type ScormPackageMetadata } from '@/lib/scorm';
import { normalizeTranscript } from '@/lib/transcript';

/** ISO → valor de `<input type="datetime-local">` en hora LOCAL (YYYY-MM-DDTHH:mm). */
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Labels y textos de ayuda por tipo en el catálogo `formadorCursos`
// (`lessonType.*` y `lessonHelp.*`).
const TYPE_ICON: Record<LessonType, IconName> = {
  VIDEO: 'play',
  HTML: 'code',
  PDF: 'file',
  TEXT: 'book',
  QUIZ: 'help',
  SCORM: 'package',
};

export function LessonContentEditor({
  lesson,
  onUpdated,
  onCancel,
}: {
  lesson: CourseLesson;
  onUpdated: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const t = useTranslations('formadorCursos');
  const tErrors = useTranslations('errors');
  const content = (lesson.content ?? {}) as Record<string, unknown>;
  const [title, setTitle] = useState(lesson.title);
  const [duration, setDuration] = useState<string>(
    lesson.durationMinutes ? String(lesson.durationMinutes) : '',
  );
  const [videoUrl, setVideoUrl] = useState(
    typeof content['videoUrl'] === 'string' ? content['videoUrl'] : '',
  );
  const [pdfUrl, setPdfUrl] = useState(
    typeof content['pdfUrl'] === 'string' ? content['pdfUrl'] : '',
  );
  const [resources, setResources] = useState(
    typeof content['resources'] === 'string' ? content['resources'] : '',
  );
  const [html, setHtml] = useState(typeof content['html'] === 'string' ? content['html'] : '');
  const [transcript, setTranscript] = useState(
    typeof content['transcript'] === 'string' ? content['transcript'] : '',
  );
  const [transcriptAviso, setTranscriptAviso] = useState<string | null>(null);
  const [text, setText] = useState(typeof content['text'] === 'string' ? content['text'] : '');
  const [quizId, setQuizId] = useState(
    typeof content['quizId'] === 'string' ? content['quizId'] : '',
  );
  const [publishAt, setPublishAt] = useState<string>(
    lesson.publishAt ? isoToLocalInput(lesson.publishAt) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function buildContent(): Record<string, unknown> {
    switch (lesson.type) {
      case 'VIDEO':
        // `html`: contenido complementario opcional que el player pinta debajo
        // del vídeo (texto enriquecido). Lo guardamos siempre (vacío incluido)
        // para poder borrarlo desde el editor.
        // `transcript`: lo que el tutor IA usa para responder sobre esta clase.
        // No se muestra al alumno; al guardar, la lección se reindexa sola.
        return { videoUrl, resources, html, transcript };
      case 'PDF':
        return { pdfUrl };
      case 'HTML':
        return { html };
      case 'TEXT':
        return { text };
      case 'QUIZ':
        return { quizId };
      case 'SCORM':
        return content;
    }
  }

  async function handleSave() {
    setPending(true);
    setError(null);
    try {
      await coursesApi.updateLesson(lesson.id, {
        title,
        content: buildContent(),
        durationMinutes: duration ? Number(duration) : null,
        publishAt: publishAt ? new Date(publishAt).toISOString() : null,
      });
      await onUpdated();
      onCancel();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorSave'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 border-b border-border-soft pb-3">
        <span
          aria-hidden="true"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md"
          style={{
            background: 'var(--didacta-info-bg)',
            color: 'var(--didacta-info-fg)',
          }}
        >
          <Icon name={TYPE_ICON[lesson.type]} size={14} />
        </span>
        <p className="label-uppercase text-text-muted">
          {t('editingType', { type: t(`lessonType.${lesson.type}`) })}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`title-${lesson.id}`}>{t('titleLabel')}</Label>
          <Input
            id={`title-${lesson.id}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`duration-${lesson.id}`}>{t('durationLabel')}</Label>
          <Input
            id={`duration-${lesson.id}`}
            type="number"
            min={1}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            placeholder="—"
          />
        </div>
      </div>

      {lesson.type === 'VIDEO' && (
        <div className="space-y-1.5">
          <Label htmlFor={`videoUrl-${lesson.id}`}>{t('videoUrlLabel')}</Label>
          <Input
            id={`videoUrl-${lesson.id}`}
            type="url"
            value={videoUrl}
            onChange={(e) => setVideoUrl(e.target.value)}
            placeholder={t('videoUrlPlaceholder')}
          />
          <p className="text-xs text-text-subtle">
            {t.rich('videoUrlHelp', { code: (chunks) => <code>{chunks}</code> })}
          </p>

          <div className="space-y-1.5 pt-2">
            <Label htmlFor={`resources-${lesson.id}`}>{t('resourcesLabel')}</Label>
            <Textarea
              id={`resources-${lesson.id}`}
              rows={6}
              value={resources}
              onChange={(e) => setResources(e.target.value)}
              placeholder={t('resourcesPlaceholder')}
              className="font-mono text-xs"
            />
            <p className="text-xs text-text-subtle">
              {t.rich('resourcesHelp', { code: (chunks) => <code>{chunks}</code> })}
            </p>
          </div>

          <div className="space-y-1.5 pt-2">
            <Label htmlFor={`html-${lesson.id}`}>{t('htmlBelowLabel')}</Label>
            <RichTextEditor
              value={html}
              onChange={setHtml}
              ariaLabel={t('htmlBelowAria')}
              placeholder={t('htmlBelowPlaceholder')}
            />
            <p className="text-xs text-text-subtle">{t('htmlBelowHelp')}</p>
          </div>

          <div className="space-y-1.5 pt-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor={`transcript-${lesson.id}`}>{t('transcriptLabel')}</Label>
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-brand hover:underline">
                <Icon name="file" className="h-3.5 w-3.5" />
                {t('transcriptUpload')}
                <input
                  type="file"
                  accept=".srt,.vtt,.txt,text/plain"
                  className="sr-only"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    const crudo = await file.text();
                    const r = normalizeTranscript(crudo);
                    if (!r.text) {
                      setTranscriptAviso(t('transcriptEmpty'));
                      return;
                    }
                    setTranscript(r.text);
                    setTranscriptAviso(
                      r.formato === 'subtitulos'
                        ? t('transcriptWithTimestamps', { name: file.name, count: r.bloques })
                        : t('transcriptPlain', { name: file.name }),
                    );
                  }}
                />
              </label>
            </div>
            <Textarea
              id={`transcript-${lesson.id}`}
              rows={8}
              value={transcript}
              onChange={(e) => {
                setTranscript(e.target.value);
                setTranscriptAviso(null);
              }}
              placeholder={t('transcriptPlaceholder')}
              className="font-mono text-xs"
            />
            {transcriptAviso ? (
              <p className="text-xs font-medium text-brand">{transcriptAviso}</p>
            ) : null}
            <p className="text-xs text-text-subtle">
              {t.rich('transcriptHelp', { code: (chunks) => <code>{chunks}</code> })}
              {transcript ? (
                <>
                  {' '}
                  {t.rich('transcriptCharCount', {
                    strong: (chunks) => <strong>{chunks}</strong>,
                    count: transcript.length,
                  })}
                </>
              ) : (
                <> {t('transcriptInvisible')}</>
              )}
            </p>
          </div>
        </div>
      )}

      {lesson.type === 'PDF' && (
        <div className="space-y-1.5">
          <Label htmlFor={`pdfUrl-${lesson.id}`}>{t('pdfUrlLabel')}</Label>
          <Input
            id={`pdfUrl-${lesson.id}`}
            type="url"
            value={pdfUrl}
            onChange={(e) => setPdfUrl(e.target.value)}
            placeholder={t('pdfUrlPlaceholder')}
          />
        </div>
      )}

      {lesson.type === 'HTML' && (
        <div className="space-y-1.5">
          <Label htmlFor={`html-${lesson.id}`}>{t('htmlLabel')}</Label>
          <Textarea
            id={`html-${lesson.id}`}
            rows={8}
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            placeholder={t('htmlPlaceholder')}
            className="font-mono text-xs"
          />
          <p className="text-xs text-text-subtle">{t('htmlHelp')}</p>
        </div>
      )}

      {lesson.type === 'TEXT' && (
        <div className="space-y-1.5">
          <Label htmlFor={`text-${lesson.id}`}>{t('textLabel')}</Label>
          <Textarea
            id={`text-${lesson.id}`}
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('textPlaceholder')}
          />
        </div>
      )}

      {lesson.type === 'QUIZ' && (
        <QuizLink lessonId={lesson.id} lessonTitle={title} quizId={quizId} setQuizId={setQuizId} />
      )}

      {lesson.type === 'SCORM' && <ScormUploader lessonId={lesson.id} />}

      <div className="space-y-1.5 border-t border-border-soft pt-4">
        <Label htmlFor={`publishAt-${lesson.id}`}>{t('publishAtLabel')}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={`publishAt-${lesson.id}`}
            type="datetime-local"
            value={publishAt}
            onChange={(e) => setPublishAt(e.target.value)}
            className="w-auto"
          />
          {publishAt ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setPublishAt('')}>
              {t('remove')}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-text-subtle">{t('publishAtHelp')}</p>
      </div>

      <div className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-text-muted">
        <Icon name="sparkles" size={14} className="mt-0.5 shrink-0 text-brand-500" />
        <p>{t(`lessonHelp.${lesson.type}`)}</p>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-t border-border-soft pt-3">
        <Button size="sm" onClick={handleSave} disabled={pending}>
          {pending ? t('saving') : t('saveChanges')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}

function QuizLink({
  lessonId,
  lessonTitle,
  quizId,
  setQuizId,
}: {
  lessonId: string;
  lessonTitle: string;
  quizId: string;
  setQuizId: (v: string) => void;
}) {
  const t = useTranslations('formadorCursos');
  const tErrors = useTranslations('errors');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function handleCreate() {
    setCreating(true);
    setCreateError(null);
    try {
      const quiz = await assessmentsApi.createQuiz({
        lessonId,
        title: lessonTitle || t('quizNewTitle'),
      });
      setQuizId(quiz.id);
    } catch (e) {
      setCreateError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorCreate'));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={`quizId-${lessonId}`}>{t('quizLinkedLabel')}</Label>
      {quizId ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2">
          <span
            aria-hidden="true"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md"
            style={{
              background: 'var(--didacta-info-bg)',
              color: 'var(--didacta-info-fg)',
            }}
          >
            <Icon name="help" size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-text">{t('quizLinkedLabel')}</p>
            <code className="block truncate font-mono text-xs text-text-subtle">{quizId}</code>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href={`/formador/quizzes/${quizId}` as never}>
              <Icon name="edit" size={13} />
              {t('edit')}
            </Link>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setQuizId('')}
            aria-label={t('quizUnlinkAria')}
          >
            {t('quizUnlink')}
          </Button>
        </div>
      ) : (
        <div className="space-y-2 rounded-lg border-2 border-dashed border-border-strong bg-surface-2 p-4">
          <p className="text-sm text-text-muted">{t('quizEmpty')}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={handleCreate} disabled={creating}>
              <Icon name="plus" size={14} />
              {creating ? t('quizCreating') : t('quizCreate')}
            </Button>
            <Input
              id={`quizId-${lessonId}`}
              value={quizId}
              onChange={(e) => setQuizId(e.target.value)}
              placeholder={t('quizIdPlaceholder')}
              className="flex-1 min-w-[240px]"
            />
          </div>
        </div>
      )}
      {createError ? (
        <p role="alert" className="text-sm text-danger-700">
          {createError}
        </p>
      ) : null}
    </div>
  );
}

function ScormUploader({ lessonId }: { lessonId: string }) {
  const t = useTranslations('formadorCursos');
  const tErrors = useTranslations('errors');
  const [metadata, setMetadata] = useState<ScormPackageMetadata | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    scormApi
      .get(lessonId)
      .then((m) => {
        if (!cancelled) setMetadata(m);
      })
      .catch(() => {
        // 404 esperado si todavía no se subió ningún paquete.
      });
    return () => {
      cancelled = true;
    };
  }, [lessonId]);

  async function handleUpload(file: File) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const buf = await file.arrayBuffer();
      const data = bufferToBase64(buf);
      const res = await scormApi.upload(lessonId, { data, filename: file.name });
      setMetadata(res);
      setSuccess(t('scormUploaded', { size: (res.size / (1024 * 1024)).toFixed(1) }));
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('errorUploadScorm'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Label htmlFor={`scorm-${lessonId}`}>{t('scormLabel')}</Label>

      {metadata ? (
        <div className="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-surface-2 p-3">
          <span
            aria-hidden="true"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-lg"
            style={{
              background: 'var(--didacta-info-bg)',
              color: 'var(--didacta-info-fg)',
            }}
          >
            <Icon name="package" size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-text">SCORM {metadata.version}</p>
            <p className="mt-0.5 truncate text-xs text-text-muted">
              {t.rich('scormEntry', {
                code: (chunks) => <code className="font-mono">{chunks}</code>,
                path: metadata.entryPath,
              })}
            </p>
            <p className="text-xs text-text-subtle tabular-nums">
              {t('scormMeta', {
                size: (metadata.size / (1024 * 1024)).toFixed(1),
                date: formatDate(metadata.uploadedAt, {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                }),
              })}
            </p>
          </div>
        </div>
      ) : null}

      <label
        className={
          busy
            ? 'block cursor-wait rounded-lg border-2 border-dashed border-border-strong bg-surface-2 p-6 text-center opacity-60'
            : 'block cursor-pointer rounded-lg border-2 border-dashed border-border-strong bg-surface-2 p-6 text-center transition-colors hover:border-brand-300 hover:bg-brand-50'
        }
        htmlFor={`scorm-${lessonId}`}
      >
        <div className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-lg text-text-muted">
          <Icon name="package" size={24} />
        </div>
        <p className="text-sm font-semibold text-text">
          {busy ? t('scormUploading') : metadata ? t('scormReplace') : t('scormUpload')}
        </p>
        <p className="mt-1 text-xs text-text-muted">{t('scormDropHelp')}</p>
        <input
          id={`scorm-${lessonId}`}
          type="file"
          accept=".zip,application/zip"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleUpload(file);
          }}
          className="sr-only"
        />
      </label>

      {success ? (
        <div
          className="flex items-center gap-2 rounded-md p-2 text-xs"
          style={{
            background: 'var(--didacta-success-bg)',
            color: 'var(--didacta-success-fg)',
          }}
        >
          <Icon name="check" size={14} />
          {success}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-danger-100 bg-danger-50 p-2 text-xs text-danger-700">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}
