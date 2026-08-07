'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  buildGrid,
  dateKeyOf,
  dayKeyOf,
  fetchAgenda,
  fetchRange,
  gridRange,
  phaseOf,
  type CalendarItem,
} from '@/lib/agenda';
import { formatDate, formatTime } from '@/lib/i18n/format';
import { EventosView } from './eventos-view';

/** Ventana de la agenda: medio año atrás y un año hacia delante. */
const AGENDA_MONTHS_BACK = 6;
const AGENDA_MONTHS_FORWARD = 12;
/** Cada cuánto recalculamos "en curso" sin recargar datos. */
const TICK_MS = 60_000;
/** Cuántas citas pasadas se pintan antes de cortar (evita listas enormes). */
const PAST_VISIBLE = 25;

const HHMM: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };

/**
 * Semilla para las cabeceras de la rejilla: lunes 1 de enero de 2024 en UTC.
 * Va en UTC (y se formatea en UTC) a propósito — con una fecha en hora local
 * y una timezone de perfil distinta a la del navegador, el nombre del día se
 * desplazaría y la rejilla saldría empezando en el día equivocado.
 */
const WEEK_SEED_UTC = Date.UTC(2024, 0, 1);
const DAY_MS = 86_400_000;

function formatDayLong(iso: string): string {
  return formatDate(iso, { weekday: 'long', day: 'numeric', month: 'long' });
}

/**
 * Valor interno de la vista activa. NO es copy: los rótulos de los botones
 * salen del catálogo (`viewMonth`/`viewAgenda`/`viewEvents`).
 */
type View = 'Mes' | 'Agenda' | 'Eventos';

const VIEW_LABEL_KEY = {
  Mes: 'viewMonth',
  Agenda: 'viewAgenda',
  Eventos: 'viewEvents',
} as const;

