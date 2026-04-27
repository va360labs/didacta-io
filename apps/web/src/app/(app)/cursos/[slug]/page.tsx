'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { LessonPlayer } from '@/components/lesson-player';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { ApiHttpError } from '@/lib/api-client';
import { certificatesApi, type Certificate } from '@/lib/certificates';
import { coursesApi, type CourseDetail, type CourseLesson } from '@/lib/courses';
import { learningApi, type Enrollment } from '@/lib/learning';

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
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [certificate, setCertificate] = useState<Certificate | null>(null);
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

      if (found?.status === 'COMPLETED') {
        try {
          const certs = await certificatesApi.listMine();
          const match = certs.find((c) => c.courseId === detail.id);
          setCertificate(match ?? null);
        } catch {
          setCertificate(null);
        }
      } else {
        setCertificate(null);
      }
    } catch (e) {
      setError(
        e instanceof ApiHttpError
          ? e.message
          : 'No pudimos cargar el curso. Probá refrescar la página.',
      );
    }
  }, [params?.slug]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleEnroll() {
    if (!course) return;
    setPending(true);
    setError(null);
    try {
      const newEnrollment = await learningApi.enrollSelf(course.id);
      if (newEnrollment.status === 'ACTIVE') await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos matricularte. Probá de nuevo.');
    } finally {
      setPending(false);
    }
  }

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

      {/* Hero — replica el spec del UI kit (CourseDetail.jsx): dos paneles
          (info izquierda + cover gradient derecha) + footer con progreso. */}
      <Card className="overflow-hidden p-0">
        <div className="grid gap-0 lg:grid-cols-[1.4fr_1fr]">
          <div className="flex flex-col gap-4 p-8">
            {course.category ? (
              <Badge variant="info" className="w-fit">
                {course.category}
                {course.language ? ` · ${course.language}` : ''}
              </Badge>
            ) : null}
            <h1
              className="font-display text-3xl font-extrabold leading-[1.1] text-text lg:text-4xl"
              style={{ letterSpacing: '-0.02em' }}
            >
              {course.title}
            </h1>
            <p className="max-w-2xl text-base leading-relaxed text-text-muted">
              {course.description ?? 'Este curso aún no tiene descripción.'}
            </p>
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
                    {course.estimatedMinutes}
                  </strong>{' '}
                  min de contenido
                </div>
              ) : null}
            </div>
            {enrollment ? (
              <div className="mt-2 flex flex-wrap gap-2">
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
            ) : null}
          </div>

          {/* Cover panel con gradient + book motif */}
          <div
            className="relative flex min-h-[260px] items-end justify-end p-6"
            style={{
              background: 'linear-gradient(135deg, #0D1B2A 0%, #1E5AA8 100%)',
            }}
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
                  {allLessons[0]?.title ?? 'Empezá por la primera lección'}
                </div>
              </div>
            </div>
          </div>
        </div>

        {enrollment ? (
          <div className="border-t border-border-soft bg-bg-subtle px-8 py-5">
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
        ) : null}
      </Card>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {!enrollment ? (
        <Card>
          <CardHeader>
            <CardTitle>Empezá este curso</CardTitle>
            <CardDescription>
              Matriculate para acceder al contenido. Si tu organización te dio un código de
              invitación, podés canjearlo abajo.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Button onClick={handleEnroll} disabled={pending} size="lg">
              {pending ? 'Procesando…' : 'Matricularme'}
            </Button>
            <form action={handleEnrollByCode} className="space-y-2 border-t border-border pt-5">
              <Label htmlFor="code">¿Tenés un código de invitación?</Label>
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

      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <nav className="space-y-4 lg:max-h-[72dvh] lg:overflow-auto lg:pr-2">
          {course.modules.map((m, idx) => (
            <div key={m.id}>
              <h4 className="label-uppercase mb-2 flex items-center gap-2 text-text-muted">
                <span className="tabular-nums text-text-subtle">
                  {String(idx + 1).padStart(2, '0')}
                </span>
                {m.title}
              </h4>
              <ul className="space-y-0.5">
                {m.lessons.map((l) => {
                  const isActive = activeLessonId === l.id;
                  const isDone = progressByLesson[l.id];
                  return (
                    <li key={l.id}>
                      <button
                        type="button"
                        onClick={() => setActiveLessonId(l.id)}
                        className={
                          isActive
                            ? 'flex w-full items-center gap-2 rounded-md bg-brand-50 px-3 py-2 text-left text-sm font-semibold text-brand-700'
                            : 'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-text hover:bg-surface-3'
                        }
                      >
                        <span
                          className={
                            isDone
                              ? 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success-500 text-[10px] text-white'
                              : 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border-strong text-[10px] text-text-subtle'
                          }
                          aria-hidden="true"
                        >
                          {isDone ? '✓' : ''}
                        </span>
                        <span className="flex-1 truncate">{l.title}</span>
                        <Badge variant="muted" className="shrink-0 text-[10px]">
                          {LESSON_TYPE_LABEL[l.type] ?? l.type}
                        </Badge>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <main>
          {!enrollment ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                <h3 className="font-display text-xl font-semibold">Contenido bloqueado</h3>
                <p className="max-w-md text-sm text-text-muted">
                  Matriculate al curso para empezar a ver las lecciones, marcar tu progreso y
                  recibir tu certificado al completar.
                </p>
              </CardContent>
            </Card>
          ) : activeLesson ? (
            <LessonPlayer
              lesson={{
                ...activeLesson,
                content:
                  (activeLesson as CourseLesson & { content?: Record<string, unknown> }).content ??
                  {},
              }}
              enrollmentId={enrollment.id}
              initialResumePositionSec={0}
              initialCompleted={Boolean(progressByLesson[activeLesson.id])}
              onProgress={(percent) => {
                setEnrollment((e) => (e ? { ...e, progressPercent: percent } : e));
                setProgressByLesson((map) => ({ ...map, [activeLesson.id]: true }));
              }}
            />
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
