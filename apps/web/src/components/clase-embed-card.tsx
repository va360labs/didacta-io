'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { ApiHttpError } from '@/lib/api-client';
import { AddToCalendarDialog, zoomLiveApi, type ZoomSession } from '@/modules/zoom-live';
import { cn } from '@/lib/utils';

/**
 * Tarjeta de una clase en directo embebida en un post de la comunidad.
 *
 * La renderiza cualquier post que referencie una sesión de mod.zoom-live (ver
 * `lib/clase-embed.ts`): el anuncio automático que publica el host al crear la
 * clase, o un post donde alguien pegó el enlace `/clase/<id>`.
 *
 * Permite inscribirse y unirse SIN salir del feed. El estado se recarga con la
 * respuesta del servidor, que es quien decide si el `joinUrl` es visible
 * (gating server-side, ADR-017) — aquí nunca se adivina.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function formatFullDate(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleString('es-ES', {
      timeZone: tz,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(iso).toLocaleString('es-ES');
  }
}

function monthShort(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleDateString('es-ES', { timeZone: tz, month: 'short' });
  } catch {
    return new Date(iso).toLocaleDateString('es-ES', { month: 'short' });
  }
}

function dayNumber(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleDateString('es-ES', { timeZone: tz, day: 'numeric' });
  } catch {
    return String(new Date(iso).getDate());
  }
}

/** Cuenta atrás humana. Devuelve '' cuando ya empezó. */
function countdown(startIso: string, now: number): string {
  const diff = new Date(startIso).getTime() - now;
  if (diff <= 0) return '';
  const days = Math.floor(diff / DAY_MS);
  if (days >= 1) return days === 1 ? 'Mañana' : `En ${days} días`;
  const hours = Math.floor(diff / (60 * 60 * 1000));
  if (hours >= 1) return hours === 1 ? 'En 1 hora' : `En ${hours} horas`;
  const mins = Math.max(1, Math.floor(diff / 60_000));
  return `En ${mins} min`;
}

type Phase = 'proxima' | 'curso' | 'pasada';

function phaseOf(s: ZoomSession, now: number): Phase {
  const start = new Date(s.startTime).getTime();
  const end = start + s.durationMinutes * 60_000;
  if (s.status === 'ENDED') return 'pasada';
  if (s.status === 'STARTED') return now < start ? 'proxima' : 'curso';
  if (now >= start && now <= end) return 'curso';
  return now < start ? 'proxima' : 'pasada';
}

