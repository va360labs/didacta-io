'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { eventsApi, type CommunityEvent } from '@/lib/events';
import { zoomLiveApi, type ZoomSession } from '@/modules/zoom-live';

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

/**
 * Item unificado del calendario: agrega los eventos de comunidad
 * (mod.events) y las clases en directo (mod.zoom-live) sin acoplar los
 * módulos entre sí — la agregación vive solo en esta vista (ADR-017).
 */
interface CalendarItem {
  key: string;
  kind: 'evento' | 'clase';
  id: string;
  title: string;
  startAt: string;
  endAt: string | null;
  location: string | null;
  isRegistered: boolean;
  /** Solo las clases tienen página de detalle propia. */
  href: string | null;
}

function toItems(events: CommunityEvent[], sessions: ZoomSession[]): CalendarItem[] {
  const fromEvents: CalendarItem[] = events.map((e) => ({
    key: `evento-${e.id}`,
    kind: 'evento',
    id: e.id,
    title: e.title,
    startAt: e.startAt,
    endAt: e.endAt,
    location: e.location,
    isRegistered: e.isRegistered,
    href: null,
  }));
  const fromSessions: CalendarItem[] = sessions
    .filter((s) => s.status !== 'CANCELLED')
    .map((s) => ({
      key: `clase-${s.id}`,
      kind: 'clase',
      id: s.id,
      title: s.topic,
      startAt: s.startTime,
      endAt: new Date(new Date(s.startTime).getTime() + s.durationMinutes * 60_000).toISOString(),
      location: null,
      isRegistered: s.isRegistered,
      href: `/clase/${s.id}`,
    }));
  return [...fromEvents, ...fromSessions].sort(
    (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
  );
}

type View = 'Mes' | 'Lista';

export default function CalendarioPage() {
  const today = new Date();
  const [view, setView] = useState<View>('Mes');
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [items, setItems] = useState<CalendarItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Límites del mes en hora LOCAL del navegador (no UTC): la grilla agrupa
    // por día local, así que pedir el rango en UTC dejaría fuera las citas
    // de madrugada en los bordes del mes (p.ej. 1 de agosto 00:30 local).
    const from = new Date(year, month, 1).toISOString();
    const to = new Date(year, month, getDaysInMonth(year, month), 23, 59, 59, 999).toISOString();
    // Ambas fuentes en paralelo; si una falla, la otra se muestra igual.
    Promise.all([
      eventsApi.list({ from, to }).catch(() => [] as CommunityEvent[]),
      zoomLiveApi.list({ from, to }).catch(() => [] as ZoomSession[]),
    ]).then(([events, sessions]) => {
      if (!cancelled) setItems(toItems(events, sessions));
    });
    return () => {
      cancelled = true;
    };
  }, [year, month]);

  const itemsByDay = new Map<string, CalendarItem[]>();
  for (const item of items) {
    const d = new Date(item.startAt);
    const key = toDateStr(d.getFullYear(), d.getMonth(), d.getDate());
    if (!itemsByDay.has(key)) itemsByDay.set(key, []);
    itemsByDay.get(key)!.push(item);
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

  const upcomingItems = items.filter((i) => new Date(i.startAt) >= today).slice(0, 5);

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
                const dayItems = dateKey ? (itemsByDay.get(dateKey) ?? []) : [];
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
                    {dayItems.slice(0, 2).map((item) => {
                      const pill = (
                        <div
                          className={`mt-0.5 truncate rounded px-1 py-0.5 text-[9px] font-medium ${
                            item.kind === 'clase'
                              ? 'bg-(--didacta-growth)/10 text-(--didacta-growth)'
                              : 'bg-(--didacta-trust)/10 text-(--didacta-trust)'
                          }`}
                        >
                          {formatEventTime(item.startAt)} {item.title}
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
                        +{dayItems.length - 2} más
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-surface divide-y divide-border">
            {items.length === 0 ? (
              <div className="p-12 text-center">
                <p className="text-base font-semibold text-text">
                  No hay eventos ni clases programados
                </p>
                <p className="mt-1 text-sm text-text-muted">
                  Los próximos eventos y clases en directo aparecerán aquí cuando estén disponibles.
                </p>
              </div>
            ) : (
              items.map((item) => {
                const row = (
                  <div className="flex items-center gap-4 px-5 py-4">
                    <div className="grid w-12 shrink-0 place-items-center text-center">
                      <span className="text-[11px] font-semibold uppercase text-text-muted">
                        {MONTH_NAMES[new Date(item.startAt).getMonth()]?.slice(0, 3)}
                      </span>
                      <span className="text-xl font-bold text-text leading-none">
                        {new Date(item.startAt).getDate()}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-text">{item.title}</p>
                      <p className="text-xs text-text-muted">
                        {formatEventTime(item.startAt)}
                        {item.endAt ? ` – ${formatEventTime(item.endAt)}` : ''}
                        {item.location && ` · ${item.location}`}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        item.kind === 'clase'
                          ? 'bg-(--didacta-growth)/10 text-(--didacta-growth)'
                          : 'bg-(--didacta-trust)/10 text-(--didacta-trust)'
                      }`}
                    >
                      {item.kind === 'clase' ? 'Clase en directo' : 'Evento'}
                    </span>
                    {item.isRegistered && (
                      <span className="shrink-0 rounded-full bg-(--didacta-growth)/10 px-2 py-0.5 text-[10px] font-semibold text-(--didacta-growth)">
                        Inscrito
                      </span>
                    )}
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
                  <div key={item.key}>{row}</div>
                );
              })
            )}
          </div>
        )}
      </div>

      <aside className="hidden w-60 shrink-0 space-y-4 xl:block">
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.08em] text-text-muted">
            Próximas citas
          </p>
          {upcomingItems.length === 0 ? (
            <p className="text-sm text-text-muted">Sin eventos ni clases próximos.</p>
          ) : (
            <ul className="space-y-2">
              {upcomingItems.map((item) => {
                const inner = (
                  <>
                    <span
                      className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                        item.kind === 'clase' ? 'bg-(--didacta-growth)' : 'bg-(--didacta-trust)'
                      }`}
                    />
                    <div>
                      <p className="text-xs font-medium text-text leading-tight">{item.title}</p>
                      <p className="text-[10px] text-text-muted">
                        {new Date(item.startAt).toLocaleDateString('es-ES', {
                          day: 'numeric',
                          month: 'short',
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
                      <span className="flex gap-2">{inner}</span>
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
