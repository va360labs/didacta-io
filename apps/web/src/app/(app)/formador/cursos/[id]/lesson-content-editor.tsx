'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { coursesApi, type CourseLesson, type LessonType } from '@/lib/courses';

const HELP_BY_TYPE: Record<LessonType, string> = {
  VIDEO: 'URL del vídeo (mp4, webm, m3u8). Ideal: hosted en MinIO/Hetzner.',
  HTML: 'HTML inline que se renderiza en el player. Useful para slides o microcopy.',
  PDF: 'URL del PDF. Se muestra en iframe a 70dvh.',
  TEXT: 'Texto plano largo. Se preservan saltos de línea.',
  QUIZ: 'Reservado para mod.assessments. Por ahora pegá el quizId si ya existe.',
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
        <div className="space-y-1">
          <Label htmlFor={`quizId-${lesson.id}`}>Quiz ID</Label>
          <Input
            id={`quizId-${lesson.id}`}
            value={quizId}
            onChange={(e) => setQuizId(e.target.value)}
            placeholder="UUID de mod.assessments (cuando exista)"
          />
        </div>
      )}

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
