'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { eventsApi, type CommunityEvent } from '@/lib/events';
import { zoomLiveApi, type ZoomSession } from '@/modules/zoom-live';
import { EventosView } from './eventos-view';

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

/** Ventana de la agenda: medio año atrás y un año hacia delante. */
const AGENDA_MONTHS_BACK = 6;
const AGENDA_MONTHS_FORWARD = 12;
/** Cada cuánto recalculamos "en curso" sin recargar datos. */
const TICK_MS = 60_000;
/** Cuántas citas pasadas se pintan antes de cortar (evita listas enormes). */
const PAST_VISIBLE = 25;
/**
 * Margen tras la hora de fin durante el que una sesión marcada STARTED sigue
 * contando como "en curso". Zoom no siempre entrega `meeting.ended` (endpoint
 * caído, reintentos agotados), así que sin esta cota una clase se quedaría
 * "En curso" para siempre y coparía la barra lateral.
 */
const LIVE_GRACE_MS = 2 * 60 * 60 * 1000;

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

function dayKeyOf(iso: string): string {
  const d = new Date(iso);
  return toDateStr(d.getFullYear(), d.getMonth(), d.getDate());
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function formatDayLong(iso: string): string {
  return new Date(iso).toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
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
  endAt: string;
  isRegistered: boolean;
  location: string | null;
  /**
   * Estado real de la sesión Zoom. `null` para eventos de comunidad, que no
   * tienen estado y se clasifican solo por reloj.
   */
  status: 'SCHEDULED' | 'STARTED' | 'ENDED' | null;
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
    isRegistered: e.isRegistered,
    location: e.location,
    status: null,
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
      isRegistered: s.isRegistered,
      location: null,
      status: s.status === 'CANCELLED' ? null : s.status,
      href: `/clase/${s.id}`,
    }));
  return [...fromEvents, ...fromSessions].sort(
    (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
  );
}

/** Carga ambas fuentes en paralelo; si una falla, la otra se muestra igual. */
async function fetchRange(from: Date, to: Date): Promise<CalendarItem[]> {
  const [events, sessions] = await Promise.all([
    eventsApi
      .list({ from: from.toISOString(), to: to.toISOString(), limit: 100 })
      .catch(() => [] as CommunityEvent[]),
    zoomLiveApi
      .list({ from: from.toISOString(), to: to.toISOString() })
      .catch(() => [] as ZoomSession[]),
  ]);
  return toItems(events, sessions);
}

/**
 * Agenda: presupuestos SEPARADOS para pasado y futuro.
 *
 * `mod.events` tiene un tope duro de 100 filas y ordena por fecha, así que
 * una única consulta a 18 meses gastaría el cupo en los eventos más antiguos
 * y dejaría el futuro fuera — justo el bug que esta vista viene a arreglar.
 * Pedimos el pasado en `desc` (los 100 más recientes) y el futuro en `asc`
 * (los 100 más cercanos). Las clases Zoom no tienen tope, así que van en una
 * sola consulta.
 */
async function fetchAgenda(from: Date, to: Date, pivot: Date): Promise<CalendarItem[]> {
  const [pastEvents, futureEvents, sessions] = await Promise.all([
    eventsApi
      .list({ from: from.toISOString(), to: pivot.toISOString(), limit: 100, order: 'desc' })
      .catch(() => [] as CommunityEvent[]),
    eventsApi
      .list({ from: pivot.toISOString(), to: to.toISOString(), limit: 100, order: 'asc' })
      .catch(() => [] as CommunityEvent[]),
    zoomLiveApi
      .list({ from: from.toISOString(), to: to.toISOString() })
      .catch(() => [] as ZoomSession[]),
  ]);
  // Los dos tramos comparten el instante pivote: deduplicamos por id.
  const byId = new Map<string, CommunityEvent>();
  for (const e of [...pastEvents, ...futureEvents]) byId.set(e.id, e);
  return toItems([...byId.values()], sessions);
}

type Phase = 'curso' | 'proxima' | 'pasada';

function phaseOf(item: CalendarItem, now: number): Phase {
  const start = new Date(item.startAt).getTime();
  const end = new Date(item.endAt).getTime();
  // El estado real de Zoom manda sobre el reloj, pero acotado: ENDED es
  // pasado aunque la ventana teórica siga abierta (el formador cerró antes),
  // y STARTED deja de ser "en curso" pasado el margen de gracia.
  if (item.status === 'ENDED') return 'pasada';
  if (item.status === 'STARTED') {
    // STARTED solo es "en curso" dentro de su ventana (con margen): una
    // sesión futura con un `meeting.started` espurio no puede anunciarse
    // como en directo hoy, ni una vieja quedarse así para siempre.
    if (now < start) return 'proxima';
    return now <= end + LIVE_GRACE_MS ? 'curso' : 'pasada';
  }
  if (now >= start && now <= end) return 'curso';
  return now < start ? 'proxima' : 'pasada';
}

