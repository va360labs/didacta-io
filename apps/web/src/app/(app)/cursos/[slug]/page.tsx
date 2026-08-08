'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AiTutorPanel } from '@/components/ai-tutor-panel';
import { CourseStatusBadge } from '@/components/course-status-badge';
import { authStorage } from '@/lib/auth-storage';
import { CourseSalesPanel, LockedContentActions } from '@/modules/billing/course-sales-panel';
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
import { apiErrorMessage } from '@/lib/i18n/api-error';
import { formatDate, formatDateTime, formatDuration } from '@/lib/i18n/format';
import { labelOr, type TranslatorLike } from '@/lib/i18n/labels';
import { learningApi, type Enrollment } from '@/lib/learning';
import { sanitizeRichHtml } from '@/lib/sanitize-html';
import { subscriptionsApi } from '@/modules/subscriptions';
import { zoomLiveApi, type ZoomSession } from '@/modules/zoom-live';

// Roles que pueden PREVISUALIZAR un curso no publicado (sin matricularse).
const PREVIEW_ROLES = ['super_admin', 'tenant_admin', 'formador'];

export default function CourseAlumnoPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const t = useTranslations('alumnoAprendizaje');
  const tErrors = useTranslations('errors');
  const tCommon = useTranslations('common');
  // Editor (profesor/admin): puede abrir cursos DRAFT/ARCHIVED y ver el contenido
  // en modo vista previa sin necesidad de publicarlos ni matricularse.
  const isEditor = useMemo(() => {
    const roles = authStorage.getSession()?.user.roles ?? [];
    return roles.some((r) => PREVIEW_ROLES.includes(r));
  }, []);
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  /**
   * Segundo por el que va el vídeo de la lección abierta. Lo reporta el
   * reproductor de Bunny y viaja al tutor IA para que sepa dónde está el alumno
   * cuando pregunta. `undefined` mientras no haya reporte (o si el proveedor de
   * vídeo no es Bunny, que es el único que medimos).
   */
  const [lessonPosition, setLessonPosition] = useState<number | undefined>(undefined);
  const [activeLessonId, setActiveLessonId] = useState<string | null>(null);
  const [progressByLesson, setProgressByLesson] = useState<Record<string, boolean>>({});
  // Posición de reanudación por lección (segundos) desde el backend, para
  // arrancar el vídeo donde el alumno lo dejó. 0/ausente = desde el inicio.
  const [resumeByLesson, setResumeByLesson] = useState<Record<string, number>>({});
  // Disponibilidad por drip/trial: lessonId → { availableAt ISO|null, available,
  // reason? }. Las lecciones que NO aparecen están libres (sin gating).
  // reason 'TRIAL' = bloqueada por el periodo de prueba (se desbloquea pagando).
  const [availability, setAvailability] = useState<
    Record<string, { availableAt: string | null; available: boolean; reason?: 'DRIP' | 'TRIAL' }>
  >({});
  // Límite de lecciones del trial de la membresía para este curso (si aplica).
  const [trialInfo, setTrialInfo] = useState<{ lessonLimit: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [certificate, setCertificate] = useState<Certificate | null>(null);
  const [zoomSessions, setZoomSessions] = useState<ZoomSession[]>([]);
  const [downloadingCert, setDownloadingCert] = useState(false);

  const reload = useCallback(async () => {
    if (!params?.slug) return;
    try {
      const [courseList, enrollments] = await Promise.all([
        // Editores resuelven el slug entre TODOS los estados (para previsualizar
        // DRAFT/ARCHIVED); alumnos, solo entre publicados (sin fugas de borradores).
        coursesApi.list(isEditor ? {} : { status: 'PUBLISHED' }),
        learningApi.listMine(),
      ]);
      const matched = courseList.find((c) => c.slug === params.slug);
      if (!matched) {
        setError(t('courseNotFound'));
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
        const resumeMap: Record<string, number> = {};
        for (const p of progressList) {
          if (p.completed) map[p.lessonId] = true;
          if (p.resumePositionSec > 0) resumeMap[p.lessonId] = p.resumePositionSec;
        }
        setProgressByLesson(map);
        setResumeByLesson(resumeMap);
      } else {
        setProgressByLesson({});
        setResumeByLesson({});
      }

      setAvailability(avail?.drip ? avail.lessons : {});
      setTrialInfo(avail?.trial ?? null);

      setCertificate(certsList?.find((c) => c.courseId === detail.id) ?? null);
      setZoomSessions(zoomList ?? []);
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('courseLoadError'));
    }
    // Deps limitadas a las entradas reales del fetch: `t`/`tErrors` solo
    // componen el mensaje de error, no deciden qué se pide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.slug, isEditor]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // El title de la pestaña dentro de un curso debe reflejar la clase activa (o,
  // en su defecto, el nombre del curso) en vez del genérico "Didacta".
  useEffect(() => {
    if (!course) return;
    const active = course.modules.flatMap((m) => m.lessons).find((l) => l.id === activeLessonId);
    document.title = active?.title ? `${active.title} · ${course.title}` : course.title;
    return () => {
      document.title = 'Didacta';
    };
  }, [course, activeLessonId]);

  // Al cambiar de clase, la posición anterior deja de ser cierta: si no se
  // limpia, el tutor situaría al alumno en el minuto de la clase que acaba de
  // abandonar hasta que el reproductor reporte de nuevo.
  useEffect(() => {
    setLessonPosition(undefined);
  }, [activeLessonId]);

  async function handleDownloadCertificate() {
    if (!certificate) return;
    setDownloadingCert(true);
    setError(null);
    try {
      await certificatesApi.openInNewTab(certificate.id, `${certificate.number}.pdf`);
    } catch (e) {
      setError(
        e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('certificateDownloadError'),
      );
    } finally {
      setDownloadingCert(false);
    }
  }

  // Al completar el curso, el backend emite el certificado de forma ASÍNCRONA
  // (event bus). Lo sondeamos unos segundos hasta que aparezca para poder pasar
  // el botón del hero a "Descargar certificado" sin recargar la página.
  async function pollForCertificate() {
    if (!course) return;
    for (let i = 0; i < 6; i++) {
      try {
        const certs = await certificatesApi.listMine();
        const found = certs.find((c) => c.courseId === course.id);
        if (found) {
          setCertificate(found);
          return;
        }
      } catch {
        // Certificados deshabilitados para el tenant (403) u otro fallo: no
        // insistimos con un error duro en el hero.
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // "Continuar curso": lleva a la primera lección sin completar (o a la primera)
  // y hace scroll al reproductor. Antes el botón no tenía onClick (inerte).
  function handleContinue() {
    const lessons = course ? course.modules.flatMap((m) => m.lessons) : [];
    const next = lessons.find((l) => !progressByLesson[l.id]) ?? lessons[0];
    if (!next) return;
    setActiveLessonId(next.id);
    requestAnimationFrame(() => {
      document.getElementById('curso-main')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  async function handleEnrollByCode(form: FormData) {
    setPending(true);
    setError(null);
    try {
      await learningApi.enrollByCode(String(form.get('code')));
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('invalidInviteCode'));
    } finally {
      setPending(false);
    }
  }

  if (error && !course)
    return (
      <div className="flex flex-col gap-4">
        <Button variant="ghost" size="sm" asChild className="self-start">
          <a href="/cursos">{t('backToCatalog')}</a>
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
  // Modo vista previa: editor/admin que abre el curso sin estar matriculado. Ve el
  // contenido (el backend le devuelve el `content` completo por ser editor) pero
  // sin trackear progreso ni muro de compra.
  const isPreview = isEditor && !enrollment;

  return (
    <section className="space-y-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push('/cursos')}
        className="self-start"
      >
        {t('backToCatalog')}
      </Button>

      {isPreview ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm">
          <Icon name="eye" size={16} className="text-brand-700" />
          <span className="font-semibold text-brand-800">{t('previewBadge')}</span>
          <CourseStatusBadge status={course.status} />
          <span className="text-brand-700">{t('previewNote')}</span>
        </div>
      ) : null}

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
                    {t.rich('moduleCount', {
                      count: course.modules.length,
                      strong: (chunks) => (
                        <strong className="font-display text-text">{chunks}</strong>
                      ),
                    })}
                  </div>
                  <div>
                    {t.rich('lessonCount', {
                      count: allLessons.length,
                      strong: (chunks) => (
                        <strong className="font-display text-text">{chunks}</strong>
                      ),
                    })}
                  </div>
                  {course.estimatedMinutes ? (
                    <div>
                      {t.rich('contentDuration', {
                        duration: formatDuration(course.estimatedMinutes, tCommon) ?? '',
                        strong: (chunks) => (
                          <strong className="font-display text-text tabular-nums">{chunks}</strong>
                        ),
                      })}
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
                    {downloadingCert ? t('downloading') : t('downloadCertificate')}
                  </Button>
                ) : (
                  <Button variant="primary" onClick={handleContinue}>
                    {t('continueCourse')}
                  </Button>
                )}
              </div>
            </div>
            <div>
              <div className="mb-2 flex justify-between text-sm font-semibold">
                <span className="text-text">
                  {enrollment.status === 'COMPLETED' ? t('courseCompleted') : t('yourProgress')}
                </span>
                <span className="tabular-nums text-[var(--didacta-success-fg)]">
                  {t('progressMeta', {
                    percent: progressPct,
                    threshold: enrollment.completionThreshold,
                  })}
                </span>
              </div>
              <Progress
                value={progressPct}
                tone={enrollment.status === 'COMPLETED' ? 'success' : 'info'}
                label={t('progressLabel', { percent: progressPct })}
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
                  {t('noDescription')}
                </p>
              )}
              <div className="flex flex-wrap gap-x-7 gap-y-2 text-sm text-text-muted">
                <div>
                  {t.rich('moduleCount', {
                    count: course.modules.length,
                    strong: (chunks) => (
                      <strong className="font-display text-text">{chunks}</strong>
                    ),
                  })}
                </div>
                <div>
                  {t.rich('lessonCount', {
                    count: allLessons.length,
                    strong: (chunks) => (
                      <strong className="font-display text-text">{chunks}</strong>
                    ),
                  })}
                </div>
                {course.estimatedMinutes ? (
                  <div>
                    {t.rich('contentDuration', {
                      duration: formatDuration(course.estimatedMinutes, tCommon) ?? '',
                      strong: (chunks) => (
                        <strong className="font-display text-text tabular-nums">{chunks}</strong>
                      ),
                    })}
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
              <div className="aspect-video w-full overflow-hidden bg-subtle">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={course.thumbnailUrl}
                  alt={course.title}
                  className="h-full w-full object-contain"
                />
              </div>
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
                    <div className="text-xs opacity-85">{t('previewBadge')}</div>
                    <div className="font-display text-base font-semibold">
                      {allLessons[0]?.title ?? t('startFirstLesson')}
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

      {!enrollment && !isPreview ? (
        <div className="space-y-6">
          {/* Ficha de venta: beneficios, precio real del curso y acceso total.
              Todos los importes salen de la BD; si no existen, no se pintan. */}
          {!course.externalPurchaseUrl ? <CourseSalesPanel courseId={course.id} /> : null}
          <Card>
            <CardHeader>
              <CardTitle>{t('inviteCodeQuestion')}</CardTitle>
              <CardDescription>{t('inviteCodeHint')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex flex-wrap gap-3">
                {course.externalPurchaseUrl ? (
                  // El curso se vende en una página externa: el CTA redirige allí.
                  // Tras el pago, esa página inscribe al alumno vía POST /api/v1/inscribe.
                  <Button asChild size="lg">
                    <a href={course.externalPurchaseUrl} target="_blank" rel="noopener noreferrer">
                      {t('buyCourse')}
                    </a>
                  </Button>
                ) : null}
              </div>
              <form action={handleEnrollByCode} className="space-y-2 border-t border-border pt-5">
                <Label htmlFor="code">{t('inviteCodeQuestion')}</Label>
                <div className="flex gap-2">
                  <Input
                    id="code"
                    name="code"
                    required
                    placeholder={t('inviteCodePlaceholder')}
                    className="flex-1"
                  />
                  <Button type="submit" variant="secondary" disabled={pending}>
                    {t('redeemCode')}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <Card className="min-w-0 self-start p-0 lg:max-h-[78dvh] lg:overflow-auto">
          <CardContent className="p-5">
            <h3 className="font-display text-base font-semibold text-text">{t('contentTitle')}</h3>
            <p className="mt-0.5 text-xs text-text-muted">
              {t('lessonProgressSummary', {
                count: allLessons.length,
                completed: Object.values(progressByLesson).filter(Boolean).length,
              })}
            </p>

            <nav className="mt-4 space-y-5">
              {course.modules.map((m, idx) => {
                // Liberación por MÓDULO: si TODAS las lecciones están bloqueadas y
                // comparten la misma fecha, mostramos un único candado en la
                // cabecera ("el módulo se libera el…") en vez de N candados iguales.
                // Los locks de TRIAL (sin fecha — se desbloquean pagando) quedan
                // fuera del hint de módulo: llevan su propio badge por lección.
                const modLocks = m.lessons
                  .map((l) => availability[l.id])
                  .filter(
                    (x): x is { availableAt: string; available: boolean; reason?: 'DRIP' } =>
                      !!x && x.reason !== 'TRIAL' && x.availableAt !== null,
                  );
                const moduleHint =
                  m.lessons.length >= 2 &&
                  modLocks.length === m.lessons.length &&
                  modLocks.every((x) => !x.available) &&
                  new Set(modLocks.map((x) => x.availableAt)).size === 1
                    ? formatLockHint(modLocks[0]!.availableAt, t)
                    : null;
                return (
                  <div key={m.id}>
                    <h4 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                      <span className="tabular-nums text-text-subtle">
                        {String(idx + 1).padStart(2, '0')}
                      </span>
                      <span className="flex-1 normal-case tracking-normal text-text">
                        {m.title}
                      </span>
                      {moduleHint && (
                        <Badge variant="warning" className="shrink-0 text-[10px]">
                          {t('moduleLockBadge', { hint: moduleHint })}
                        </Badge>
                      )}
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
                              <span
                                className={`flex-1 truncate ${locked ? 'text-text-muted' : ''}`}
                              >
                                {l.title}
                              </span>
                              {locked && lock.reason === 'TRIAL' ? (
                                <Badge variant="warning" className="shrink-0 text-[10px]">
                                  {t('trialLockBadge')}
                                </Badge>
                              ) : locked && lock.availableAt ? (
                                <Badge variant="warning" className="shrink-0 text-[10px]">
                                  {t('lockBadge', { hint: formatLockHint(lock.availableAt, t) })}
                                </Badge>
                              ) : (
                                <Badge variant="muted" className="shrink-0 text-[10px]">
                                  {labelOr(t, `lessonType.${l.type}`, l.type)}
                                </Badge>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </nav>
          </CardContent>
        </Card>

        <main id="curso-main" className="min-w-0">
          {isPreview ? (
            activeLesson ? (
              // Vista previa de editor: contenido completo, sin tracking de progreso.
              <LessonPlayer
                key={activeLesson.id}
                lesson={{
                  ...activeLesson,
                  content:
                    (activeLesson as CourseLesson & { content?: Record<string, unknown> })
                      .content ?? {},
                }}
                preview
              />
            ) : (
              <Card>
                <CardContent className="py-12 text-center text-sm text-text-subtle">
                  {t('noLessons')}
                </CardContent>
              </Card>
            )
          ) : !enrollment ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-full bg-bg-subtle text-text-muted">
                  <Icon name="lock" size={22} />
                </span>
                <h3 className="font-display text-xl font-semibold">{t('contentLocked')}</h3>
                <p className="max-w-md text-sm text-text-muted">
                  {t('contentLockedHint', { count: allLessons.length })}
                </p>
                {/* Mismas dos vías de acceso que arriba, aquí donde el alumno
                    se topa con el muro. Se ocultan solas si no hay ninguna. */}
                <LockedContentActions courseId={course.id} />
              </CardContent>
            </Card>
          ) : activeLesson &&
            availability[activeLesson.id]?.available === false &&
            availability[activeLesson.id]?.reason === 'TRIAL' ? (
            <TrialLockedLessonCard
              title={activeLesson.title}
              lessonLimit={trialInfo?.lessonLimit ?? null}
              onUnlocked={() => reload()}
            />
          ) : activeLesson && availability[activeLesson.id]?.available === false ? (
            <LockedLessonCard
              lessonId={activeLesson.id}
              title={activeLesson.title}
              availableAt={availability[activeLesson.id]!.availableAt ?? new Date().toISOString()}
            />
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
                initialResumePositionSec={resumeByLesson[activeLesson.id] ?? 0}
                initialCompleted={Boolean(progressByLesson[activeLesson.id])}
                onPosition={setLessonPosition}
                onProgress={(percent) => {
                  setEnrollment((e) => (e ? { ...e, progressPercent: percent } : e));
                  setProgressByLesson((map) => ({ ...map, [activeLesson.id]: true }));
                  // Si con esta lección se alcanza el umbral de completado, reflejar
                  // COMPLETED en el acto (sin recargar) y sondear el certificado, que
                  // el backend emite de forma asíncrona. Así el botón del hero pasa a
                  // "Descargar certificado" solo.
                  if (
                    enrollment.status !== 'COMPLETED' &&
                    percent >= enrollment.completionThreshold
                  ) {
                    setEnrollment((e) => (e ? { ...e, status: 'COMPLETED' } : e));
                    void pollForCertificate();
                  }
                }}
              />
              <LessonComments
                key={`comments-${activeLesson.id}`}
                lessonId={activeLesson.id}
                courseId={course.id}
              />
              <AiTutorPanel
                courseId={course.id}
                lessonId={activeLesson.id}
                lessonTitle={activeLesson.title}
                positionSeconds={lessonPosition}
              />
            </div>
          ) : (
            <Card>
              <CardContent className="py-12 text-center text-sm text-text-subtle">
                {t('noPublishedLessons')}
              </CardContent>
            </Card>
          )}
        </main>
      </div>
    </section>
  );
}

/**
 * Pantalla de una lección bloqueada por el PERIODO DE PRUEBA de la membresía:
 * el desbloqueo no es por fecha sino por pago. CTA principal = terminar el
 * trial y cobrar YA (subscriptionsApi.membershipPayNow); al confirmarse, se
 * recarga el curso y el contenido llega desbloqueado del backend.
 */
function TrialLockedLessonCard({
  title,
  lessonLimit,
  onUnlocked,
}: {
  title: string;
  lessonLimit: number | null;
  onUnlocked: () => Promise<void> | void;
}) {
  const t = useTranslations('alumnoAprendizaje');
  const tErrors = useTranslations('errors');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function payNow() {
    if (!window.confirm(t('trialPayConfirm'))) return;
    setBusy(true);
    setError(null);
    try {
      const token = authStorage.getAccessToken();
      if (!token) {
        setError(t('sessionExpired'));
        return;
      }
      const res = await subscriptionsApi.membershipPayNow(token);
      if (res.subscription.status === 'ACTIVE') {
        await onUnlocked();
        return;
      }
      setError(t('trialChargeFailed'));
    } catch (e) {
      setError(e instanceof ApiHttpError ? apiErrorMessage(e, tErrors) : t('paymentFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <span className="text-4xl">🔒</span>
        <h3 className="font-display text-xl font-semibold">{t('trialLockedTitle')}</h3>
        <p className="max-w-md text-sm text-text-muted">
          {t('trialLockedBody', { title })}
          {lessonLimit ? ` ${t('trialLockedLimit', { count: lessonLimit })}` : ''}{' '}
          {t('trialLockedOutro')}
        </p>
        {error ? <p className="max-w-md text-sm text-danger-700">{error}</p> : null}
        <Button size="lg" onClick={() => void payNow()} disabled={busy}>
          {busy ? t('processingPayment') : t('payNowUnlock')}
        </Button>
        <a
          href="/cuenta?tab=suscripcion"
          className="text-xs font-semibold text-brand-700 underline"
        >
          {t('manageSubscription')}
        </a>
      </CardContent>
    </Card>
  );
}

/**
 * Pantalla de una lección bloqueada (drip relativo o fecha de publicación
 * absoluta). Muestra cuándo se desbloquea y permite pedir un aviso por email
 * al desbloquearse (BUG/MEJ-009). Gestiona su propio estado de suscripción.
 */
function LockedLessonCard({
  lessonId,
  title,
  availableAt,
}: {
  lessonId: string;
  title: string;
  availableAt: string;
}) {
  const t = useTranslations('alumnoAprendizaje');
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSubscribed(null);
    learningApi
      .getLessonUnlockSubscription(lessonId)
      .then((r) => {
        if (!cancelled) setSubscribed(r.subscribed);
      })
      .catch(() => {
        if (!cancelled) setSubscribed(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lessonId]);

  async function toggle() {
    setBusy(true);
    try {
      const r = subscribed
        ? await learningApi.unsubscribeLessonUnlock(lessonId)
        : await learningApi.subscribeLessonUnlock(lessonId);
      setSubscribed(r.subscribed);
    } catch {
      // Silencioso: no rompemos la pantalla de bloqueo por un fallo del aviso.
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <span className="text-4xl">🔒</span>
        <h3 className="font-display text-xl font-semibold">{t('lockedLessonTitle')}</h3>
        <p className="max-w-md text-sm text-text-muted">
          {t('lockedLessonBody', { title, hint: formatLockHint(availableAt, t) })}
        </p>
        {subscribed ? (
          <div className="flex flex-col items-center gap-1.5">
            <Badge variant="success" dot>
              {t('unlockNotifyActive')}
            </Badge>
            <Button variant="ghost" size="sm" onClick={() => void toggle()} disabled={busy}>
              {t('unlockNotifyCancel')}
            </Button>
          </div>
        ) : (
          <Button onClick={() => void toggle()} disabled={busy || subscribed === null}>
            {busy ? t('saving') : t('unlockNotifyCta')}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Texto de ayuda para una lección bloqueada por drip: "en X días", "mañana" o
 * "el DD/MM" según cuánto falte para `availableAt`.
 */
function formatLockHint(availableAtIso: string, t: TranslatorLike): string {
  const at = new Date(availableAtIso);
  const days = Math.ceil((at.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return t('lockToday');
  if (days === 1) return t('lockTomorrow');
  if (days <= 14) return t('lockInDays', { days });
  // Incluye el año cuando la fecha cae en otro año (drips largos: "el 03/12/2027").
  const sameYear = at.getFullYear() === new Date().getFullYear();
  return t('lockOnDate', {
    date: formatDate(at, {
      day: '2-digit',
      month: '2-digit',
      ...(sameYear ? {} : { year: 'numeric' }),
    }),
  });
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
  const t = useTranslations('alumnoAprendizaje');
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
                {t('liveNow')}
              </Badge>
            ) : (
              <Badge variant="info">{t('nextSession')}</Badge>
            )}
            {next.isRegistered ? <Badge variant="success">{t('registered')}</Badge> : null}
          </div>
          <p
            className="text-sm tabular-nums text-text-muted"
            title={t('hostTimeTooltip', {
              time: formatDateTime(start, {
                timeZone: next.timezone,
                day: '2-digit',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
                timeZoneName: 'short',
              }),
            })}
          >
            {t('sessionMeta', {
              // Sin `timeZone` explícita: usa la del navegador/perfil. El
              // tooltip arriba muestra la hora del host (next.timezone) para
              // que el alumno entienda diferencias horarias sin tener que
              // abrir el detalle. PR #170 mostraba la TZ del host en este
              // texto, lo cual confundía a alumnos en otra zona ("yo no soy a
              // las 10").
              time: formatDateTime(start, {
                day: '2-digit',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              }),
              minutes: next.durationMinutes,
              email: next.hostEmail,
            })}
          </p>
        </div>
        {next.joinUrl ? (
          <Button asChild size="sm">
            <a href={next.joinUrl} target="_blank" rel="noopener noreferrer">
              {isLive ? t('joinNow') : t('join')}
            </a>
          </Button>
        ) : (
          // Sin joinUrl = no inscrito (gating server-side, ADR-017): el CTA
          // lleva a la página de la clase, donde puede inscribirse.
          <Button asChild size="sm">
            <Link href={`/clase/${next.id}`}>{t('register')}</Link>
          </Button>
        )}
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
  const t = useTranslations('alumnoAprendizaje');
  const recorded = sessions
    .filter((s) => s.status === 'ENDED' && s.recordingUrl)
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  if (recorded.length === 0) return null;

  return (
    <Card>
      <CardContent className="p-4">
        <h3 className="font-display text-sm font-semibold text-text mb-3">
          {t('recordingsTitle', { count: recorded.length })}
        </h3>
        <ul className="space-y-2">
          {recorded.map((s) => {
            const startFormatted = formatDateTime(s.startTime, {
              timeZone: s.timezone,
              day: '2-digit',
              month: 'short',
              year: 'numeric',
            });
            return (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-3 py-2"
              >
                <Icon name="play" size={16} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text">{s.topic}</p>
                  <p className="text-xs tabular-nums text-text-muted">
                    {typeof s.recordingDurationMinutes === 'number'
                      ? t('recordingMeta', {
                          time: startFormatted,
                          minutes: s.recordingDurationMinutes,
                        })
                      : startFormatted}
                  </p>
                </div>
                <Button asChild size="sm" variant="secondary">
                  <a href={s.recordingUrl!} target="_blank" rel="noopener noreferrer">
                    {t('watchRecording')}
                  </a>
                </Button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
