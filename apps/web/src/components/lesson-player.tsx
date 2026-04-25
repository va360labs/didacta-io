'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiHttpError } from '@/lib/api-client';
import type { CourseLesson } from '@/lib/courses';
import { learningApi } from '@/lib/learning';

interface Props {
  lesson: CourseLesson & { content: Record<string, unknown> };
  enrollmentId: string;
  initialResumePositionSec: number;
  initialCompleted: boolean;
  onProgress?: (progressPercent: number) => void;
}

const TICK_SEC = 30;

/**
 * Player simple por tipo de lección. Reporta deltas de tiempo cada 30s
 * y permite marcar la lección como completada manualmente.
 */
export function LessonPlayer({
  lesson,
  enrollmentId,
  initialResumePositionSec,
  initialCompleted,
  onProgress,
}: Props) {
  const [completed, setCompleted] = useState(initialCompleted);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const sendDelta = useCallback(
    async (delta: number, opts: { resumePositionSec?: number; completed?: boolean } = {}) => {
      try {
        const result = await learningApi.trackProgress({
          enrollmentId,
          lessonId: lesson.id,
          watchedSeconds: delta,
          resumePositionSec: opts.resumePositionSec,
          completed: opts.completed,
        });
        if (typeof result.progressPercent === 'number') onProgress?.(result.progressPercent);
      } catch (e) {
        setError(e instanceof ApiHttpError ? e.message : 'Error al guardar progreso');
      }
    },
    [enrollmentId, lesson.id, onProgress],
  );

  // Tick automático: por cada 30s con la pestaña activa, suma 30s al watchedSeconds
  useEffect(() => {
    if (completed) return;
    tickRef.current = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void sendDelta(TICK_SEC);
      }
    }, TICK_SEC * 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [completed, sendDelta]);

  async function markCompleted() {
    setPending(true);
    setError(null);
    try {
      await sendDelta(0, { completed: true });
      setCompleted(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-neutral-500">{lesson.type}</p>
          <h3 className="text-lg font-semibold tracking-tight">{lesson.title}</h3>
          {lesson.durationMinutes ? (
            <p className="text-xs text-neutral-500">{lesson.durationMinutes} min estimados</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {completed ? (
            <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-900 dark:bg-green-950 dark:text-green-100">
              Completada
            </span>
          ) : (
            <Button onClick={markCompleted} disabled={pending} size="sm">
              {pending ? 'Guardando…' : 'Marcar como completada'}
            </Button>
          )}
        </div>
      </header>

      <LessonContent lesson={lesson} resumeAt={initialResumePositionSec} onTick={sendDelta} />

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </article>
  );
}

function LessonContent({
  lesson,
  resumeAt,
  onTick: _onTick,
}: {
  lesson: CourseLesson & { content: Record<string, unknown> };
  resumeAt: number;
  onTick: (delta: number, opts?: { resumePositionSec?: number }) => Promise<void>;
}) {
  const content = lesson.content;

  if (lesson.type === 'VIDEO') {
    const url = typeof content['videoUrl'] === 'string' ? content['videoUrl'] : '';
    if (!url) return <Empty hint="Falta videoUrl en el contenido de la lección." />;
    return (
      <video
        controls
        preload="metadata"
        className="w-full rounded-md border border-neutral-200 dark:border-neutral-800"
        // eslint-disable-next-line jsx-a11y/media-has-caption
        src={url}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (resumeAt > 0 && resumeAt < v.duration) v.currentTime = resumeAt;
        }}
      />
    );
  }

  if (lesson.type === 'HTML') {
    const html = typeof content['html'] === 'string' ? content['html'] : '';
    return (
      <div
        className="prose prose-neutral dark:prose-invert"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  if (lesson.type === 'PDF') {
    const url = typeof content['pdfUrl'] === 'string' ? content['pdfUrl'] : '';
    if (!url) return <Empty hint="Falta pdfUrl en el contenido de la lección." />;
    return (
      <iframe
        src={url}
        title={lesson.title}
        className="h-[70dvh] w-full rounded-md border border-neutral-200 dark:border-neutral-800"
      />
    );
  }

  if (lesson.type === 'TEXT') {
    const text = typeof content['text'] === 'string' ? content['text'] : '';
    return (
      <div className="rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{text || 'Sin contenido.'}</p>
      </div>
    );
  }

  if (lesson.type === 'QUIZ') {
    return (
      <Empty hint="El módulo de quizzes (mod.assessments) llega en el próximo PR del Sprint." />
    );
  }

  return <Empty hint={`Tipo "${lesson.type}" no soportado.`} />;
}

function Empty({ hint }: { hint: string }) {
  return (
    <div className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
      {hint}
    </div>
  );
}
