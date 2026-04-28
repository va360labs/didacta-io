'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import { coursesApi, type Course, type CourseDetail } from '@/lib/courses';
import { zoomLiveApi, type SessionStatus, type ZoomSession } from '@/lib/zoom-live';

const STATUS_VARIANT: Record<SessionStatus, 'success' | 'warning' | 'muted' | 'danger'> = {
  SCHEDULED: 'warning',
  STARTED: 'success',
  ENDED: 'muted',
  CANCELLED: 'danger',
};

const STATUS_LABEL: Record<SessionStatus, string> = {
  SCHEDULED: 'Programada',
  STARTED: 'En vivo',
  ENDED: 'Finalizada',
  CANCELLED: 'Cancelada',
};

function formatStart(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleString('es-AR', {
      timeZone: tz,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function AulaVirtualPage() {
  const [sessions, setSessions] = useState<ZoomSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function reload() {
    try {
      setError(null);
      setSessions(await zoomLiveApi.list());
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar las sesiones.');
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleCancel(id: string) {
    if (!confirm('¿Cancelar esta sesión? Los alumnos no podrán unirse.')) return;
    try {
      await zoomLiveApi.cancel(id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cancelar la sesión.');
    }
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">Aula virtual</h1>
          <p className="mt-1 max-w-3xl text-text-muted">
            Sesiones síncronas de tu organización. La integración con Zoom S2S llega en la próxima
            iteración — por ahora se usan stubs `stub-zoom.didacta.dev` para validar el flujo.
          </p>
        </div>
        <Button type="button" onClick={() => setShowForm((v) => !v)}>
          <Icon name="plus" size={16} />
          {showForm ? 'Cerrar' : 'Nueva sesión'}
        </Button>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
        >
          {error}
        </div>
      ) : null}

      {showForm ? (
        <CreateSessionForm
          onCreated={async () => {
            setShowForm(false);
            await reload();
          }}
          onCancel={() => setShowForm(false)}
        />
      ) : null}

      {sessions === null ? (
        <div className="space-y-3">
          <div className="skeleton h-24 w-full" />
          <div className="skeleton h-24 w-full" />
        </div>
      ) : sessions.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <div
              aria-hidden="true"
              className="grid h-20 w-20 place-items-center rounded-2xl"
              style={{
                background: 'var(--didacta-info-bg)',
                color: 'var(--didacta-info-fg)',
              }}
            >
              <Icon name="calendar" size={40} />
            </div>
            <h3 className="font-display text-2xl font-semibold">Sin sesiones todavía</h3>
            <p className="max-w-md text-text-muted">
              Programá tu primera sesión Zoom desde el botón de arriba. Podés vincularla a un curso
              o dejarla como sesión libre del tenant.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {sessions.map((s) => (
            <Card key={s.id}>
              <CardContent className="flex flex-wrap items-start gap-4 p-5">
                <span
                  aria-hidden="true"
                  className="grid h-12 w-12 shrink-0 place-items-center rounded-xl"
                  style={{
                    background: 'var(--didacta-info-bg)',
                    color: 'var(--didacta-info-fg)',
                  }}
                >
                  <Icon name="calendar" size={22} />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-display text-base font-semibold leading-tight text-text">
                      {s.topic}
                    </h3>
                    <Badge variant={STATUS_VARIANT[s.status]} dot>
                      {STATUS_LABEL[s.status]}
                    </Badge>
                  </div>
                  <p className="text-sm text-text-muted">
                    <span className="tabular-nums">{formatStart(s.startTime, s.timezone)}</span> ·{' '}
                    {s.durationMinutes} min · host {s.hostEmail}
                  </p>
                  {s.description ? (
                    <p className="line-clamp-2 text-xs text-text-subtle">{s.description}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {s.startUrl && s.status !== 'CANCELLED' && s.status !== 'ENDED' ? (
                    <Button asChild size="sm">
                      <Link href={s.startUrl as never} target="_blank">
                        <Icon name="play" size={13} />
                        Iniciar
                      </Link>
                    </Button>
                  ) : null}
                  {s.joinUrl && s.status !== 'CANCELLED' && s.status !== 'ENDED' ? (
                    <Button asChild size="sm" variant="secondary">
                      <Link href={s.joinUrl as never} target="_blank">
                        Unirse
                      </Link>
                    </Button>
                  ) : null}
                  {s.status === 'SCHEDULED' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => handleCancel(s.id)}
                    >
                      <Icon name="trash" size={13} />
                      Cancelar
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function CreateSessionForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => Promise<void>;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState<string>('');
  const [courseDetail, setCourseDetail] = useState<CourseDetail | null>(null);
  const [lessonId, setLessonId] = useState<string>('');
  const session = authStorage.getSession();
  const defaultEmail = session?.user.email ?? '';
  const tzGuess =
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';

  // Carga inicial de cursos publicados del tenant para el select.
  useEffect(() => {
    let aborted = false;
    void coursesApi
      .list({ status: 'PUBLISHED' })
      .then((list) => {
        if (!aborted) setCourses(list);
      })
      .catch(() => {
        // Si falla la carga, dejamos los selects vacíos. El submit
        // sigue siendo válido (curso/lección son opcionales).
      });
    return () => {
      aborted = true;
    };
  }, []);

  // Al cambiar de curso, cargamos su detalle para el select de lecciones.
  // El reset de lessonId evita que quede un id huérfano de un curso anterior.
  useEffect(() => {
    setLessonId('');
    setCourseDetail(null);
    if (!courseId) return;
    let aborted = false;
    void coursesApi
      .get(courseId)
      .then((detail) => {
        if (!aborted) setCourseDetail(detail);
      })
      .catch(() => {
        if (!aborted) setCourseDetail(null);
      });
    return () => {
      aborted = true;
    };
  }, [courseId]);

  // Lista plana de lecciones del curso seleccionado (preserva el orden
  // de módulos y dentro de cada módulo el orden de lecciones).
  const lessonOptions = (courseDetail?.modules ?? []).flatMap((m) =>
    m.lessons.map((l) => ({ id: l.id, label: `${m.title} · ${l.title}` })),
  );

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const form = new FormData(e.target as HTMLFormElement);
    const startTimeRaw = String(form.get('startTime') ?? '');
    if (!startTimeRaw) {
      setError('Tenés que indicar fecha y hora.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      // datetime-local da `2026-05-15T10:00`; convertimos a ISO con offset local.
      const localDate = new Date(startTimeRaw);
      await zoomLiveApi.create({
        topic: String(form.get('topic') ?? ''),
        startTime: localDate.toISOString(),
        durationMinutes: Number(form.get('durationMinutes') ?? 60),
        hostEmail: String(form.get('hostEmail') ?? defaultEmail),
        timezone: String(form.get('timezone') ?? tzGuess),
        description: form.get('description') ? String(form.get('description')) : undefined,
        courseId: form.get('courseId') ? String(form.get('courseId')) : undefined,
        lessonId: form.get('lessonId') ? String(form.get('lessonId')) : undefined,
      });
      await onCreated();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos crear la sesión.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
            style={{
              background: 'var(--didacta-info-bg)',
              color: 'var(--didacta-info-fg)',
            }}
          >
            <Icon name="plus" size={18} />
          </span>
          <div className="min-w-0">
            <CardTitle>Nueva sesión Zoom</CardTitle>
            <CardDescription>
              Programá una sesión síncrona. Si la vinculás a un curso, los alumnos matriculados
              verán el botón "Unirse" en su detalle.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="topic">
              Título <span className="text-danger-700">*</span>
            </Label>
            <Input
              id="topic"
              name="topic"
              required
              maxLength={200}
              placeholder="Ej: Q&A semanal del curso de n8n"
              autoFocus
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="startTime">
                Fecha y hora <span className="text-danger-700">*</span>
              </Label>
              <Input id="startTime" name="startTime" type="datetime-local" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="durationMinutes">
                Duración (min) <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="durationMinutes"
                name="durationMinutes"
                type="number"
                min={15}
                max={480}
                defaultValue={60}
                required
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="hostEmail">
                Email del host <span className="text-danger-700">*</span>
              </Label>
              <Input
                id="hostEmail"
                name="hostEmail"
                type="email"
                defaultValue={defaultEmail}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timezone">Timezone (IANA)</Label>
              <Input id="timezone" name="timezone" defaultValue={tzGuess} required />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="courseId">Curso (opcional)</Label>
              <Select
                id="courseId"
                name="courseId"
                value={courseId}
                onChange={(e) => setCourseId(e.target.value)}
              >
                <option value="">Sesión libre (sin curso)</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lessonId">Lección (opcional)</Label>
              <Select
                id="lessonId"
                name="lessonId"
                value={lessonId}
                onChange={(e) => setLessonId(e.target.value)}
                disabled={!courseId || lessonOptions.length === 0}
              >
                <option value="">— Sin vincular a una lección —</option>
                {lessonOptions.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-text-subtle">
                Si seleccionás una lección, la sesión aparece en su detalle para los alumnos
                matriculados.
              </p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">Agenda / notas (opcional)</Label>
            <Textarea id="description" name="description" rows={3} maxLength={2000} />
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {error}
            </div>
          ) : null}

          <div className="flex items-center gap-2 border-t border-border-soft pt-4">
            <Button type="submit" disabled={pending}>
              {pending ? 'Creando…' : 'Crear sesión'}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
