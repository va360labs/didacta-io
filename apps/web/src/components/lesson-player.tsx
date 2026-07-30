'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { QuizPlayer } from '@/components/quiz-player';
import { VideoEmbed } from '@/components/video-embed';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiHttpError } from '@/lib/api-client';
import type { CourseLesson } from '@/lib/courses';
import { learningApi } from '@/lib/learning';
import { sanitizeRichHtml } from '@/lib/sanitize-html';
import { parseBunny } from '@/lib/video';
import type { WatchReport } from '@/lib/use-bunny-watch';

/**
 * Bloque de texto enriquecido de una lección (contenido HTML). MEMOIZADO a
 * propósito y NO por estética: el player se re-renderiza cada vez que se reporta
 * progreso (tick de presencia cada 60s en no-Bunny, o reporte de visionado cada
 * ~20s en Bunny → onProgress → setState en la página del curso). Sin este memo,
 * React re-commitea el `dangerouslySetInnerHTML` en CADA render aunque el HTML no
 * cambie; si el HTML lleva un `<iframe>` embebido (vídeo), el navegador destruye y
 * recrea ese iframe → el vídeo se corta/reinicia cada 20-60s. Con el memo, mientras
 * el string `html` no cambie, el subárbol no se re-renderiza y el iframe sobrevive.
 */
const LessonRichHtml = memo(function LessonRichHtml({ html }: { html: string }) {
  return <div className="lesson-prose" dangerouslySetInnerHTML={{ __html: html }} />;
});

interface Props {
  lesson: CourseLesson & { content: Record<string, unknown> };
  /** Ausente en modo `preview` (editor/admin sin matrícula): no se reporta progreso. */
  enrollmentId?: string;
  initialResumePositionSec?: number;
  initialCompleted?: boolean;
  onProgress?: (progressPercent: number) => void;
  /**
   * Posición actual del vídeo (segundos), cada vez que el reproductor reporta.
   * La usa el tutor IA para saber por dónde va el alumno cuando pregunta. Sólo
   * llega en Bunny Stream, que es el único proveedor que medimos vía Player.js.
   */
  onPosition?: (positionSeconds: number) => void;
  /**
   * Vista previa de editor/admin: renderiza el contenido de la lección tal cual lo
   * vería el alumno, pero SIN trackear progreso ni permitir marcar completada
   * (no hay matrícula). Los tipos que requieren backend con matrícula (QUIZ, SCORM)
   * muestran un aviso en su lugar.
   */
  preview?: boolean;
}

// Cada cuánto reportamos tiempo visto al backend. Subido de 30→60s para
// reducir a la mitad las llamadas durante la reproducción (el progreso se
// sigue contabilizando con granularidad de 1 min, imperceptible para el alumno).
const TICK_SEC = 60;

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
 * Mide el tiempo dedicado y lo reporta al backend: en vídeos de Bunny es el
 * visionado REAL (Player.js, vía VideoEmbed→useBunnyWatch); en el resto de
 * tipos, un tick de presencia cada 60s mientras la pestaña esté visible.
 * Permite además marcar la lección como completada manualmente.
 */
