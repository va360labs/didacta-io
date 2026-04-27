'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { assessmentsApi } from '@/lib/assessments';
import { coursesApi, type CourseLesson, type LessonType } from '@/lib/courses';
import { scormApi, type ScormPackageMetadata } from '@/lib/scorm';

const HELP_BY_TYPE: Record<LessonType, string> = {
  VIDEO: 'URL del vídeo (mp4, webm, m3u8). Ideal: hosted en MinIO/Hetzner.',
  HTML: 'HTML inline que se renderiza en el player. Useful para slides o microcopy.',
  PDF: 'URL del PDF. Se muestra en iframe a 70dvh.',
  TEXT: 'Texto plano largo. Se preservan saltos de línea.',
  QUIZ: 'Crea un nuevo quiz o vincula uno existente por ID. El editor del quiz vive en /formador/quizzes/<id>.',
  SCORM:
    'Subí el ZIP del paquete SCORM 1.2 / 2004. El sistema lo descomprime, parsea imsmanifest.xml y lo sirve por iframe.',
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
        // El paquete vive en mod_learning_scorm_package; el content de la
        // lesson queda como flag de presencia.
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
    <div className="space-y-3 rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900">
      <p className="text-xs uppercase tracking-wider text-neutral-500">
        Editando lección · {lesson.type}
      </p>

      <div className="space-y-1">
        <Label htmlFor={`title-${lesson.id}`}>Título</Label>
        <Input
          id={`title-${lesson.id}`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor={`duration-${lesson.id}`}>Duración estimada (min)</Label>
        <Input
          id={`duration-${lesson.id}`}
          type="number"
          min={1}
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
        />
      </div>

      {lesson.type === 'VIDEO' && (
        <div className="space-y-1">
          <Label htmlFor={`videoUrl-${lesson.id}`}>URL del vídeo</Label>
          <Input
            id={`videoUrl-${lesson.id}`}
            type="url"
            value={videoUrl}
            onChange={(e) => setVideoUrl(e.target.value)}
            placeholder="https://..."
          />
        </div>
      )}

      {lesson.type === 'PDF' && (
        <div className="space-y-1">
          <Label htmlFor={`pdfUrl-${lesson.id}`}>URL del PDF</Label>
          <Input
            id={`pdfUrl-${lesson.id}`}
            type="url"
            value={pdfUrl}
            onChange={(e) => setPdfUrl(e.target.value)}
            placeholder="https://..."
          />
        </div>
      )}

      {lesson.type === 'HTML' && (
        <div className="space-y-1">
          <Label htmlFor={`html-${lesson.id}`}>HTML</Label>
          <Textarea
            id={`html-${lesson.id}`}
            rows={8}
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            placeholder="<p>...</p>"
          />
        </div>
      )}

      {lesson.type === 'TEXT' && (
        <div className="space-y-1">
          <Label htmlFor={`text-${lesson.id}`}>Texto</Label>
          <Textarea
            id={`text-${lesson.id}`}
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      )}

      {lesson.type === 'QUIZ' && (
        <QuizLink lessonId={lesson.id} lessonTitle={title} quizId={quizId} setQuizId={setQuizId} />
      )}

      {lesson.type === 'SCORM' && <ScormUploader lessonId={lesson.id} />}

      <p className="text-xs text-neutral-500">{HELP_BY_TYPE[lesson.type]}</p>

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button size="sm" onClick={handleSave} disabled={pending}>
          {pending ? 'Guardando…' : 'Guardar'}
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
      <div className="flex gap-2">
        <Input
          id={`quizId-${lessonId}`}
          value={quizId}
          onChange={(e) => setQuizId(e.target.value)}
          placeholder="UUID del quiz (mod.assessments)"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleCreate}
          disabled={creating || quizId.length > 0}
        >
          {creating ? 'Creando…' : 'Crear nuevo'}
        </Button>
      </div>
      {quizId ? (
        <Link
          href={`/formador/quizzes/${quizId}`}
          className="inline-block text-xs underline decoration-dotted hover:decoration-solid"
        >
          → Editar este quiz
        </Link>
      ) : (
        <p className="text-xs text-neutral-500">
          Crea uno nuevo o pega el UUID de un quiz existente.
        </p>
      )}
      {createError ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
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
    <div className="space-y-2 rounded-md border border-dashed border-neutral-300 p-3 dark:border-neutral-700">
      <Label htmlFor={`scorm-${lessonId}`}>Paquete SCORM (.zip)</Label>
      <input
        id={`scorm-${lessonId}`}
        type="file"
        accept=".zip,application/zip"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleUpload(file);
        }}
        className="block text-sm"
      />
      {metadata ? (
        <div className="rounded bg-surface-2 p-2 text-xs text-text-muted">
          <p>
            <strong>Paquete actual:</strong> SCORM {metadata.version} · entry{' '}
            <code className="font-mono">{metadata.entryPath}</code> ·{' '}
            {(metadata.size / (1024 * 1024)).toFixed(1)} MiB
          </p>
          <p className="mt-1 text-text-subtle">
            Subido el {new Date(metadata.uploadedAt).toLocaleString('es-ES')}
          </p>
        </div>
      ) : (
        <p className="text-xs text-text-subtle">
          Aún no subiste paquete. Subí un .zip que contenga imsmanifest.xml en la raíz.
        </p>
      )}
      {success ? <p className="text-xs text-success-700">{success}</p> : null}
      {error ? <p className="text-xs text-danger-700">{error}</p> : null}
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
