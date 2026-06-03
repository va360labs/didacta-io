'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon, type IconName } from '@/components/icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { assessmentsApi } from '@/modules/assessments';
import { coursesApi, type CourseLesson, type LessonType } from '@/lib/courses';
import { scormApi, type ScormPackageMetadata } from '@/lib/scorm';

const HELP_BY_TYPE: Record<LessonType, string> = {
  VIDEO: 'URL del vídeo (mp4, webm, m3u8). Ideal: hosteado en MinIO/Hetzner.',
  HTML: 'HTML inline que se renderiza en el player. Útil para slides o microcopy.',
  PDF: 'URL del PDF. Se muestra en iframe a 70dvh.',
  TEXT: 'Texto plano largo. Se preservan saltos de línea.',
  QUIZ: 'Crea un nuevo quiz o vincula uno existente por ID. El editor del quiz vive en /formador/quizzes/<id>.',
  SCORM:
    'Sube el ZIP del paquete SCORM 1.2 / 2004. El sistema lo descomprime, parsea imsmanifest.xml y lo sirve por iframe.',
};

const TYPE_ICON: Record<LessonType, IconName> = {
  VIDEO: 'play',
  HTML: 'code',
  PDF: 'file',
  TEXT: 'book',
  QUIZ: 'help',
  SCORM: 'package',
};

const TYPE_LABEL: Record<LessonType, string> = {
  VIDEO: 'Vídeo',
  HTML: 'HTML',
  PDF: 'PDF',
  TEXT: 'Texto',
  QUIZ: 'Quiz',
  SCORM: 'SCORM',
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
  const [html, setHtml] = useState(typeof content['html'] === 'string' ? content['html'] : '');
  const [text, setText] = useState(typeof content['text'] === 'string' ? content['text'] : '');
  const [quizId, setQuizId] = useState(
    typeof content['quizId'] === 'string' ? content['quizId'] : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function buildContent(): Record<string, unknown> {
    switch (lesson.type) {
      case 'VIDEO':
        return { videoUrl };
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
      });
      await onUpdated();
      onCancel();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'Error al guardar');
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
        <p className="label-uppercase text-text-muted">Editando · {TYPE_LABEL[lesson.type]}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`title-${lesson.id}`}>Título</Label>
          <Input
            id={`title-${lesson.id}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`duration-${lesson.id}`}>Duración (min)</Label>
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
          <Label htmlFor={`videoUrl-${lesson.id}`}>URL del vídeo</Label>
          <Input
            id={`videoUrl-${lesson.id}`}
            type="url"
            value={videoUrl}
            onChange={(e) => setVideoUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=… o https://tu-cdn/leccion.mp4"
          />
          <p className="text-xs text-text-subtle">
            Acepta enlaces de YouTube (con o sin timestamp <code>t=</code>) y URLs directas a
            archivos <code>.mp4</code> / <code>.webm</code> / <code>.m3u8</code>. YouTube se embebe
            con dominio privacy-enhanced (<code>youtube-nocookie.com</code>).
          </p>
        </div>
      )}

      {lesson.type === 'PDF' && (
        <div className="space-y-1.5">
          <Label htmlFor={`pdfUrl-${lesson.id}`}>URL del PDF</Label>
          <Input
            id={`pdfUrl-${lesson.id}`}
            type="url"
            value={pdfUrl}
            onChange={(e) => setPdfUrl(e.target.value)}
            placeholder="https://docs.ejemplo.com/material.pdf"
          />
        </div>
      )}

      {lesson.type === 'HTML' && (
        <div className="space-y-1.5">
          <Label htmlFor={`html-${lesson.id}`}>HTML</Label>
          <Textarea
            id={`html-${lesson.id}`}
            rows={8}
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            placeholder="<p>Tu contenido en HTML…</p>"
            className="font-mono text-xs"
          />
          <p className="text-xs text-text-subtle">
            El HTML se sanitiza en el servidor. Etiquetas seguras permitidas (p, h2-h6, ul, ol, li,
            a, img, strong, em, code, pre).
          </p>
        </div>
      )}

      {lesson.type === 'TEXT' && (
        <div className="space-y-1.5">
          <Label htmlFor={`text-${lesson.id}`}>Texto</Label>
          <Textarea
            id={`text-${lesson.id}`}
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Escribe el contenido de la lección…"
          />
        </div>
      )}

      {lesson.type === 'QUIZ' && (
        <QuizLink lessonId={lesson.id} lessonTitle={title} quizId={quizId} setQuizId={setQuizId} />
      )}

      {lesson.type === 'SCORM' && <ScormUploader lessonId={lesson.id} />}

      <div className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-text-muted">
        <Icon name="sparkles" size={14} className="mt-0.5 shrink-0 text-brand-500" />
        <p>{HELP_BY_TYPE[lesson.type]}</p>
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
          {pending ? 'Guardando…' : 'Guardar cambios'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
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
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function handleCreate() {
    setCreating(true);
    setCreateError(null);
    try {
      const quiz = await assessmentsApi.createQuiz({
        lessonId,
        title: lessonTitle || 'Quiz nuevo',
      });
      setQuizId(quiz.id);
    } catch (e) {
      setCreateError(e instanceof ApiHttpError ? e.message : 'Error al crear');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={`quizId-${lessonId}`}>Quiz vinculado</Label>
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
            <p className="text-sm font-semibold text-text">Quiz vinculado</p>
            <code className="block truncate font-mono text-xs text-text-subtle">{quizId}</code>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href={`/formador/quizzes/${quizId}` as never}>
              <Icon name="edit" size={13} />
              Editar
            </Link>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setQuizId('')}
            aria-label="Desvincular quiz"
          >
            Desvincular
          </Button>
        </div>
      ) : (
        <div className="space-y-2 rounded-lg border-2 border-dashed border-border-strong bg-surface-2 p-4">
          <p className="text-sm text-text-muted">
            Esta lección no tiene quiz todavía. Puedes crear uno nuevo o pegar el UUID de uno
            existente.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={handleCreate} disabled={creating}>
              <Icon name="plus" size={14} />
              {creating ? 'Creando…' : 'Crear nuevo quiz'}
            </Button>
            <Input
              id={`quizId-${lessonId}`}
              value={quizId}
              onChange={(e) => setQuizId(e.target.value)}
              placeholder="…o pega el UUID de un quiz existente"
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
      setSuccess(`Subido OK (${(res.size / (1024 * 1024)).toFixed(1)} MiB).`);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos subir el paquete.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Label htmlFor={`scorm-${lessonId}`}>Paquete SCORM (.zip)</Label>

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
              entry: <code className="font-mono">{metadata.entryPath}</code>
            </p>
            <p className="text-xs text-text-subtle tabular-nums">
              {(metadata.size / (1024 * 1024)).toFixed(1)} MiB · subido el{' '}
              {new Date(metadata.uploadedAt).toLocaleDateString('es-ES', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
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
          {busy ? 'Subiendo paquete…' : metadata ? 'Reemplazar paquete' : 'Subir paquete SCORM'}
        </p>
        <p className="mt-1 text-xs text-text-muted">
          Arrastra o haz clic para seleccionar un archivo .zip con `imsmanifest.xml` en la raíz.
        </p>
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
