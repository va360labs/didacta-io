import { eventsApi, type CommunityEvent } from '@/lib/events';
import { zoomLiveApi, type ZoomSession } from '@/modules/zoom-live';

/**
 * Agenda unificada del host: agrega los eventos de comunidad (mod.events) y
 * las clases en directo (mod.zoom-live) sin acoplar los módulos entre sí — la
 * composición vive en el host, nunca en un módulo (ADR-016/ADR-017).
 *
 * La consumen la vista `/calendario` y el bloque «Próximas citas» del feed de
 * la comunidad.
 */
export interface CalendarItem {
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

/**
 * Margen tras la hora de fin durante el que una sesión marcada STARTED sigue
 * contando como "en curso". Zoom no siempre entrega `meeting.ended` (endpoint
 * caído, reintentos agotados), así que sin esta cota una clase se quedaría
 * "En curso" para siempre.
 */
export const LIVE_GRACE_MS = 2 * 60 * 60 * 1000;

export type Phase = 'curso' | 'proxima' | 'pasada';

export function phaseOf(item: CalendarItem, now: number): Phase {
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

export function toItems(events: CommunityEvent[], sessions: ZoomSession[]): CalendarItem[] {
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
export async function fetchRange(from: Date, to: Date): Promise<CalendarItem[]> {
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
 * y dejaría el futuro fuera. Pedimos el pasado en `desc` (los 100 más
 * recientes) y el futuro en `asc` (los 100 más cercanos). Las clases Zoom no
 * tienen tope, así que van en una sola consulta.
 */
export async function fetchAgenda(from: Date, to: Date, pivot: Date): Promise<CalendarItem[]> {
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

/**
 * Trae las próximas citas (en curso + futuras) de una ventana corta. Lo usa el
 * bloque del feed de la comunidad, que no necesita el histórico del calendario.
 */
export async function fetchUpcoming(limit: number, daysAhead = 90): Promise<CalendarItem[]> {
  const now = new Date();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead, 23, 59, 59);
  // Desde ayer, no desde ahora: una clase que empezó hace media hora sigue
  // siendo "en curso" y tiene que salir en el bloque.
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const items = await fetchRange(from, to);
  const millis = now.getTime();
  return items.filter((i) => phaseOf(i, millis) !== 'pasada').slice(0, limit);
}

// ---------------------------------------------------------------------------
// Rejilla del calendario
// ---------------------------------------------------------------------------

/** Celdas de la rejilla mensual: 6 semanas fijas. */
export const GRID_CELLS = 42;

export interface GridCell {
  date: Date;
  currentMonth: boolean;
}

/** Clave `YYYY-MM-DD` en hora LOCAL (no UTC: la rejilla agrupa por día local). */
export function toDateStr(year: number, month: number, day: number): string {
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

export function dayKeyOf(iso: string): string {
  const d = new Date(iso);
  return toDateStr(d.getFullYear(), d.getMonth(), d.getDate());
}

export function dateKeyOf(d: Date): string {
  return toDateStr(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Lunes = 0 … domingo = 6 (la rejilla empieza en lunes, como en España). */
export function getFirstDayOfWeek(year: number, month: number): number {
  const jsDay = new Date(year, month, 1).getDay();
  return jsDay === 0 ? 6 : jsDay - 1;
}

/**
 * Rejilla del mes con la fecha REAL de cada celda, incluidas las de los meses
 * vecinos que rellenan la primera y la última semana.
 *
 * Antes esas celdas no tenían fecha y salían siempre vacías: una clase del 3
 * de agosto era invisible desde la vista de julio aunque su casilla estuviera
 * pintada al pie de la rejilla (bug reportado el 2026-07-30).
 */
export function buildGrid(year: number, month: number): GridCell[] {
  // `1 - firstWeekDay` puede ser ≤ 0: Date normaliza al mes anterior.
  const start = new Date(year, month, 1 - getFirstDayOfWeek(year, month));
  return Array.from({ length: GRID_CELLS }, (_, i) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { date, currentMonth: date.getMonth() === month && date.getFullYear() === year };
  });
}

/** Rango [desde, hasta] que cubre TODA la rejilla visible, en hora local. */
export function gridRange(cells: GridCell[]): { from: Date; to: Date } {
  const first = cells[0]!.date;
  const last = cells[cells.length - 1]!.date;
  return {
    from: new Date(first.getFullYear(), first.getMonth(), first.getDate()),
    to: new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59, 59, 999),
  };
}
