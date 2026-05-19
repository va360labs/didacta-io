'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { QuizPlayer } from '@/components/quiz-player';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiHttpError } from '@/lib/api-client';
import type { CourseLesson } from '@/lib/courses';
import { learningApi } from '@/lib/learning';
import { parseYouTubeId, parseYouTubeStartSeconds, youTubeEmbedUrl } from '@/lib/video';

interface Props {
  lesson: CourseLesson & { content: Record<string, unknown> };
  enrollmentId: string;
  initialResumePositionSec: number;
  initialCompleted: boolean;
  onProgress?: (progressPercent: number) => void;
}

const TICK_SEC = 30;

const LESSON_TYPE_META: Record<string, { label: string; icon: string }> = {
  VIDEO: { label: 'Video', icon: '▶' },
  HTML: { label: 'Lectura', icon: '📖' },
  PDF: { label: 'Documento PDF', icon: '📄' },
  TEXT: { label: 'Texto', icon: '✍' },
  QUIZ: { label: 'Quiz', icon: '✓' },
};

/**
 * Player de lección rediseñado: aplica skill pixel-perfect-ui con jerarquía
 * tipográfica clara, badge de tipo de lección, CTAs primarios, estado
 * "completada" con celebración sutil, errores que ayudan en panel propio.
 *
 * Reporta deltas de tiempo cada 30s al backend (solo cuando la pestaña
 * está visible) y permite marcar la lección como completada manualmente.
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
        setError(
          e instanceof ApiHttpError
            ? e.message
            : 'No pudimos guardar tu progreso. Tus minutos quedan registrados localmente.',
        );
      }
    },
    [enrollmentId, lesson.id, onProgress],
  );

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

  // En lecciones QUIZ, "completada" no es manual — lo dispara el bridge
  // en backend cuando el alumno aprueba (assessments.attempt.passed).
  const showManualCompleteButton = lesson.type !== 'QUIZ';
  const meta = LESSON_TYPE_META[lesson.type] ?? { label: lesson.type, icon: '·' };

  return (
    <article className="overflow-hidden rounded-card border border-border bg-surface shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-surface-2 px-6 py-4">
        <div className="space-y-1.5">
          <Badge variant="outline" className="gap-1.5">
            <span aria-hidden="true">{meta.icon}</span>
            {meta.label}
          </Badge>
          <h2 className="font-display text-2xl font-bold tracking-tight text-text">
            {lesson.title}
          </h2>
          {lesson.durationMinutes ? (
            <p className="text-sm text-text-subtle tabular-nums">
              ⏱ {lesson.durationMinutes} min estimados
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {completed ? (
            <Badge variant="success" className="gap-1.5">
              <span aria-hidden="true">✓</span>
              Completada
            </Badge>
          ) : showManualCompleteButton ? (
            <Button onClick={markCompleted} disabled={pending} variant="success">
              {pending ? 'Guardando…' : 'Marcar como completada'}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="px-6 py-6">
        <LessonContent
          lesson={lesson}
          resumeAt={initialResumePositionSec}
          onTick={sendDelta}
          enrollmentId={enrollmentId}
          onQuizPassed={() => setCompleted(true)}
        />

        {error ? (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm text-warning-700"
          >
            <p className="font-semibold">No se sincronizó tu progreso</p>
            <p className="mt-0.5">{error}</p>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function LessonContent({
  lesson,
  resumeAt,
  enrollmentId,
  onQuizPassed,
}: {
  lesson: CourseLesson & { content: Record<string, unknown> };
  resumeAt: number;
  onTick: (delta: number, opts?: { resumePositionSec?: number }) => Promise<void>;
  enrollmentId: string;
  onQuizPassed: () => void;
}) {
  const content = lesson.content;

  if (lesson.type === 'VIDEO') {
    const url = typeof content['videoUrl'] === 'string' ? content['videoUrl'] : '';
    if (!url) return <Empty hint="Falta el video. Pídele al formador que lo cargue." />;

    // Si la URL es de YouTube, embebemos via iframe (privacy-enhanced) en
    // lugar de usar <video src>, que sólo entiende mp4/webm/HLS directos.
    // El embed respeta el `t=`/`start=` si el formador lo pegó.
    const ytId = parseYouTubeId(url);
    if (ytId) {
      const start = parseYouTubeStartSeconds(url);
      return (
        <div className="aspect-video w-full overflow-hidden rounded-lg border border-border bg-black">
          <iframe
            src={youTubeEmbedUrl(ytId, start ? { startSeconds: start } : {})}
            title={lesson.title}
            className="h-full w-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      );
    }

    return (
      <video
        controls
        preload="metadata"
        className="w-full rounded-lg border border-border bg-text"
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
    if (!html) return <Empty hint="Esta lectura está vacía." />;
    return (
      <div
        className="lesson-prose"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  if (lesson.type === 'PDF') {
    const url = typeof content['pdfUrl'] === 'string' ? content['pdfUrl'] : '';
    if (!url) return <Empty hint="Falta el PDF. Pídele al formador que lo suba." />;
    return (
      <iframe
        src={url}
        title={lesson.title}
        className="h-[72dvh] w-full rounded-lg border border-border"
      />
    );
  }

  if (lesson.type === 'TEXT') {
    const text = typeof content['text'] === 'string' ? content['text'] : '';
    if (!text) return <Empty hint="Esta lección de texto está vacía." />;
    return (
      <div className="prose prose-slate max-w-none">
        <p className="whitespace-pre-wrap leading-relaxed text-text">{text}</p>
      </div>
    );
  }

  if (lesson.type === 'QUIZ') {
    const quizId = typeof content['quizId'] === 'string' ? content['quizId'] : '';
    if (!quizId) {
      return (
        <Empty hint="Esta lección está marcada como Quiz pero el formador aún no vinculó las preguntas." />
      );
    }
    return (
      <QuizPlayer
        quizId={quizId}
        enrollmentId={enrollmentId}
        lessonId={lesson.id}
        onPassed={onQuizPassed}
      />
    );
  }

  if (lesson.type === 'SCORM') {
    return <ScormFrame lessonId={lesson.id} title={lesson.title} />;
  }

  return <Empty hint={`Tipo de lección "${lesson.type}" no soportado todavía.`} />;
}

function ScormFrame({ lessonId, title }: { lessonId: string; title: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [initialCmi, setInitialCmi] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    type Bridge = ReturnType<typeof import('@/components/scorm-api-bridge').createScormBridge>;
    let bridge: Bridge | null = null;
    let autoCommitTimer: ReturnType<typeof setInterval> | null = null;

    (async () => {
      try {
        const { scormApi } = await import('@/lib/scorm');
        const { createScormBridge } = await import('@/components/scorm-api-bridge');

        const [meta, attempt] = await Promise.all([
          scormApi.get(lessonId),
          scormApi.startAttempt(lessonId),
        ]);
        if (cancelled) return;

        setUrl(meta.entrySignedUrl);
        setInitialCmi(attempt.cmiData);

        // Mount window.API antes de que el iframe arranque.
        bridge = createScormBridge({
          initialCmi: attempt.cmiData,
          onCommit: async (cmi) => {
            try {
              await scormApi.commit(lessonId, cmi);
            } catch {
              // Silencioso: la próxima llamada lo reintenta.
            }
          },
        });
        bridge.attach(window);

        // Auto-commit cada 30s mientras la pestaña esté visible (red de seguridad
        // por si el SCO se olvida de hacer LMSCommit).
        autoCommitTimer = setInterval(() => {
          if (document.visibilityState !== 'visible') return;
          // window.API está montado; releer cmi vía LMSGetValue no es trivial,
          // confiamos en que el bridge guardó cada SetValue. Disparamos un commit
          // pidiéndole al SCO que lo haga si aún no lo hizo.
          window.API?.LMSCommit('');
        }, 30_000);
      } catch (e) {
        if (cancelled) return;
        setError(
          e instanceof ApiHttpError
            ? e.message
            : 'No pudimos cargar el paquete SCORM. Pídele al formador que lo suba.',
        );
      }
    })();

    return () => {
      cancelled = true;
      if (autoCommitTimer) clearInterval(autoCommitTimer);
      bridge?.detach();
    };
  }, [lessonId]);

  if (error) return <Empty hint={error} />;
  if (!url || !initialCmi) return <div className="skeleton h-[72dvh] w-full rounded-lg" />;
  return (
    <iframe
      src={url}
      title={title}
      sandbox="allow-scripts allow-forms allow-same-origin"
      className="h-[72dvh] w-full rounded-lg border border-border"
    />
  );
}

function Empty({ hint }: { hint: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border-strong bg-surface-2 px-6 py-12 text-center text-sm text-text-muted">
      {hint}
    </div>
  );
}
