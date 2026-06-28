/// Entry point del surface `formador` del módulo zoom-live.
///
/// Target del bundle UI distribuido en `dist/ui/formador.js` dentro del ZIP
/// firmado. El host lo carga en runtime vía
/// `loadModuleUI('mod.zoom-live', 'formador')` en la ruta /formador/aula-virtual.
///
/// ADR-015: la UI real vive AQUÍ (en el módulo), no en apps/web/. Todo lo del
/// host (React, componentes, fetch, usuario) entra por el runtime bridge
/// (`window.__didacta__`) vía `_runtime`, nunca importando de apps/web.
/// Los datos de cursos se leen por la API pública de mod.courses (ADR-016).

import {
  React,
  useState,
  useEffect,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Textarea,
  ApiHttpError,
  meApi,
} from './_runtime';
import {
  zoomLiveUiApi,
  type CourseLite,
  type CourseDetailLite,
  type SessionStatus,
  type ZoomSession,
} from './client';

type FormEvent = { preventDefault: () => void; target: unknown };

// ── Iconos inline (el runtime bridge no expone <Icon>) ───────────────────────
function Icon({ name, size = 16 }: { name: string; size?: number }): React.ReactElement {
  const inner: Record<string, React.ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    calendar: (
      <>
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </>
    ),
    play: <polygon points="6 3 20 12 6 21 6 3" />,
    trash: (
      <>
        <path d="M3 6h18" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {inner[name]}
    </svg>
  );
}

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
    return new Date(iso).toLocaleString('es-ES', {
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

interface FormadorSurfaceProps {
  moduleName: string;
  surface: string;
  config: Record<string, unknown>;
}

function FormadorSurface(_props: FormadorSurfaceProps): React.ReactElement {
  const [sessions, setSessions] = useState<ZoomSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function reload() {
    try {
      setError(null);
      setSessions(await zoomLiveUiApi.listSessions());
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
      await zoomLiveUiApi.cancelSession(id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cancelar la sesión.');
    }
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Aula virtual</h1>
          <p className="mt-1 max-w-3xl text-text-muted">
            Sesiones síncronas de tu organización. La integración con Zoom S2S llega en la próxima
            iteración — por ahora se usan stubs `stub-zoom.didacta.dev` para validar el flujo.
          </p>
        </div>
        <Button type="button" onClick={() => setShowForm((v: boolean) => !v)}>
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
              style={{ background: 'var(--didacta-info-bg)', color: 'var(--didacta-info-fg)' }}
            >
              <Icon name="calendar" size={40} />
            </div>
            <h3 className="font-display text-2xl font-semibold">Sin sesiones todavía</h3>
            <p className="max-w-md text-text-muted">
              Programa tu primera sesión Zoom desde el botón de arriba. Puedes vincularla a un curso
              o dejarla como sesión libre del tenant.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {sessions.map((s: ZoomSession) => (
            <Card key={s.id}>
              <CardContent className="flex flex-wrap items-start gap-4 p-5">
                <span
                  aria-hidden="true"
                  className="grid h-12 w-12 shrink-0 place-items-center rounded-xl"
                  style={{ background: 'var(--didacta-info-bg)', color: 'var(--didacta-info-fg)' }}
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
                      <a href={s.startUrl} target="_blank" rel="noreferrer">
                        <Icon name="play" size={13} />
                        Iniciar
                      </a>
                    </Button>
                  ) : null}
                  {s.joinUrl && s.status !== 'CANCELLED' && s.status !== 'ENDED' ? (
                    <Button asChild size="sm" variant="secondary">
                      <a href={s.joinUrl} target="_blank" rel="noreferrer">
                        Unirse
                      </a>
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
}): React.ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [courses, setCourses] = useState<CourseLite[]>([]);
  const [courseId, setCourseId] = useState<string>('');
  const [courseDetail, setCourseDetail] = useState<CourseDetailLite | null>(null);
  const [lessonId, setLessonId] = useState<string>('');
  const [defaultEmail, setDefaultEmail] = useState<string>('');
  const tzGuess =
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';

  // Email del host por defecto = el del usuario actual (vía el bridge `me`).
  useEffect(() => {
    void (async () => {
      try {
        const m = (await meApi.get()) as { email?: string };
        if (m?.email) setDefaultEmail(m.email);
      } catch {
        // Sin default: el formador escribe el email manualmente.
      }
    })();
  }, []);

  // Carga inicial de cursos publicados del tenant para el select.
  useEffect(() => {
    let aborted = false;
    void zoomLiveUiApi
      .listPublishedCourses()
      .then((list: CourseLite[]) => {
        if (!aborted) setCourses(list);
      })
      .catch(() => {
        // Si falla, dejamos los selects vacíos; curso/lección son opcionales.
      });
    return () => {
      aborted = true;
    };
  }, []);

  // Al cambiar de curso, cargamos su detalle para el select de lecciones.
  useEffect(() => {
    setLessonId('');
    setCourseDetail(null);
    if (!courseId) return;
    let aborted = false;
    void zoomLiveUiApi
      .getCourseDetail(courseId)
      .then((detail: CourseDetailLite) => {
        if (!aborted) setCourseDetail(detail);
      })
      .catch(() => {
        if (!aborted) setCourseDetail(null);
      });
    return () => {
      aborted = true;
    };
  }, [courseId]);

  const lessonOptions = (courseDetail?.modules ?? []).flatMap((m) =>
    m.lessons.map((l) => ({ id: l.id, label: `${m.title} · ${l.title}` })),
  );

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const form = new FormData(e.target as HTMLFormElement);
    const startTimeRaw = String(form.get('startTime') ?? '');
    if (!startTimeRaw) {
      setError('Tienes que indicar fecha y hora.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const localDate = new Date(startTimeRaw);
      await zoomLiveUiApi.createSession({
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
            style={{ background: 'var(--didacta-info-bg)', color: 'var(--didacta-info-fg)' }}
          >
            <Icon name="plus" size={18} />
          </span>
          <div className="min-w-0">
            <CardTitle>Nueva sesión Zoom</CardTitle>
            <CardDescription>
              Programa una sesión síncrona. Si la vinculas a un curso, los alumnos matriculados
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
                onChange={(e: { target: { value: string } }) => setCourseId(e.target.value)}
              >
                <option value="">Sesión libre (sin curso)</option>
                {courses.map((c: CourseLite) => (
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
                onChange={(e: { target: { value: string } }) => setLessonId(e.target.value)}
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
                Si seleccionas una lección, la sesión aparece en su detalle para los alumnos
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

// esbuild --format=iife --global-name=__didacta_module_exports__ →
// window.__didacta_module_exports__ = { default: FormadorSurface }
export default FormadorSurface;
