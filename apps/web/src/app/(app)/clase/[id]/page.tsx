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
  type SessionStatus,
  type ZoomSession,
  type ZoomSessionRegistration,
} from '@/modules/zoom-live';

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
                <Link href={session.joinUrl as never} target="_blank">
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

      {isStaff ? (
        <RegistrationsRoster sessionId={session.id} refreshKey={session.registeredCount} />
      ) : null}
    </section>
  );
}

/** Roster de inscritos — solo staff (el endpoint además lo gatea por rol). */
function RegistrationsRoster({
  sessionId,
  refreshKey,
}: {
  sessionId: string;
  /** Cambia con registeredCount: re-carga el roster tras register/unregister. */
  refreshKey: number;
}) {
  const [rows, setRows] = useState<ZoomSessionRegistration[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    zoomLiveApi
      .listRegistrations(sessionId)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof ApiHttpError ? e.message : 'No pudimos cargar los inscritos.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  return (
    <Card>
      <CardContent className="space-y-3 p-6">
        <h2 className="font-display text-base font-bold text-text">
          <Icon name="users" size={16} className="mr-1.5 inline-block align-[-3px]" />
          Miembros inscritos
        </h2>
        {error ? (
          <p className="text-sm text-danger-700">{error}</p>
        ) : rows === null ? (
          <div className="skeleton h-16 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-text-muted">Todavía no hay inscritos.</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.userId} className="flex items-center gap-3 py-2.5">
                {r.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.avatarUrl}
                    alt=""
                    className="h-8 w-8 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-bg-subtle text-xs font-semibold text-text-muted">
                    {(r.name ?? r.email).slice(0, 2).toUpperCase()}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text">{r.name ?? r.email}</p>
                  {r.name ? <p className="truncate text-xs text-text-muted">{r.email}</p> : null}
                </div>
                <span className="shrink-0 text-xs tabular-nums text-text-subtle">
                  {new Date(r.registeredAt).toLocaleDateString('es-ES', {
                    day: '2-digit',
                    month: 'short',
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
