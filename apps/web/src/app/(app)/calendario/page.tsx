'use client';

import { useEffect, useState } from 'react';
import { eventsApi, type CommunityEvent } from '@/lib/events';

const MONTH_NAMES = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];
const DAY_NAMES = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number) {
  const jsDay = new Date(year, month, 1).getDay();
  return jsDay === 0 ? 6 : jsDay - 1;
}

function toDateStr(year: number, month: number, day: number): string {
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

function formatEventTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

type View = 'Mes' | 'Lista';

export default function CalendarioPage() {
  const today = new Date();
  const [view, setView] = useState<View>('Mes');
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [events, setEvents] = useState<CommunityEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    const from = toDateStr(year, month, 1);
    const to = toDateStr(year, month, getDaysInMonth(year, month));
    eventsApi
      .list({ from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` })
      .then((data) => {
        if (!cancelled) setEvents(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [year, month]);

  const eventsByDay = new Map<string, CommunityEvent[]>();
  for (const e of events) {
    const d = toDateStr(
      new Date(e.startAt).getFullYear(),
      new Date(e.startAt).getMonth(),
      new Date(e.startAt).getDate(),
    );
    if (!eventsByDay.has(d)) eventsByDay.set(d, []);
    eventsByDay.get(d)!.push(e);
  }

  const daysInMonth = getDaysInMonth(year, month);
  const firstWeekDay = getFirstDayOfWeek(year, month);
  const prevMonthDays = getDaysInMonth(year, month - 1 < 0 ? 11 : month - 1);

  const cells: Array<{ day: number; currentMonth: boolean }> = [];
  for (let i = firstWeekDay - 1; i >= 0; i--) {
    cells.push({ day: prevMonthDays - i, currentMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, currentMonth: true });
  }
  const remaining = 42 - cells.length;
  for (let d = 1; d <= remaining; d++) {
    cells.push({ day: d, currentMonth: false });
  }

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

  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth();

  const upcomingEvents = events.filter((e) => new Date(e.startAt) >= today).slice(0, 5);

  return (
    <div className="flex gap-6">
      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-2xl font-bold text-text">Agenda · Calendario</h1>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-border">
              {(['Mes', 'Lista'] as View[]).map((v) => (
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
                  {v}
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
                className="rounded-lg border border-border p-1.5 text-text-muted hover:border-border-strong hover:text-text"
              >
                ←
              </button>
              <h2 className="font-display text-base font-bold text-text">
                {MONTH_NAMES[month]} {year}
              </h2>
              <button
                type="button"
                onClick={nextMonth}
                className="rounded-lg border border-border p-1.5 text-text-muted hover:border-border-strong hover:text-text"
              >
                →
              </button>
            </div>

            <div className="grid grid-cols-7 border-b border-border">
              {DAY_NAMES.map((d) => (
                <div
                  key={d}
                  className="py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-text-muted"
                >
                  {d}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7">
              {cells.map((cell, i) => {
                const isToday = cell.currentMonth && isCurrentMonth && cell.day === today.getDate();
                const dateKey = cell.currentMonth ? toDateStr(year, month, cell.day) : '';
                const dayEvents = dateKey ? (eventsByDay.get(dateKey) ?? []) : [];
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
                            : 'text-text-muted/50'
                      }`}
                    >
                      {cell.day}
                    </span>
                    {dayEvents.slice(0, 2).map((e) => (
                      <div
                        key={e.id}
                        className="mt-0.5 truncate rounded bg-(--didacta-trust)/10 px-1 py-0.5 text-[9px] font-medium text-(--didacta-trust)"
                      >
                        {formatEventTime(e.startAt)} {e.title}
                      </div>
                    ))}
                    {dayEvents.length > 2 && (
                      <div className="mt-0.5 text-[9px] text-text-muted">
                        +{dayEvents.length - 2} más
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-surface divide-y divide-border">
            {events.length === 0 ? (
              <div className="p-12 text-center">
                <p className="text-base font-semibold text-text">No hay eventos programados</p>
                <p className="mt-1 text-sm text-text-muted">
                  Los próximos eventos aparecerán aquí cuando estén disponibles.
                </p>
              </div>
            ) : (
              events.map((e) => (
                <div key={e.id} className="flex items-center gap-4 px-5 py-4">
                  <div className="grid w-12 shrink-0 place-items-center text-center">
                    <span className="text-[11px] font-semibold uppercase text-text-muted">
                      {MONTH_NAMES[new Date(e.startAt).getMonth()]?.slice(0, 3)}
                    </span>
                    <span className="text-xl font-bold text-text leading-none">
                      {new Date(e.startAt).getDate()}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-text">{e.title}</p>
                    <p className="text-xs text-text-muted">
                      {formatEventTime(e.startAt)} – {formatEventTime(e.endAt)}
                      {e.location && ` · ${e.location}`}
                    </p>
                  </div>
                  {e.isRegistered && (
                    <span className="shrink-0 rounded-full bg-(--didacta-growth)/10 px-2 py-0.5 text-[10px] font-semibold text-(--didacta-growth)">
                      Inscrito
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <aside className="hidden w-60 shrink-0 space-y-4 xl:block">
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.08em] text-text-muted">
            Próximos eventos
          </p>
          {upcomingEvents.length === 0 ? (
            <p className="text-sm text-text-muted">Sin eventos próximos.</p>
          ) : (
            <ul className="space-y-2">
              {upcomingEvents.map((e) => (
                <li key={e.id} className="flex gap-2">
                  <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-(--didacta-trust)" />
                  <div>
                    <p className="text-xs font-medium text-text leading-tight">{e.title}</p>
                    <p className="text-[10px] text-text-muted">
                      {new Date(e.startAt).toLocaleDateString('es-ES', {
                        day: 'numeric',
                        month: 'short',
                      })}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