export function LessonPlayer({
  lesson,
  enrollmentId,
  initialResumePositionSec = 0,
  initialCompleted = false,
  onProgress,
  onPosition,
  preview = false,
}: Props) {
  const [completed, setCompleted] = useState(initialCompleted);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // En vídeos de Bunny medimos el tiempo de visionado REAL vía Player.js (ver
  // useBunnyWatch en VideoEmbed). En el resto de tipos de lección seguimos con
  // el tick de presencia (pestaña visible) como aproximación.
  const videoUrl =
    lesson.type === 'VIDEO' && typeof lesson.content['videoUrl'] === 'string'
      ? (lesson.content['videoUrl'] as string)
      : '';
  const isBunnyVideo = Boolean(videoUrl && parseBunny(videoUrl));

  const sendDelta = useCallback(
    async (delta: number, opts: { resumePositionSec?: number; completed?: boolean } = {}) => {
      // Vista previa (editor sin matrícula): no hay progreso que reportar.
      if (preview || !enrollmentId) return;
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
    [enrollmentId, lesson.id, onProgress, preview],
  );

  useEffect(() => {
    // Bunny mide visionado real; no sumamos tiempo de "pestaña abierta". En
    // preview no hay matrícula → no se trackea nada.
    if (completed || isBunnyVideo || preview) return;
    tickRef.current = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void sendDelta(TICK_SEC);
      }
    }, TICK_SEC * 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [completed, isBunnyVideo, sendDelta, preview]);

  // Reporte de visionado real de Bunny: convertimos el delta (segundos
  // reproducidos) en una llamada de progreso y fijamos la posición de reanudación.
  const handleWatch = useCallback(
    (report: WatchReport) => {
      // La posición se publica siempre, aunque no haya visionado nuevo que
      // reportar: al tutor le sirve igual saber dónde está parado el alumno.
      onPosition?.(Math.round(report.positionSeconds));
      const delta = Math.round(report.watchedSecondsDelta);
      if (delta <= 0 && !report.ended) return;
      void sendDelta(Math.max(0, delta), {
        resumePositionSec: Math.round(report.positionSeconds),
      });
    },
    [sendDelta, onPosition],
  );

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
  // en backend cuando el alumno aprueba (assessments.attempt.passed). En
  // preview no se puede completar (no hay matrícula).
  const showManualCompleteButton = lesson.type !== 'QUIZ' && !preview;
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
          onWatch={handleWatch}
          watchEnabled={!completed && !preview}
          enrollmentId={enrollmentId}
          preview={preview}
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
  onWatch,
  watchEnabled,
  preview,
}: {
  lesson: CourseLesson & { content: Record<string, unknown> };
  resumeAt: number;
  onTick: (delta: number, opts?: { resumePositionSec?: number }) => Promise<void>;
  enrollmentId?: string;
  onQuizPassed: () => void;
  onWatch: (report: WatchReport) => void;
  watchEnabled: boolean;
  preview?: boolean;
}) {
  const content = lesson.content;

  if (lesson.type === 'VIDEO') {
    const url = typeof content['videoUrl'] === 'string' ? content['videoUrl'] : '';
    if (!url) return <Empty hint="Falta el video. Pídele al formador que lo cargue." />;

    // VideoEmbed resuelve YouTube / Bunny Stream / fichero directo, y debajo
    // del vídeo pinta los recursos: las líneas `MM:SS - Texto` se vuelven
    // capítulos clicables que hacen seek en el player. En Bunny, `onWatch`
    // recibe el tiempo de visionado real medido vía Player.js.
    const resources = typeof content['resources'] === 'string' ? content['resources'] : '';
    // Contenido complementario en texto enriquecido debajo del vídeo (opcional).
    // El vídeo SIEMPRE va por VideoEmbed (iframe con `src` estable, inmune a los
    // re-renders por progreso), así que el complemento no necesita `<iframe>` y lo
    // pasamos por la whitelist de DOMPurify. Va memoizado (LessonRichHtml).
    const complementHtml =
      typeof content['html'] === 'string' && content['html'].trim()
        ? sanitizeRichHtml(content['html'])
        : '';
    return (
      <div className="space-y-6">
        <VideoEmbed
          url={url}
          title={lesson.title}
          resumeAt={resumeAt}
          resources={resources}
          onWatch={onWatch}
          watchEnabled={watchEnabled}
        />
        {complementHtml ? <LessonRichHtml html={complementHtml} /> : null}
      </div>
    );
  }

  if (lesson.type === 'HTML') {
    const html = typeof content['html'] === 'string' ? content['html'] : '';
    if (!html) return <Empty hint="Esta lectura está vacía." />;
    // Se renderiza CRUDO (sin sanitizar) a propósito: las lecciones HTML legacy
    // llevan el vídeo embebido como `<iframe>`, que la whitelist de DOMPurify
    // eliminaría. El memo evita que el iframe se recree en cada reporte de
    // progreso (ver LessonRichHtml). Al migrar el vídeo a tipo VIDEO, el HTML
    // deja de necesitar iframe y puede sanitizarse.
    return <LessonRichHtml html={html} />;
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
    if (preview || !enrollmentId) {
      return (
        <Empty hint="Vista previa: los cuestionarios se resuelven al matricularse en el curso." />
      );
    }
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
    if (preview) {
      return (
        <Empty hint="Vista previa: el contenido SCORM se ejecuta al matricularse en el curso." />
      );
    }
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
