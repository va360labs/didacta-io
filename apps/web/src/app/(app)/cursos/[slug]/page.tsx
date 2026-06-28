'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AiTutorPanel } from '@/components/ai-tutor-panel';
import { BuyCourseButton } from '@/components/buy-course-button';
import { LessonComments } from '@/components/lesson-comments';
import { LessonPlayer } from '@/components/lesson-player';
import { VideoEmbed } from '@/components/video-embed';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { ApiHttpError } from '@/lib/api-client';
import { certificatesApi, type Certificate } from '@/modules/certificates';
import { coursesApi, type CourseDetail, type CourseLesson } from '@/lib/courses';
import { formatDuration } from '@/lib/format';
import { learningApi, type Enrollment } from '@/lib/learning';
import { sanitizeRichHtml } from '@/lib/sanitize-html';
import { zoomLiveApi, type ZoomSession } from '@/modules/zoom-live';

const LESSON_TYPE_LABEL: Record<string, string> = {
  VIDEO: 'Video',
  HTML: 'Lectura',
  PDF: 'PDF',
  TEXT: 'Texto',
  QUIZ: 'Quiz',
};

export default function CourseAlumnoPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [activeLessonId, setActiveLessonId] = useState<string | null>(null);
  const [progressByLesson, setProgressByLesson] = useState<Record<string, boolean>>({});
  // Disponibilidad por drip: lessonId → { availableAt ISO, available }. Las
  // lecciones que NO aparecen están libres (sin gating).
  const [availability, setAvailability] = useState<
    Record<string, { availableAt: string; available: boolean }>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [certificate, setCertificate] = useState<Certificate | null>(null);
  const [zoomSessions, setZoomSessions] = useState<ZoomSession[]>([]);
  const [downloadingCert, setDownloadingCert] = useState(false);

  const reload = useCallback(async () => {
    if (!params?.slug) return;
    try {
      const [courseList, enrollments] = await Promise.all([
        coursesApi.list({ status: 'PUBLISHED' }),
        learningApi.listMine(),
      ]);
      const matched = courseList.find((c) => c.slug === params.slug);
      if (!matched) {
        setError('Este curso no existe o todavía no fue publicado en tu organización.');
        return;
      }
      const detail = await coursesApi.get(matched.id);
      setCourse(detail);
      const found = enrollments.find((e) => e.courseId === detail.id && e.status !== 'CANCELLED');
      setEnrollment(found ?? null);
      const firstLesson = detail.modules.flatMap((m) => m.lessons)[0];
      setActiveLessonId((current) => current ?? firstLesson?.id ?? null);

      // Hidratamos el map de lecciones completadas desde el backend para
      // que al recargar la página o entrar de nuevo el alumno vea
      // correctamente cuáles ya marcó. Sin esto, progressByLesson nace
      // vacío y todas las lecciones se ven como "no completadas" hasta
      // que las vuelva a marcar.
      // Datos dependientes del curso/inscripción, en PARALELO. Antes eran tres
      // awaits secuenciales (progreso → certificados → zoom) que encadenaban
      // latencia. Cada uno tolera su propio fallo (módulo deshabilitado → 403).
      const [progressList, certsList, zoomList, avail] = await Promise.all([
        found ? learningApi.listMyProgress(found.id).catch(() => null) : Promise.resolve(null),
        found?.status === 'COMPLETED'
          ? certificatesApi.listMine().catch(() => null)
          : Promise.resolve(null),
        zoomLiveApi.list({ courseId: detail.id }).catch(() => null),
        found
          ? learningApi.getCourseAvailability(detail.id).catch(() => null)
          : Promise.resolve(null),
      ]);

      if (progressList) {
        const map: Record<string, boolean> = {};
        for (const p of progressList) {
          if (p.completed) map[p.lessonId] = true;
        }
        setProgressByLesson(map);
      } else {
        setProgressByLesson({});
      }

      setAvailability(avail?.drip ? avail.lessons : {});

      setCertificate(certsList?.find((c) => c.courseId === detail.id) ?? null);
      setZoomSessions(zoomList ?? []);
    } catch (e) {
      setError(
        e instanceof ApiHttpError
          ? e.message
          : 'No pudimos cargar el curso. Prueba refrescar la página.',
      );
    }
  }, [params?.slug]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleDownloadCertificate() {
    if (!certificate) return;
    setDownloadingCert(true);
    setError(null);
    try {
      await certificatesApi.openInNewTab(certificate.id, `${certificate.number}.pdf`);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos descargar tu certificado.');
    } finally {
      setDownloadingCert(false);
    }
  }

  async function handleEnrollByCode(form: FormData) {
    setPending(true);
    setError(null);
    try {
      await learningApi.enrollByCode(String(form.get('code')));
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'El código no es válido o ya fue usado.');
    } finally {
      setPending(false);
    }
  }

  if (error && !course)
    return (
      <div className="flex flex-col gap-4">
        <Button variant="ghost" size="sm" asChild className="self-start">
          <a href="/cursos">← Volver al catálogo</a>
        </Button>
        <Card>
          <CardContent className="p-6 text-danger-700">{error}</CardContent>
        </Card>
      </div>
    );

  if (!course) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-10 w-32" />
        <div className="skeleton h-32 w-full" />
        <div className="skeleton h-64 w-full" />
      </div>
    );
  }

  const allLessons: CourseLesson[] = course.modules.flatMap((m) => m.lessons);
  const activeLesson = allLessons.find((l) => l.id === activeLessonId);
  const progressPct = enrollment?.progressPercent ?? 0;

  return (
    <section className="space-y-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push('/cursos')}
        className="self-start"
      >
        ← Volver al catálogo
      </Button>

      {/* Hero — dos variantes:
          · NO inscrito: hero alto con imagen/vídeo destacado + descripción.
          · Inscrito: hero compacto y bajo (título + progreso + continuar). */}
      {enrollment ? (
        <Card className="overflow-hidden p-0">
          <div className="flex flex-col gap-4 p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-2">
                {course.category ? (
                  <Badge variant="info" className="w-fit">
                    {course.category}
                  </Badge>
                ) : null}
                <h1 className="font-display text-2xl font-bold leading-tight text-text">
                  {course.title}
                </h1>
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-text-muted">
                  <div>
                    <strong className="font-display text-text">{course.modules.length}</strong>{' '}
                    módulo{course.modules.length === 1 ? '' : 's'}
                  </div>
                  <div>
                    <strong className="font-display text-text">{allLessons.length}</strong> lecció
                    {allLessons.length === 1 ? 'n' : 'nes'}
                  </div>
                  {course.estimatedMinutes ? (
                    <div>
                      <strong className="font-display text-text tabular-nums">
                        {formatDuration(course.estimatedMinutes)}
                      </strong>{' '}
                      de contenido
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {enrollment.status === 'COMPLETED' && certificate ? (
                  <Button
                    variant="success"
                    onClick={handleDownloadCertificate}
                    disabled={downloadingCert}
                  >
                    {downloadingCert ? 'Descargando…' : 'Descargar certificado'}
                  </Button>
                ) : (
                  <Button variant="primary">Continuar curso</Button>
                )}
              </div>
            </div>
            <div>
              <div className="mb-2 flex justify-between text-sm font-semibold">
                <span className="text-text">
                  {enrollment.status === 'COMPLETED' ? '¡Curso completado!' : 'Tu progreso'}
                </span>
                <span className="tabular-nums text-[var(--didacta-success-fg)]">
                  {progressPct}% · meta {enrollment.completionThreshold}%
                </span>
              </div>
              <Progress
                value={progressPct}
                tone={enrollment.status === 'COMPLETED' ? 'success' : 'info'}
                label={`Progreso ${progressPct}%`}
              />
            </div>
          </div>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="grid gap-0 lg:grid-cols-[1.4fr_1fr]">
            <div className="flex flex-col gap-4 p-8">
              {course.category ? (
                <Badge variant="info" className="w-fit">
                  {course.category}
                </Badge>
              ) : null}
              <h1
                className="font-display text-3xl font-extrabold leading-[1.1] text-text lg:text-4xl"
                style={{ letterSpacing: '-0.02em' }}
              >
                {course.title}
              </h1>
              {course.description ? (
                <div
                  className="prose prose-slate max-w-2xl prose-p:text-text-muted prose-headings:font-display prose-a:text-brand-700"
                  dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(course.description) }}
                />
              ) : (
                <p className="max-w-2xl text-base leading-relaxed text-text-muted">
                  Este curso aún no tiene descripción.
                </p>
              )}
              <div className="flex flex-wrap gap-x-7 gap-y-2 text-sm text-text-muted">
                <div>
                  <strong className="font-display text-text">{course.modules.length}</strong> módulo
                  {course.modules.length === 1 ? '' : 's'}
                </div>
                <div>
                  <strong className="font-display text-text">{allLessons.length}</strong> lecció
                  {allLessons.length === 1 ? 'n' : 'nes'}
                </div>
                {course.estimatedMinutes ? (
                  <div>
                    <strong className="font-display text-text tabular-nums">
                      {formatDuration(course.estimatedMinutes)}
                    </strong>{' '}
                    de contenido
                  </div>
                ) : null}
              </div>
            </div>

            {/* Panel destacado: vídeo > imagen > gradient de fallback. */}
            {course.featuredVideoUrl ? (
              <div className="flex items-center bg-black p-3">
                <div className="w-full">
                  <VideoEmbed url={course.featuredVideoUrl} title={course.title} hideResources />
                </div>
              </div>
            ) : course.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={course.thumbnailUrl}
                alt={course.title}
                className="h-full min-h-[260px] w-full object-cover"
              />
            ) : (
              <div
                className="relative flex min-h-[260px] items-end justify-end p-6"
                style={{ background: 'linear-gradient(135deg, #0D1B2A 0%, #1E5AA8 100%)' }}
              >
                <svg
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 h-full w-full opacity-25"
                  viewBox="0 0 200 200"
                  preserveAspectRatio="none"
                >
                  <path d="M0 140 Q100 90 200 140 L200 200 L0 200 Z" fill="rgba(255,255,255,.18)" />
                  <path
                    d="M0 160 Q100 110 200 160"
                    stroke="rgba(255,255,255,.4)"
                    strokeWidth="1.5"
                    fill="none"
                  />
                  <path
                    d="M0 180 Q100 130 200 180"
                    stroke="rgba(255,255,255,.3)"
                    strokeWidth="1.5"
                    fill="none"
                  />
                </svg>
                <div className="relative z-10 flex items-center gap-3 text-white">
                  <div className="grid h-14 w-14 place-items-center rounded-full bg-white/95 text-[#1E5AA8]">
                    <Icon name="play" size={26} />
                  </div>
                  <div>
                    <div className="text-xs opacity-85">Vista previa</div>
                    <div className="font-display text-base font-semibold">
                      {allLessons[0]?.title ?? 'Empieza por la primera lección'}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {enrollment ? <UpcomingZoomBanner sessions={zoomSessions} /> : null}
      {enrollment ? <RecordedZoomSessions sessions={zoomSessions} /> : null}

      {!enrollment ? (
        <Card>
          <CardHeader>
            <CardTitle>Empieza este curso</CardTitle>
            <CardDescription>
              Compra el curso para acceder al contenido. Si tu organización te dio un código de
              invitación, puedes canjearlo abajo.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex flex-wrap gap-3">
              {course.externalPurchaseUrl ? (
                // El curso se vende en una página externa: el CTA redirige allí.
                // Tras el pago, esa página inscribe al alumno vía POST /api/v1/inscribe.
                <Button asChild size="lg">
                  <a href={course.externalPurchaseUrl} target="_blank" rel="noopener noreferrer">
                    Comprar curso
                  </a>
                </Button>
              ) : (
                // Sin URL externa: si tu organización vinculó el curso a un producto
                // Stripe en mod.billing, "Comprar curso" arranca el checkout. Si NO
                // existe producto, el endpoint devuelve 404 BILLING_PRODUCT_NOT_FOUND y
                // BuyCourseButton muestra un mensaje claro al alumno (sin crash).
                <BuyCourseButton courseId={course.id} size="lg" />
              )}
            </div>
            <form action={handleEnrollByCode} className="space-y-2 border-t border-border pt-5">
              <Label htmlFor="code">¿Tienes un código de invitación?</Label>
              <div className="flex gap-2">
                <Input id="code" name="code" required placeholder="ABCD-1234" className="flex-1" />
                <Button type="submit" variant="secondary" disabled={pending}>
                  Canjear código
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <Card className="self-start lg:max-h-[78dvh] lg:overflow-auto p-0">
          <CardContent className="p-5">
            <h3 className="font-display text-base font-semibold text-text">Contenido</h3>
            <p className="mt-0.5 text-xs text-text-muted">
              {allLessons.length} lecció{allLessons.length === 1 ? 'n' : 'nes'} ·{' '}
              {Object.values(progressByLesson).filter(Boolean).length} completadas
            </p>

            <nav className="mt-4 space-y-5">
              {course.modules.map((m, idx) => (
                <div key={m.id}>
                  <h4 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                    <span className="tabular-nums text-text-subtle">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    <span className="flex-1 normal-case tracking-normal text-text">{m.title}</span>
                  </h4>
                  <ul className="space-y-0.5">
                    {m.lessons.map((l, lessonIdx) => {
                      const isActive = activeLessonId === l.id;
                      const isDone = progressByLesson[l.id];
                      const lock = availability[l.id];
                      const locked = !!lock && !lock.available;
                      return (
                        <li key={l.id}>
                          <button
                            type="button"
                            onClick={() => setActiveLessonId(l.id)}
                            className={
                              isActive
                                ? 'flex w-full items-center gap-3 rounded-[10px] border border-[rgba(46,125,206,0.32)] bg-[var(--didacta-info-bg)] px-3 py-2.5 text-left text-sm font-semibold text-[var(--didacta-info-fg)]'
                                : 'flex w-full items-center gap-3 rounded-[10px] border border-transparent px-3 py-2.5 text-left text-sm text-text transition-colors hover:bg-surface-3'
                            }
                          >
                            <LessonAvatar
                              done={!!isDone}
                              active={isActive}
                              number={lessonIdx + 1}
                            />
                            <span className={`flex-1 truncate ${locked ? 'text-text-muted' : ''}`}>
                              {l.title}
                            </span>
                            {locked ? (
                              <Badge variant="warning" className="shrink-0 text-[10px]">
                                🔒 {formatLockHint(lock.availableAt)}
                              </Badge>
                            ) : (
                              <Badge variant="muted" className="shrink-0 text-[10px]">
                                {LESSON_TYPE_LABEL[l.type] ?? l.type}
                              </Badge>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>
          </CardContent>
        </Card>

        <main>
          {!enrollment ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                <h3 className="font-display text-xl font-semibold">Contenido bloqueado</h3>
                <p className="max-w-md text-sm text-text-muted">
                  Matricúlate al curso para empezar a ver las lecciones, marcar tu progreso y
                  recibir tu certificado al completar.
                </p>
              </CardContent>
            </Card>
          ) : activeLesson && availability[activeLesson.id]?.available === false ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                <span className="text-4xl">🔒</span>
                <h3 className="font-display text-xl font-semibold">Lección aún no disponible</h3>
                <p className="max-w-md text-sm text-text-muted">
                  «{activeLesson.title}» se libera{' '}
                  {formatLockHint(availability[activeLesson.id]!.availableAt)}. Las clases de este
                  curso se van liberando con el tiempo desde que te matriculaste.
                </p>
              </CardContent>
            </Card>
          ) : activeLesson ? (
            // key={activeLesson.id} fuerza re-mount del player al cambiar
            // de lección. Sin esto, el useState interno de LessonPlayer
            // (completed) persistía entre lecciones — el alumno marcaba
            // lección A como completada y al ir a B la veía completada
            // también porque la state no se reinicializaba con
            // initialCompleted={false}.
            <div className="space-y-6">
              <LessonPlayer
                key={activeLesson.id}
                lesson={{
                  ...activeLesson,
                  content:
                    (activeLesson as CourseLesson & { content?: Record<string, unknown> })
                      .content ?? {},
                }}
                enrollmentId={enrollment.id}
                initialResumePositionSec={0}
                initialCompleted={Boolean(progressByLesson[activeLesson.id])}
                onProgress={(percent) => {
                  setEnrollment((e) => (e ? { ...e, progressPercent: percent } : e));
                  setProgressByLesson((map) => ({ ...map, [activeLesson.id]: true }));
                }}
              />
              <LessonComments
                key={`comments-${activeLesson.id}`}
                lessonId={activeLesson.id}
                courseId={course.id}
              />
              <AiTutorPanel courseId={course.id} />
            </div>
          ) : (
            <Card>
              <CardContent className="py-12 text-center text-sm text-text-subtle">
                Este curso aún no tiene lecciones publicadas.
              </CardContent>
            </Card>
          )}
        </main>
      </div>
    </section>
  );
}

/**
 * Texto de ayuda para una lección bloqueada por drip: "en X días", "mañana" o
 * "el DD/MM" según cuánto falte para `availableAt`.
 */
function formatLockHint(availableAtIso: string): string {
  const at = new Date(availableAtIso);
  const days = Math.ceil((at.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'hoy';
  if (days === 1) return 'mañana';
  if (days <= 14) return `en ${days} días`;
  return `el ${at.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })}`;
}

/**
 * Avatar de lección estilo Didacta (CourseDetail.jsx > step):
 *  - done → círculo verde crecimiento con check.
 *  - active → círculo Azul confianza con número.
 *  - todo → círculo gris claro con número apagado.
 */
function LessonAvatar({
  done,
  active,
  number,
}: {
  done: boolean;
  active: boolean;
  number: number;
}) {
  if (done) {
    return (
      <span
        aria-hidden="true"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-white"
        style={{ background: 'var(--didacta-growth)' }}
      >
        <Icon name="check" size={14} />
      </span>
    );
  }
  if (active) {
    return (
      <span
        aria-hidden="true"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full font-display text-[12px] font-bold text-white"
        style={{ background: 'var(--didacta-trust)' }}
      >
        {number}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--didacta-surface)] font-display text-[12px] font-bold text-text-subtle"
    >
      {number}
    </span>
  );
}

/**
 * Banner discreto que muestra la próxima sesión Zoom del curso
 * (programada en los próximos 30 días). Si no hay, no renderiza nada.
 */
function UpcomingZoomBanner({ sessions }: { sessions: ZoomSession[] }) {
  const now = Date.now();
  const next = sessions
    .filter((s) => s.status === 'SCHEDULED' || s.status === 'STARTED')
    .filter((s) => new Date(s.startTime).getTime() > now - 60 * 60 * 1000) // tolerancia 1h
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())[0];

  if (!next) return null;

  const start = new Date(next.startTime);
  const startsIn = start.getTime() - now;
  const isLive =
    next.status === 'STARTED' || (startsIn > -60 * 60 * 1000 && startsIn < 30 * 60 * 1000);

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-4 p-4">
        <span
          aria-hidden="true"
          className="grid h-12 w-12 shrink-0 place-items-center rounded-xl"
          style={{
            background: isLive ? 'var(--didacta-success-bg)' : 'var(--didacta-info-bg)',
            color: isLive ? 'var(--didacta-success-fg)' : 'var(--didacta-info-fg)',
          }}
        >
          <Icon name="calendar" size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-display text-base font-semibold text-text">{next.topic}</p>
            {isLive ? (
              <Badge variant="success" dot>
                En vivo
              </Badge>
            ) : (
              <Badge variant="info">Próxima sesión</Badge>
            )}
          </div>
          <p
            className="text-sm tabular-nums text-text-muted"
            title={`Hora del host: ${start.toLocaleString('es-ES', {
              timeZone: next.timezone,
              day: '2-digit',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
              timeZoneName: 'short',
            })}`}
          >
            {start.toLocaleString('es-ES', {
              // Sin `timeZone` explícito: usa la del navegador. El tooltip
              // arriba muestra la hora del host (next.timezone) para que el
              // alumno entienda diferencias horarias sin tener que abrir el
              // detalle. PR #170 mostraba la TZ del host en este texto, lo
              // cual confundía a alumnos en otra zona ("yo no soy a las 10").
              day: '2-digit',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}{' '}
            · {next.durationMinutes} min · host {next.hostEmail}
          </p>
        </div>
        {next.joinUrl ? (
          <Button asChild size="sm">
            <a href={next.joinUrl} target="_blank" rel="noopener noreferrer">
              {isLive ? 'Unirme ahora' : 'Unirme'}
            </a>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Lista plegable de sesiones Zoom finalizadas que tienen grabación
 * disponible. Solo se renderiza si hay al menos una. La URL apunta al
 * portal de Zoom (share_url); puede requerir passcode si el host lo
 * configuró.
 */
function RecordedZoomSessions({ sessions }: { sessions: ZoomSession[] }) {
  const recorded = sessions
    .filter((s) => s.status === 'ENDED' && s.recordingUrl)
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  if (recorded.length === 0) return null;

  return (
    <Card>
      <CardContent className="p-4">
        <h3 className="font-display text-sm font-semibold text-text mb-3">
          Grabaciones ({recorded.length})
        </h3>
        <ul className="space-y-2">
          {recorded.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-3 py-2"
            >
              <Icon name="play" size={16} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">{s.topic}</p>
                <p className="text-xs tabular-nums text-text-muted">
                  {new Date(s.startTime).toLocaleString('es-ES', {
                    timeZone: s.timezone,
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                  })}
                  {typeof s.recordingDurationMinutes === 'number'
                    ? ` · ${s.recordingDurationMinutes} min`
                    : ''}
                </p>
              </div>
              <Button asChild size="sm" variant="secondary">
                <a href={s.recordingUrl!} target="_blank" rel="noopener noreferrer">
                  Ver grabación
                </a>
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