type View = 'Mes' | 'Agenda' | 'Eventos';

export default function CalendarioPage() {
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

  // Rejilla del mes visible.
  useEffect(() => {
    let cancelled = false;
    // Límites del mes en hora LOCAL del navegador (no UTC): la grilla agrupa
    // por día local, así que pedir el rango en UTC dejaría fuera las citas
    // de madrugada en los bordes del mes.
    const from = new Date(year, month, 1);
    const to = new Date(year, month, getDaysInMonth(year, month), 23, 59, 59, 999);
    void fetchRange(from, to).then((items) => {
      if (!cancelled) setMonthItems(items);
    });
    return () => {
      cancelled = true;
    };
  }, [year, month]);

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
  const upcoming = agenda.curso.concat(agenda.proximas).slice(0, 6);

  return (
    <div className="flex gap-6">
      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-display text-2xl font-bold text-text">Agenda · Calendario</h1>
          <div className="flex items-center gap-2">
            {view === 'Mes' && !isCurrentMonth ? (
              <button
                type="button"
                onClick={goToday}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-muted hover:border-border-strong hover:text-text"
              >
                Hoy
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
                aria-label="Mes anterior"
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
                aria-label="Mes siguiente"
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
                          {formatTime(item.startAt)} {item.title}
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
                <p className="text-base font-semibold text-text">
                  No hay eventos ni clases programados
                </p>
                <p className="mt-1 text-sm text-text-muted">
                  Los próximos eventos y clases en directo aparecerán aquí cuando estén disponibles.
                </p>
              </div>
            ) : (
              <>
                <AgendaSection
                  title="En curso"
                  items={agenda.curso}
                  now={now}
                  onPick={goToItem}
                  emptyHint={null}
                />
                <AgendaSection
                  title="Próximas"
                  items={agenda.proximas}
                  now={now}
                  onPick={goToItem}
                  emptyHint="No hay nada programado por delante."
                />
                <AgendaSection
                  title="Pasadas"
                  items={agenda.pasadas}
                  now={now}
                  onPick={goToItem}
                  emptyHint={null}
                />
                {agenda.pasadasOcultas > 0 ? (
                  <p className="text-xs text-text-muted">
                    Se muestran las {PAST_VISIBLE} más recientes de los últimos {AGENDA_MONTHS_BACK}{' '}
                    meses ({agenda.pasadasOcultas} más antiguas ocultas).
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
            Próximas citas
          </p>
          {agendaItems === null ? (
            <div className="skeleton h-16 w-full" />
          ) : upcoming.length === 0 ? (
            <p className="text-sm text-text-muted">Sin eventos ni clases próximos.</p>
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
                          ? 'En curso ahora'
                          : `${new Date(item.startAt).toLocaleDateString('es-ES', {
                              day: 'numeric',
                              month: 'short',
                            })} · ${formatTime(item.startAt)}`}
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
                    {MONTH_NAMES[new Date(item.startAt).getMonth()]?.slice(0, 3)}
                  </span>
                  <span className="text-xl font-bold leading-none text-text">
                    {new Date(item.startAt).getDate()}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-text">{item.title}</p>
                  {/* `first-letter` y no `capitalize`: en español solo va en
                      mayúscula la primera letra de la frase ("lunes, 3 de
                      agosto"), no la de cada palabra. */}
                  <p className="text-xs text-text-muted first-letter:uppercase">
                    {formatDayLong(item.startAt)} · {formatTime(item.startAt)}–
                    {formatTime(item.endAt)}
                    {item.location ? ` · ${item.location}` : ''}
                  </p>
                </div>
                {phase === 'curso' ? (
                  <span className="shrink-0 rounded-full bg-(--didacta-growth)/10 px-2 py-0.5 text-[10px] font-semibold text-(--didacta-growth)">
                    En curso
                  </span>
                ) : null}
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    item.kind === 'clase'
                      ? 'bg-(--didacta-growth)/10 text-(--didacta-growth)'
                      : 'bg-(--didacta-trust)/10 text-(--didacta-trust)'
                  }`}
                >
                  {item.kind === 'clase' ? 'Clase en directo' : 'Evento'}
                </span>
                {item.isRegistered ? (
                  <span className="shrink-0 rounded-full bg-(--didacta-growth)/10 px-2 py-0.5 text-[10px] font-semibold text-(--didacta-growth)">
                    Inscrito
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
