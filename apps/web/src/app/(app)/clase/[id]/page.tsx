'use client';

/**
 * Página de una clase en directo (ADR-017). Es el destino del enlace de
 * inscripción compartible (`/clase/<uuid>`): un anónimo que lo abre pasa por
 * signin y vuelve aquí (deep-link del layout de `(app)`).
 *
 * El gating del `joinUrl`/grabación es server-side: la API solo los devuelve
 * si el usuario está inscrito o es staff. Cero datos inventados: todo sale de
 * `GET /modules/zoom-live/sessions/:id`.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ApiHttpError } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';
import {
  zoomLiveApi,
  type AttendanceReport,
  type AttendanceRow,
  type SessionStatus,
  type ZoomSession,
} from '@/modules/zoom-live';
import { SurveyPanel } from '@/modules/surveys';

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

const STAFF_ROLES = new Set(['super_admin', 'tenant_admin', 'formador']);

/**
 * Hora en la zona LOCAL del navegador — misma decisión que el banner del
 * curso (PR #170): mostrar la TZ del host confunde a miembros en otra zona.
 * La hora del formador va en el tooltip (`hostTime`).
 */
function formatStartLocal(iso: string): string {
  return new Date(iso).toLocaleString('es-ES', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatStartHost(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleString('es-ES', {
      timeZone: tz,
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return new Date(iso).toISOString();
  }
}

export default function ClasePage() {
  const params = useParams<{ id: string }>();
  const sessionId = params.id;

  const [session, setSession] = useState<ZoomSession | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  const isStaff = useMemo(() => {
    const roles = authStorage.getSession()?.user.roles ?? [];
    return roles.some((r) => STAFF_ROLES.has(r));
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    zoomLiveApi
      .get(sessionId)
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiHttpError && e.status === 404) setNotFound(true);
        else setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar la clase.');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  async function handleRegister() {
    if (!session) return;
    setPending(true);
    setError(null);
    try {
      setSession(await zoomLiveApi.register(session.id));
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos completar la inscripción.');
    } finally {
      setPending(false);
    }
  }

  async function handleUnregister() {
    if (!session) return;
    if (!confirm('¿Cancelar tu inscripción a esta clase?')) return;
    setPending(true);
    setError(null);
    try {
      await zoomLiveApi.unregister(session.id);
      setSession(await zoomLiveApi.get(session.id));
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos cancelar la inscripción.');
    } finally {
      setPending(false);
    }
  }

  /**
   * Sella la entrada antes de irse a Zoom (ADR-018). No esperamos la
   * respuesta: el `<a target="_blank">` abre Zoom nativamente (sin bloqueos de
   * popup) y esta pestaña sigue viva, así que la petición termina igual. Si
   * falla, se pierde una evidencia débil — la fuerte la da la reconciliación
   * con Zoom, no este click.
   */
  function handleJoinClick() {
    if (!session) return;
    void zoomLiveApi.join(session.id).catch(() => undefined);
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/clase/${sessionId}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard no disponible (permisos/HTTP): sin feedback, sin romper.
    }
  }

  if (notFound) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
          <Icon name="alert" size={40} />
          <h1 className="font-display text-2xl font-semibold">Clase no encontrada</h1>
          <p className="max-w-md text-text-muted">
            El enlace no corresponde a ninguna clase de esta comunidad, o la clase fue eliminada.
          </p>
          <Button asChild variant="secondary">
            <Link href="/calendario">Ver calendario</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!session) {
    return (
      <div className="space-y-3">
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
          >
            {error}
          </div>
        ) : null}
        <div className="skeleton h-40 w-full" />
      </div>
    );
  }

  const isOpen = session.status === 'SCHEDULED' || session.status === 'STARTED';

  return (
    <section className="mx-auto max-w-3xl space-y-4">
      <Card>
        <CardContent className="space-y-5 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={STATUS_VARIANT[session.status]} dot>
                  {STATUS_LABEL[session.status]}
                </Badge>
                {session.isRegistered ? (
                  <Badge variant="success">
                    <Icon name="check" size={12} />
                    Inscrito
                  </Badge>
                ) : null}
              </div>
              <h1 className="font-display text-2xl font-bold leading-tight text-text">
                {session.topic}
              </h1>
              <p
                className="text-sm text-text-muted"
                title={`Hora del formador: ${formatStartHost(session.startTime, session.timezone)}`}
              >
                <Icon name="calendar" size={14} className="mr-1 inline-block align-[-2px]" />
                <span className="capitalize">{formatStartLocal(session.startTime)}</span>
                {' · '}
                <Icon name="clock" size={14} className="mr-1 inline-block align-[-2px]" />
                {session.durationMinutes} min
              </p>
              <p className="text-xs text-text-subtle">
                <Icon name="users" size={13} className="mr-1 inline-block align-[-2px]" />
                {session.registeredCount === 1
                  ? '1 miembro inscrito'
                  : `${session.registeredCount} miembros inscritos`}
              </p>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={handleCopyLink}>
              <Icon name="link" size={14} />
              {copied ? 'Copiado' : 'Copiar enlace'}
            </Button>
          </div>

          {session.description ? (
            <p className="whitespace-pre-line text-sm text-text">{session.description}</p>
          ) : null}

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-danger-100 bg-danger-50 p-3 text-sm text-danger-700"
            >
              {error}
            </div>
          ) : null}

          {session.status === 'CANCELLED' ? (
            <div className="rounded-lg border border-danger-100 bg-danger-50 p-4 text-sm text-danger-700">
              Esta clase fue cancelada. Si se reprograma, aparecerá de nuevo en el calendario.
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 border-t border-border-soft pt-4">
            {isOpen && !session.isRegistered ? (
              <Button type="button" onClick={handleRegister} disabled={pending}>
                <Icon name="check" size={15} />
                {pending ? 'Inscribiendo…' : 'Inscribirme'}
              </Button>
            ) : null}

            {isOpen && session.isRegistered && session.joinUrl ? (
              <Button asChild>
                <Link href={session.joinUrl as never} target="_blank" onClick={handleJoinClick}>
                  <Icon name="video" size={15} />
                  {session.status === 'STARTED' ? 'Unirme ahora' : 'Unirme a la clase'}
                </Link>
              </Button>
            ) : null}

            {isStaff && isOpen && session.startUrl ? (
              <Button asChild variant="secondary">
                <Link href={session.startUrl as never} target="_blank">
                  <Icon name="play" size={14} />
                  Iniciar (host)
                </Link>
              </Button>
            ) : null}

            {session.status === 'ENDED' && session.recordingUrl ? (
              <Button asChild variant="secondary">
                <Link href={session.recordingUrl as never} target="_blank">
                  <Icon name="play" size={14} />
                  Ver grabación
                  {session.recordingDurationMinutes
                    ? ` (${session.recordingDurationMinutes} min)`
                    : ''}
                </Link>
              </Button>
            ) : null}

            {isOpen && session.isRegistered ? (
              <Button type="button" variant="ghost" onClick={handleUnregister} disabled={pending}>
                Cancelar inscripción
              </Button>
            ) : null}
          </div>

          {isOpen && !session.isRegistered ? (
            <p className="text-xs text-text-subtle">
              El enlace de Zoom solo es visible para los miembros inscritos.
            </p>
          ) : null}
          {session.status === 'ENDED' && !session.recordingUrl ? (
            <p className="text-xs text-text-subtle">
              {session.isRegistered || isStaff
                ? 'La grabación aparecerá aquí cuando Zoom termine de procesarla.'
                : 'Esta clase ya finalizó. La grabación es visible solo para los inscritos.'}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* Encuesta post-clase (mod.surveys): el panel decide solo si se
          renderiza — nada si la clase aún no tiene encuesta. */}
      <SurveyPanel sessionId={session.id} />

      {isStaff ? (
        <AttendancePanel sessionId={session.id} refreshKey={session.registeredCount} />
      ) : null}
    </section>
  );
}

/**
 * Etiqueta honesta de la evidencia (ADR-018): un click en "Unirme" no es lo
 * mismo que una confirmación de Zoom, y el formador tiene que poder
 * distinguirlo de un vistazo antes de dar una asistencia por buena.
 */
const CONFIDENCE_LABEL: Record<AttendanceRow['confidence'], string> = {
  ZOOM: 'Confirmado por Zoom',
  PROXY: 'Abrió el enlace desde Didacta (sin confirmar por Zoom)',
  MANUAL: 'Marcado a mano por un formador',
  NONE: 'Sin evidencia',
};

/** Panel de asistencia — solo staff (el endpoint además lo gatea por rol). */
function AttendancePanel({
  sessionId,
  refreshKey,
}: {
  sessionId: string;
  /** Cambia con registeredCount: re-carga el panel tras register/unregister. */
  refreshKey: number;
}) {
  const [report, setReport] = useState<AttendanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    zoomLiveApi
      .getAttendance(sessionId)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar la asistencia.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  async function handleSync() {
    setSyncing(true);
    setError(null);
    try {
      setReport(await zoomLiveApi.syncAttendance(sessionId));
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos sincronizar con Zoom.');
    } finally {
      setSyncing(false);
    }
  }

  async function handleToggle(row: AttendanceRow) {
    if (!row.userId) return;
    // Ciclo: automático → presente → ausente → automático. Volver al
    // automático es importante: un error de marcado no debe ser permanente.
    const next = row.manualPresent === null ? true : row.manualPresent ? false : null;
    setPendingUserId(row.userId);
    setError(null);
    try {
      setReport(await zoomLiveApi.setManualAttendance(sessionId, row.userId, next));
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos guardar la marca.');
    } finally {
      setPendingUserId(null);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-display text-base font-bold text-text">
              <Icon name="users" size={16} className="mr-1.5 inline-block align-[-3px]" />
              Asistencia
            </h2>
            {report ? (
              <p className="text-xs text-text-subtle">
                {report.attendedCount} de {report.registeredCount}{' '}
                {report.registeredCount === 1 ? 'inscrito' : 'inscritos'}
                {report.syncedAt
                  ? ` · sincronizado con Zoom el ${new Date(report.syncedAt).toLocaleString(
                      'es-ES',
                      { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' },
                    )}`
                  : ' · sin sincronizar con Zoom'}
              </p>
            ) : null}
          </div>
          {report?.canSync ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={handleSync}
              disabled={syncing}
            >
              <Icon name="download-cloud" size={14} />
              {syncing ? 'Sincronizando…' : 'Sincronizar con Zoom'}
            </Button>
          ) : null}
        </div>

        {error ? <p className="text-sm text-danger-700">{error}</p> : null}

        {report?.syncError ? (
          <div className="rounded-lg border border-warning-200 bg-warning-50 p-3 text-xs text-warning-800">
            Zoom no devolvió los participantes: {report.syncError}
          </div>
        ) : null}

        {report && !report.syncedAt && report.rows.some((r) => r.confidence === 'PROXY') ? (
          <p className="text-xs text-text-subtle">
            Todavía no hemos podido confirmar la asistencia con Zoom. Lo que ves abajo es quién
            abrió el enlace desde Didacta.
          </p>
        ) : null}

        {report === null && !error ? (
          <div className="skeleton h-16 w-full" />
        ) : report && report.rows.length === 0 ? (
          <p className="text-sm text-text-muted">Todavía no hay inscritos ni asistentes.</p>
        ) : report ? (
          <ul className="divide-y divide-border">
            {report.rows.map((r, i) => (
              <li
                // Las filas sin `userId` (participantes de Zoom sin casar) no
                // tienen identificador estable en el payload: el índice sirve.
                key={r.userId ?? `zoom:${i}`}
                className="flex items-center gap-3 py-2.5"
              >
                {r.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.avatarUrl}
                    alt=""
                    className="h-8 w-8 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-bg-subtle text-xs font-semibold text-text-muted">
                    {(r.name ?? r.email ?? r.zoomName ?? r.zoomEmail ?? '??')
                      .slice(0, 2)
                      .toUpperCase()}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text">
                    {r.name ?? r.email ?? r.zoomName ?? r.zoomEmail}
                  </p>
                  <p className="truncate text-xs text-text-muted">
                    {r.userId ? (
                      <>
                        {r.email}
                        {!r.registered ? ' · asistió sin inscribirse' : ''}
                      </>
                    ) : (
                      'Participante de Zoom sin identificar'
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {r.minutes > 0 ? (
                    <span className="text-xs tabular-nums text-text-subtle">{r.minutes} min</span>
                  ) : null}
                  <span title={CONFIDENCE_LABEL[r.confidence]}>
                    <Badge variant={r.attended ? 'success' : 'muted'} dot>
                      {r.attended ? 'Asistió' : 'No asistió'}
                    </Badge>
                  </span>
                  {r.userId ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleToggle(r)}
                      disabled={pendingUserId === r.userId}
                      title={
                        r.manualPresent === null
                          ? 'Marcar como presente'
                          : r.manualPresent
                            ? 'Marcar como ausente'
                            : 'Volver al cálculo automático'
                      }
                    >
                      {r.manualPresent === null
                        ? 'Marcar'
                        : r.manualPresent
                          ? 'Presente'
                          : 'Ausente'}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