export function ClaseEmbedCard({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<ZoomSession | null>(null);
  const [gone, setGone] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Se abre al inscribirse desde el feed, igual que en /clase/[id]. */
  const [calendarOpen, setCalendarOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    zoomLiveApi
      .get(sessionId)
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch(() => {
        // Clase borrada o de otro tenant: la tarjeta desaparece y el post
        // sigue leyéndose. Nunca rompe el feed.
        if (!cancelled) setGone(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // La cuenta atrás y el "en directo" dependen del reloj, no de los datos.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  async function handleRegister() {
    if (!session) return;
    setPending(true);
    setError(null);
    try {
      setSession(await zoomLiveApi.register(session.id));
      setCalendarOpen(true);
    } catch (e) {
      setError(e instanceof ApiHttpError ? e.message : 'No pudimos completar la inscripción.');
    } finally {
      setPending(false);
    }
  }

  /** Sella la entrada antes de irse a Zoom (ADR-018), sin bloquear el click. */
  function handleJoinClick() {
    if (session) void zoomLiveApi.join(session.id).catch(() => undefined);
  }

  if (gone) return null;

  if (!session) {
    return <div className="skeleton mt-3 h-28 w-full rounded-card" />;
  }

  if (session.status === 'CANCELLED') {
    return (
      <div className="mt-3 rounded-card border border-border bg-bg-subtle px-4 py-3 text-sm text-text-muted">
        Esta clase se canceló.
      </div>
    );
  }

  const phase = phaseOf(session, now);
  const live = phase === 'curso';
  const past = phase === 'pasada';
  const falta = countdown(session.startTime, now);

  return (
    // `stopPropagation`: la tarjeta vive dentro de un post clicable del feed;
    // sin esto, inscribirse abriría además el detalle del post.
    <div
      data-testid={`clase-embed-${session.id}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        'mt-3 overflow-hidden rounded-card border',
        past ? 'border-border bg-bg-subtle' : 'border-transparent',
      )}
      style={
        past
          ? undefined
          : {
              // Borde degradado sin utilidades: dos fondos, el interior tapa
              // el relleno y deja ver 1px del degradado exterior.
              backgroundImage:
                'linear-gradient(var(--color-surface), var(--color-surface)), linear-gradient(135deg, var(--didacta-growth), var(--didacta-trust))',
              backgroundOrigin: 'border-box',
              backgroundClip: 'padding-box, border-box',
              borderWidth: '1.5px',
            }
      }
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
        {/* Bloque de fecha */}
        <div
          className="grid h-14 w-14 shrink-0 place-items-center rounded-xl text-center"
          style={{
            background: past ? 'var(--color-bg-subtle)' : 'var(--didacta-growth)',
            color: past ? 'var(--color-text-muted)' : '#fff',
          }}
          aria-hidden="true"
        >
          <span className="text-[10px] font-bold uppercase leading-none tracking-wider opacity-90">
            {monthShort(session.startTime, session.timezone)}
          </span>
          <span className="text-xl font-bold leading-none">
            {dayNumber(session.startTime, session.timezone)}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {live ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-(--didacta-growth) px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                En directo
              </span>
            ) : (
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                  past
                    ? 'bg-bg-subtle text-text-muted'
                    : 'bg-(--didacta-growth)/12 text-(--didacta-growth)',
                )}
              >
                <Icon name="video" size={11} />
                {past ? 'Clase finalizada' : 'Clase en directo'}
              </span>
            )}
            {!past && falta ? (
              <span className="text-[11px] font-semibold text-text-muted">{falta}</span>
            ) : null}
          </div>

          <p className="mt-1 font-display text-base font-semibold leading-tight wrap-break-word text-text">
            {session.topic}
          </p>
          <p className="mt-0.5 text-xs text-text-muted first-letter:uppercase">
            {formatFullDate(session.startTime, session.timezone)} · {session.durationMinutes} min ·{' '}
            {session.registeredCount === 1 ? '1 inscrito' : `${session.registeredCount} inscritos`}
          </p>
        </div>

        {/* Acciones */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {past ? (
            <Link
              href={`/clase/${session.id}`}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-muted transition-colors hover:border-border-strong hover:text-text"
            >
              Ver la clase
            </Link>
          ) : session.isRegistered ? (
            <>
              {session.joinUrl ? (
                <a
                  href={session.joinUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={handleJoinClick}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90',
                    live && 'animate-pulse',
                  )}
                  style={{ background: 'var(--didacta-growth)' }}
                >
                  <Icon name="play" size={13} />
                  {live ? 'Unirme ahora' : 'Unirme a la clase'}
                </a>
              ) : null}
              <Link
                href={`/clase/${session.id}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-(--didacta-growth)"
              >
                <Icon name="check" size={13} />
                Inscrito
              </Link>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void handleRegister()}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ background: 'var(--didacta-trust)' }}
              >
                {pending ? 'Inscribiendo…' : 'Inscribirme'}
              </button>
              <Link
                href={`/clase/${session.id}`}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-muted transition-colors hover:border-border-strong hover:text-text"
              >
                Detalles
              </Link>
            </>
          )}
        </div>
      </div>

      {error ? (
        <p role="alert" className="border-t border-border px-4 py-2 text-xs text-danger-700">
          {error}
        </p>
      ) : null}

      <AddToCalendarDialog
        sessionId={session.id}
        topic={session.topic}
        open={calendarOpen}
        onOpenChange={setCalendarOpen}
        justRegistered
      />
    </div>
  );
}