export default function CalendarioPage() {
  const t = useTranslations('alumnoAprendizaje');
  const today = new Date();
  const [view, setView] = useState<View>('Mes');

  // `/eventos` redirige aquí con `?vista=eventos` (bloque 9 — navegación). Se
  // aplica tras el montaje (no en el inicializador) para que el primer render
  // del cliente coincida con el HTML del servidor (evita hydration mismatch).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('vista') === 'eventos') {
      setView('Eventos');
    }
  }, []);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [monthItems, setMonthItems] = useState<CalendarItem[]>([]);
  /** Ventana amplia: alimenta la agenda y "Próximas citas" (cruza meses). */
  const [agendaItems, setAgendaItems] = useState<CalendarItem[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // "En curso" depende del reloj, no de los datos: refrescamos el corte cada
  // minuto sin volver a pedir nada al servidor.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const cells = useMemo(() => buildGrid(year, month), [year, month]);

  // Rejilla visible. Se pide el rango de las 42 CELDAS, no el del mes: si solo
  // se pidiera el mes, los días de agosto que rellenan el pie de julio saldrían
  // vacíos aunque tengan clases.
  useEffect(() => {
    let cancelled = false;
    // Límites en hora LOCAL del navegador (no UTC): la grilla agrupa por día
    // local, así que pedir el rango en UTC dejaría fuera las citas de
    // madrugada en los bordes.
    const { from, to } = gridRange(cells);
    void fetchRange(from, to).then((items) => {
      if (!cancelled) setMonthItems(items);
    });
    return () => {
      cancelled = true;
    };
  }, [cells]);

  // Agenda: se carga una sola vez y no depende del mes que estés mirando —
  // es lo que evita que una clase del mes que viene quede invisible.
  useEffect(() => {
    let cancelled = false;
    const base = new Date();
    const from = new Date(base.getFullYear(), base.getMonth() - AGENDA_MONTHS_BACK, 1);
    const to = new Date(
      base.getFullYear(),
      base.getMonth() + AGENDA_MONTHS_FORWARD + 1,
      0,
      23,
      59,
      59,
      999,
    );
    void fetchAgenda(from, to, base).then((items) => {
      if (!cancelled) setAgendaItems(items);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const itemsByDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const item of monthItems) {
      const key = dayKeyOf(item.startAt);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return map;
  }, [monthItems]);

  const agenda = useMemo(() => {
    const all = agendaItems ?? [];
    const curso = all.filter((i) => phaseOf(i, now) === 'curso');
    const proximas = all.filter((i) => phaseOf(i, now) === 'proxima');
    // Las pasadas, de más reciente a más antigua, cortadas para no pintar
    // cientos de filas que además se re-renderizarían con cada tick.
    const pasadasTodas = all
      .filter((i) => phaseOf(i, now) === 'pasada')
      .sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime());
    return {
      curso,
      proximas,
      pasadas: pasadasTodas.slice(0, PAST_VISIBLE),
      pasadasOcultas: Math.max(0, pasadasTodas.length - PAST_VISIBLE),
    };
  }, [agendaItems, now]);

  function prevMonth() {
    if (month === 0) {
      setMonth(11);
      setYear((y) => y - 1);
    } else setMonth((m) => m - 1);
  }
  function nextMonth() {
    if (month === 11) {
      setMonth(0);
      setYear((y) => y + 1);
    } else setMonth((m) => m + 1);
  }
  function goToday() {
    const d = new Date();
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  }
  /** Salta el calendario al mes de una cita concreta (desde la agenda). */
  function goToItem(item: CalendarItem) {
    const d = new Date(item.startAt);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    setView('Mes');
  }

  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth();
  const todayKey = dateKeyOf(today);
  const upcoming = agenda.curso.concat(agenda.proximas).slice(0, 6);

  // Cabeceras de la rejilla derivadas del locale activo (L M X J V S D en
  // es-ES). Sin memoizar: el locale se resuelve en cada render y un `useMemo`
  // vacío se quedaría con el del primer render.
  const dayNames = Array.from({ length: 7 }, (_, i) =>
    formatDate(WEEK_SEED_UTC + i * DAY_MS, { weekday: 'narrow', timeZone: 'UTC' }),
  );

  return (
    <div className="flex gap-6">
      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-display text-2xl font-bold text-text">{t('calendarTitle')}</h1>
          <div className="flex items-center gap-2">
            {view === 'Mes' && !isCurrentMonth ? (
              <button
                type="button"
                onClick={goToday}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-muted hover:border-border-strong hover:text-text"
              >
                {t('today')}
              </button>
            ) : null}
            <div className="flex rounded-lg border border-border">
              {(['Mes', 'Agenda', 'Eventos'] as View[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`px-3 py-1.5 text-sm font-medium transition-colors first:rounded-l-[7px] last:rounded-r-[7px] ${
                    view === v
                      ? 'bg-(--didacta-trust) text-white'
                      : 'text-text-muted hover:text-text'
                  }`}
                >
                  {t(VIEW_LABEL_KEY[v])}
                </button>
              ))}
            </div>
          </div>
        </div>

        {view === 'Mes' ? (
          <div className="overflow-hidden rounded-xl border border-border bg-surface">
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <button
                type="button"
                onClick={prevMonth}
                aria-label={t('prevMonth')}
                className="rounded-lg border border-border p-1.5 text-text-muted hover:border-border-strong hover:text-text"
              >
                ←
              </button>
              {/* `first-letter:uppercase`: en español el nombre del mes que
                  devuelve Intl va en minúscula ("agosto de 2026"). En UTC
                  porque es la etiqueta de un mes de la rejilla, no un
                  instante: con la timezone del perfil, el día 1 a medianoche
                  podría caer en el mes anterior. */}
              <h2 className="font-display text-base font-bold text-text first-letter:uppercase">
                {formatDate(Date.UTC(year, month, 1), {
                  month: 'long',
                  year: 'numeric',
                  timeZone: 'UTC',
                })}
              </h2>
              <button
                type="button"
                onClick={nextMonth}
                aria-label={t('nextMonth')}
                className="rounded-lg border border-border p-1.5 text-text-muted hover:border-border-strong hover:text-text"
              >
                →
              </button>
            </div>

            <div className="grid grid-cols-7 border-b border-border">
              {/* Key por índice: en inglés los nombres estrechos se repiten
                  (M T W T F S S) y no sirven como clave. */}
              {dayNames.map((d, i) => (
                <div
                  key={i}
                  className="py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-text-muted"
                >
                  {d}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7">
              {cells.map((cell, i) => {
                const dateKey = dateKeyOf(cell.date);
                const dayItems = itemsByDay.get(dateKey) ?? [];
                const isToday = dateKey === todayKey;
                return (
                  <div
                    key={i}
                    className={`min-h-18 border-b border-r border-border p-1 last:border-r-0 ${
                      !cell.currentMonth ? 'bg-bg-subtle' : ''
                    }`}
                  >
                    <span
                      className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                        isToday
                          ? 'bg-(--didacta-trust) font-bold text-white'
                          : cell.currentMonth
                            ? 'text-text'
                            : // Los días del mes vecino se atenúan, pero si tienen
                              // citas se dejan legibles: son justo los que el bug
                              // anterior escondía.
                              dayItems.length > 0
                              ? 'text-text-muted'
                              : 'text-text-muted/50'
                      }`}
                    >
                      {cell.date.getDate()}
                    </span>
                    {dayItems.slice(0, 2).map((item) => {
                      const phase = phaseOf(item, now);
                      const pill = (
                        <div
                          className={`mt-0.5 truncate rounded px-1 py-0.5 text-[9px] font-medium ${
                            phase === 'pasada'
                              ? 'bg-bg-subtle text-text-muted'
                              : item.kind === 'clase'
                                ? 'bg-(--didacta-growth)/10 text-(--didacta-growth)'
                                : 'bg-(--didacta-trust)/10 text-(--didacta-trust)'
                          }`}
                          title={item.title}
                        >
                          {phase === 'curso' ? '● ' : ''}
                          {formatTime(item.startAt, HHMM)} {item.title}
                        </div>
                      );
                      return item.href ? (
                        <Link key={item.key} href={item.href as never} className="block">
                          {pill}
                        </Link>
                      ) : (
                        <div key={item.key}>{pill}</div>
                      );
                    })}
                    {dayItems.length > 2 && (
                      <div className="mt-0.5 text-[9px] text-text-muted">
                        {t('moreItems', { count: dayItems.length - 2 })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : view === 'Agenda' ? (
          <div className="space-y-5">
            {agendaItems === null ? (
              <div className="space-y-3">
                <div className="skeleton h-20 w-full" />
                <div className="skeleton h-20 w-full" />
              </div>
            ) : agenda.curso.length === 0 &&
              agenda.proximas.length === 0 &&
              agenda.pasadas.length === 0 ? (
              <div className="rounded-xl border border-border bg-surface p-12 text-center">
                <p className="text-base font-semibold text-text">{t('agendaEmptyTitle')}</p>
                <p className="mt-1 text-sm text-text-muted">{t('agendaEmptyHint')}</p>
              </div>
            ) : (
              <>
                <AgendaSection
                  title={t('inProgress')}
                  items={agenda.curso}
                  now={now}
                  onPick={goToItem}
                  emptyHint={null}
                />
                <AgendaSection
                  title={t('upcomingSection')}
                  items={agenda.proximas}
                  now={now}
                  onPick={goToItem}
                  emptyHint={t('noUpcoming')}
                />
                <AgendaSection
                  title={t('pastSection')}
                  items={agenda.pasadas}
                  now={now}
                  onPick={goToItem}
                  emptyHint={null}
                />
                {agenda.pasadasOcultas > 0 ? (
                  <p className="text-xs text-text-muted">
                    {t('pastHidden', {
                      visible: PAST_VISIBLE,
                      months: AGENDA_MONTHS_BACK,
                      hidden: agenda.pasadasOcultas,
                    })}
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <EventosView />
        )}
      </div>

      <aside className="hidden w-60 shrink-0 space-y-4 xl:block">
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.08em] text-text-muted">
            {t('upcomingAppointments')}
          </p>
          {agendaItems === null ? (
            <div className="skeleton h-16 w-full" />
          ) : upcoming.length === 0 ? (
            <p className="text-sm text-text-muted">{t('noUpcomingShort')}</p>
          ) : (
            <ul className="space-y-2">
              {upcoming.map((item) => {
                const live = phaseOf(item, now) === 'curso';
                const inner = (
                  <>
                    <span
                      className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                        item.kind === 'clase' ? 'bg-(--didacta-growth)' : 'bg-(--didacta-trust)'
                      } ${live ? 'animate-pulse' : ''}`}
                    />
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-text leading-tight">
                        {item.title}
                      </p>
                      <p className="text-[10px] text-text-muted">
                        {live
                          ? t('inProgressNow')
                          : t('dateAtTime', {
                              date: formatDate(item.startAt, {
                                day: 'numeric',
                                month: 'short',
                              }),
                              time: formatTime(item.startAt, HHMM),
                            })}
                      </p>
                    </div>
                  </>
                );
                return (
                  <li key={item.key}>
                    {item.href ? (
                      <Link href={item.href as never} className="flex gap-2">
                        {inner}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        onClick={() => goToItem(item)}
                        className="flex w-full gap-2 text-left"
                      >
                        {inner}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

function AgendaSection({
  title,
  items,
  now,
  onPick,
  emptyHint,
}: {
  title: string;
  items: CalendarItem[];
  now: number;
  onPick: (item: CalendarItem) => void;
  /** Si es null y no hay items, la sección no se renderiza. */
  emptyHint: string | null;
}) {
  const t = useTranslations('alumnoAprendizaje');
  if (items.length === 0 && !emptyHint) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-text-muted">
        {title}
        {items.length > 0 ? ` · ${items.length}` : ''}
      </h2>
      {items.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface px-5 py-4 text-sm text-text-muted">
          {emptyHint}
        </p>
      ) : (
        <div className="divide-y divide-border rounded-xl border border-border bg-surface">
          {items.map((item) => {
            const phase = phaseOf(item, now);
            const row = (
              // Sin `opacity` en las pasadas: bajaba el texto secundario a
              // 2.8:1 de contraste (WCAG AA pide 4.5:1). La sección "Pasadas"
              // ya las distingue por sí sola.
              <div className="flex items-center gap-4 px-5 py-4">
                <div className="grid w-12 shrink-0 place-items-center text-center">
                  <span className="text-[11px] font-semibold uppercase text-text-muted">
                    {formatDate(item.startAt, { month: 'short' })}
                  </span>
                  <span className="text-xl font-bold leading-none text-text">
                    {formatDate(item.startAt, { day: 'numeric' })}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-text">{item.title}</p>
                  {/* `first-letter` y no `capitalize`: en español solo va en
                      mayúscula la primera letra de la frase ("lunes, 3 de
                      agosto"), no la de cada palabra. */}
                  <p className="text-xs text-text-muted first-letter:uppercase">
                    {formatDayLong(item.startAt)} · {formatTime(item.startAt, HHMM)}–
                    {formatTime(item.endAt, HHMM)}
                    {item.location ? ` · ${item.location}` : ''}
                  </p>
                </div>
                {phase === 'curso' ? (
                  <span className="shrink-0 rounded-full bg-(--didacta-growth)/10 px-2 py-0.5 text-[10px] font-semibold text-(--didacta-growth)">
                    {t('inProgress')}
                  </span>
                ) : null}
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    item.kind === 'clase'
                      ? 'bg-(--didacta-growth)/10 text-(--didacta-growth)'
                      : 'bg-(--didacta-trust)/10 text-(--didacta-trust)'
                  }`}
                >
                  {item.kind === 'clase' ? t('liveClassChip') : t('eventChip')}
                </span>
                {item.isRegistered ? (
                  <span className="shrink-0 rounded-full bg-(--didacta-growth)/10 px-2 py-0.5 text-[10px] font-semibold text-(--didacta-growth)">
                    {t('registered')}
                  </span>
                ) : null}
              </div>
            );
            return item.href ? (
              <Link
                key={item.key}
                href={item.href as never}
                className="block transition-colors hover:bg-bg-subtle"
              >
                {row}
              </Link>
            ) : (
              <button
                key={item.key}
                type="button"
                onClick={() => onPick(item)}
                className="block w-full text-left transition-colors hover:bg-bg-subtle"
              >
                {row}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
