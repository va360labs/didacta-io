'use client';

import { useEffect, useState } from 'react';
import { eventsApi, type CommunityEvent } from '@/lib/events';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('es-ES', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function EventCard({ event }: { event: CommunityEvent }) {
  const [registering, setRegistering] = useState(false);
  const [isRegistered, setIsRegistered] = useState(event.isRegistered);
  const [registeredCount, setRegisteredCount] = useState(event.registeredCount);
  const [isFull, setIsFull] = useState(event.isFull);

  async function handleToggle() {
    setRegistering(true);
    try {
      if (isRegistered) {
        await eventsApi.unregister(event.id);
        setIsRegistered(false);
        setRegisteredCount((c) => c - 1);
        setIsFull(false);
      } else {
        const res = await eventsApi.register(event.id);
        if (res.registered) {
          setIsRegistered(true);
          setRegisteredCount((c) => c + 1);
          if (event.capacity !== null && registeredCount + 1 >= event.capacity) setIsFull(true);
        }
      }
    } finally {
      setRegistering(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-text">{event.title}</p>
          <p className="mt-0.5 text-sm text-text-muted">{formatDate(event.startAt)}</p>
          {event.location && <p className="mt-0.5 text-xs text-text-muted">📍 {event.location}</p>}
        </div>
        {isRegistered ? (
          <span className="shrink-0 rounded-full bg-(--didacta-growth)/10 px-2.5 py-1 text-xs font-semibold text-(--didacta-growth)">
            Inscrito
          </span>
        ) : isFull ? (
          <span className="shrink-0 rounded-full bg-bg-subtle px-2.5 py-1 text-xs font-semibold text-text-muted">
            Completo
          </span>
        ) : null}
      </div>

      {event.description && (
        <p className="text-sm text-text-muted line-clamp-2">{event.description}</p>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">
          {registeredCount} inscrito{registeredCount !== 1 ? 's' : ''}
          {event.capacity !== null && ` · ${event.capacity} plazas`}
        </p>
        {!isFull || isRegistered ? (
          <button
            type="button"
            disabled={registering}
            onClick={handleToggle}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
              isRegistered
                ? 'border border-border text-text-muted hover:text-text'
                : 'bg-(--didacta-trust) text-white hover:opacity-90'
            }`}
          >
            {registering ? '…' : isRegistered ? 'Cancelar' : 'Inscribirme'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function EventosPage() {
  const [events, setEvents] = useState<CommunityEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    eventsApi
      .list()
      .then((data) => {
        if (!cancelled) setEvents(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-text">Eventos en directo</h1>
        <p className="mt-1 text-sm text-text-muted">Sesiones, talleres y mentorías programadas</p>
      </div>

      {events.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-12 text-center">
          <p className="text-base font-semibold text-text">No hay eventos programados</p>
          <p className="mt-1 text-sm text-text-muted">
            Los próximos eventos aparecerán aquí cuando estén disponibles.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {events.map((e) => (
            <EventCard key={e.id} event={e} />
          ))}
        </div>
      )}
    </div>
  );
}
