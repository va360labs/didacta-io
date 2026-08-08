'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { eventsApi, type CommunityEvent } from '@/lib/events';
import { formatDate } from '@/lib/i18n/format';

function formatEventStart(iso: string): string {
  return formatDate(iso, {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function EventCard({ event }: { event: CommunityEvent }) {
  const t = useTranslations('alumnoAprendizaje');
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
          <p className="mt-0.5 text-sm text-text-muted">{formatEventStart(event.startAt)}</p>
          {event.location && (
            <p className="mt-0.5 text-xs text-text-muted">
              {t('eventLocation', { location: event.location })}
            </p>
          )}
        </div>
        {isRegistered ? (
          <span className="shrink-0 rounded-full bg-(--didacta-growth)/10 px-2.5 py-1 text-xs font-semibold text-(--didacta-growth)">
            {t('registered')}
          </span>
        ) : isFull ? (
          <span className="shrink-0 rounded-full bg-bg-subtle px-2.5 py-1 text-xs font-semibold text-text-muted">
            {t('eventFull')}
          </span>
        ) : null}
      </div>

      {event.description && (
        <p className="text-sm text-text-muted line-clamp-2">{event.description}</p>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">
          {event.capacity !== null
            ? t('eventRegisteredCapacity', { count: registeredCount, capacity: event.capacity })
            : t('eventRegisteredCount', { count: registeredCount })}
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
            {registering ? '…' : isRegistered ? t('cancel') : t('register')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Pestaña "Eventos" del calendario: lista de eventos de comunidad con
 * inscripción/cancelación. Antes vivía como página propia en `/eventos`
 * (fusionada aquí por el bloque 9 — simplificar navegación); esa ruta ahora
 * redirige a `/calendario?vista=eventos`.
 */
export function EventosView() {
  const t = useTranslations('alumnoAprendizaje');
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
    <div className="space-y-4">
      <p className="text-sm text-text-muted">{t('eventsSubtitle')}</p>

      {events.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-12 text-center">
          <p className="text-base font-semibold text-text">{t('eventsEmptyTitle')}</p>
          <p className="mt-1 text-sm text-text-muted">{t('eventsEmptyHint')}</p>
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
