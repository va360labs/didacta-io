'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { LessonPlayer } from '@/components/lesson-player';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { certificatesApi, type Certificate } from '@/lib/certificates';
import { coursesApi, type CourseDetail, type CourseLesson } from '@/lib/courses';
import { learningApi, type Enrollment } from '@/lib/learning';

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
        setError('Curso no encontrado o no publicado en tu tenant');
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
          // El certificado puede tardar segundos en emitirse tras course.completed.
          // No mostramos error: lo intentamos al refrescar.
          setCertificate(null);
        }
      } else {
        setCertificate(null);
      }
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'Error al cargar el curso');
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
      if (e instanceof ApiHttpError) {
        setError(e.message);
      } else {
        setError('Error al matricularte');
      }
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
      setError(e instanceof ApiHttpError ? e.message : 'No se pudo descargar el certificado');
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
      setError(e instanceof ApiHttpError ? e.message : 'Código inválido');
    } finally {
      setPending(false);
    }
  }

  if (error)
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  if (!course) return <p className="text-sm text-neutral-500">Cargando…</p>;

  const allLessons: CourseLesson[] = course.modules.flatMap((m) => m.lessons);
  const activeLesson = allLessons.find((l) => l.id === activeLessonId);

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <Button variant="ghost" size="sm" onClick={() => router.push('/cursos')}>
          ← Volver al catálogo
        </Button>
        <h1 className="text-3xl font-semibold tracking-tight">{course.title}</h1>
        {course.category ? <Badge variant="outline">{course.category}</Badge> : null}
        <p className="max-w-3xl text-sm text-neutral-600 dark:text-neutral-400">
          {course.description ?? 'Sin descripción.'}
        </p>
      </header>

      {!enrollment ? (
        <Card>
          <CardHeader>
            <CardTitle>Matricularme</CardTitle>
            <CardDescription>
              Probá auto-matriculación si tu tenant lo permite, o usá un código de invitación.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button onClick={handleEnroll} disabled={pending}>
              {pending ? 'Solicitando…' : 'Matricularme'}
            </Button>
            <form
              action={handleEnrollByCode}
              className="flex flex-wrap items-end gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800"
            >
              <div className="flex-1">
                <label htmlFor="code" className="text-xs text-neutral-500">
                  Código
                </label>
                <input
                  id="code"
                  name="code"
                  required
                  placeholder="ABCD-1234"
                  className="block w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-950"
                />
              </div>
              <Button type="submit" variant="outline" disabled={pending}>
                Canjear código
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Tu progreso</CardTitle>
            <CardDescription>
              {enrollment.status === 'COMPLETED'
                ? certificate
                  ? `¡Curso completado! Certificado ${certificate.number} listo para descargar.`
                  : '¡Curso completado! Tu certificado se está procesando.'
                : `${enrollment.progressPercent}% — meta para finalizar: ${enrollment.completionThreshold}%`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
              <div
                className="h-full rounded-full bg-neutral-900 dark:bg-neutral-50"
                style={{ width: `${enrollment.progressPercent}%` }}
              />
            </div>
            {enrollment.status === 'COMPLETED' && certificate ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadCertificate}
                disabled={downloadingCert}
              >
                {downloadingCert ? 'Descargando…' : 'Descargar certificado (PDF)'}
              </Button>
            ) : null}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <nav className="space-y-3 lg:max-h-[70dvh] lg:overflow-auto">
          {course.modules.map((m) => (
            <div key={m.id}>
              <p className="mb-1 text-xs uppercase tracking-wider text-neutral-500">{m.title}</p>
              <ul className="space-y-1">
                {m.lessons.map((l) => (
                  <li key={l.id}>
                    <button
                      type="button"
                      onClick={() => setActiveLessonId(l.id)}
                      className={
                        activeLessonId === l.id
                          ? 'block w-full rounded-md bg-neutral-900 px-3 py-2 text-left text-sm font-medium text-neutral-50 dark:bg-neutral-50 dark:text-neutral-900'
                          : 'block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800'
                      }
                    >
                      <span className="mr-2 inline-block min-w-[3rem] rounded bg-neutral-100 px-1.5 py-0.5 text-center text-[10px] uppercase tracking-wider text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                        {l.type}
                      </span>
                      {l.title}
                      {progressByLesson[l.id] ? (
                        <span className="ml-2 text-xs text-green-600 dark:text-green-400">✓</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <main>
          {!enrollment ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-neutral-500">
                Matriculate para acceder al contenido.
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
            <p className="text-sm text-neutral-500">Sin lecciones disponibles.</p>
          )}
        </main>
      </div>
    </section>
  );
}
