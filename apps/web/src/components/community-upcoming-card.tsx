'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { Card, CardContent } from '@/components/ui/card';
import { fetchUpcoming, phaseOf, type CalendarItem } from '@/lib/agenda';
import { formatDate, formatTime } from '@/lib/i18n/format';

/**
 * Bloque «Próximas citas» de la barra derecha del feed de la comunidad.
 *
 * Adelanta lo que ya vive en `/calendario` para que al abrir la comunidad se
 * vea de un vistazo qué hay por delante, sin navegar. Mismas fuentes que el
 * calendario (mod.events + mod.zoom-live) vía `lib/agenda`.
 */

const MAX_ITEMS = 4;
/** Cada cuánto se recalcula "en curso" sin volver a pedir datos. */
const TICK_MS = 60_000;

function formatWhen(item: CalendarItem): string {
  const fecha = formatDate(item.startAt, { weekday: 'short', day: 'numeric', month: 'short' });
  const hora = formatTime(item.startAt, { hour: '2-digit', minute: '2-digit' });
  return `${fecha} · ${hora}`;
}

export function CommunityUpcomingCard() {
  const t = useTranslations('comunidadComponentes');
  const [items, setItems] = useState<CalendarItem[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    fetchUpcoming(MAX_ITEMS)
      .then((data) => {
        if (!cancelled) setItems(data);
      })
      // Si el calendario falla, el bloque se oculta: nunca rompe el feed.
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-2">
          <h4 className="font-display text-base font-semibold text-text">{t('upcomingTitle')}</h4>
          <Link
            href="/calendario"
            className="text-xs font-medium text-brand-700 hover:underline"
            aria-label={t('seeCalendarAria')}
          >
            {t('seeAll')}
          </Link>
        </div>

        {items === null ? (
          <div className="mt-3 space-y-2">
            <div className="skeleton h-10 w-full" />
            <div className="skeleton h-10 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="mt-3 text-xs text-text-subtle">{t('noUpcoming')}</p>
        ) : (
          <ul className="mt-3 space-y-1" data-testid="proximas-citas">
            {items.map((item, i) => {
              const live = phaseOf(item, now) === 'curso';
              const clase = item.kind === 'clase';
              const inner = (
                <div className="flex items-start gap-2.5 rounded-lg py-2 transition-colors">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                    style={{
                      background: clase
                        ? 'color-mix(in srgb, var(--didacta-growth) 12%, transparent)'
                        : 'color-mix(in srgb, var(--didacta-trust) 12%, transparent)',
                      color: clase ? 'var(--didacta-growth)' : 'var(--didacta-trust)',
                    }}
                  >
                    <Icon name={clase ? 'video' : 'calendar'} size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium leading-tight text-text">
                      {item.title}
                    </p>
                    {live ? (
                      <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-semibold text-(--didacta-growth)">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-(--didacta-growth)" />
                        {t('liveNow')}
                      </span>
                    ) : (
                      <p className="mt-0.5 text-[11px] text-text-muted first-letter:uppercase">
                        {formatWhen(item)}
                        {item.isRegistered ? ` · ${t('registered')}` : ''}
                      </p>
                    )}
                  </div>
                </div>
              );
              return (
                <li
                  key={item.key}
                  className={i > 0 ? 'border-t border-border-soft' : undefined}
                  // Los eventos de comunidad no tienen página propia: se
                  // enlazan al calendario, que es donde se gestionan.
                >
                  <Link
                    href={(item.href ?? '/calendario?vista=eventos') as never}
                    className="block hover:opacity-80"
                  >
                    {inner}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
