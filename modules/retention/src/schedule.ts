/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Reloj del alumno: en qué hora y en qué día está ÉL, para no escribirle a
 * las 3 de la madrugada ni dos veces el mismo día. Funciones puras sobre
 * `Intl.DateTimeFormat` (sin librerías de fechas), con la zona IANA del perfil.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface LocalClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

/** Fecha y hora de pared en la zona `tz`. */
export function localClock(at: Date, tz: string): LocalClock {
  const parts = formatterFor(tz).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** `YYYY-MM-DD` del día local en `tz`. */
export function localDayKey(at: Date, tz: string): string {
  const c = localClock(at, tz);
  return `${c.year}-${String(c.month).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` en UTC: la clave estable de un día que no depende de la zona. */
export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Desfase de `tz` respecto a UTC en ese instante (ms; Madrid en invierno = +1 h). */
function offsetMs(at: Date, tz: string): number {
  const c = localClock(at, tz);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Instante UTC de una hora de pared en `tz`. Se corrige una vez con el desfase
 * del propio resultado para que un cambio de hora (DST) entre «ahora» y el
 * destino no desplace el envío una hora.
 */
function wallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  tz: string,
  hint: Date,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, 0, 0);
  let guess = naive - offsetMs(hint, tz);
  guess = naive - offsetMs(new Date(guess), tz);
  return new Date(guess);
}

export interface SendWindow {
  /** Hora local desde la que se puede enviar (incluida), 0–23. */
  startHour: number;
  /** Hora local hasta la que se puede enviar (excluida), 1–24. */
  endHour: number;
}

export function isWithinWindow(at: Date, tz: string, w: SendWindow): boolean {
  const { hour } = localClock(at, tz);
  return hour >= w.startHour && hour < w.endHour;
}

/**
 * Primer instante a partir de `at` en el que se puede enviar. Dentro de la
 * franja, `at`; antes de que abra, hoy a la hora de apertura; después de que
 * cierre, mañana a esa hora.
 */
export function nextWindowStart(at: Date, tz: string, w: SendWindow): Date {
  const c = localClock(at, tz);
  if (c.hour >= w.startHour && c.hour < w.endHour) return at;
  if (c.hour < w.startHour) return wallTimeToUtc(c.year, c.month, c.day, w.startHour, tz, at);
  return nextDayWindowStart(at, tz, w);
}

/** Mañana (en la zona del alumno) a la hora en que abre la franja. */
export function nextDayWindowStart(at: Date, tz: string, w: SendWindow): Date {
  const c = localClock(at, tz);
  const tomorrow = new Date(Date.UTC(c.year, c.month - 1, c.day) + DAY_MS);
  return wallTimeToUtc(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    w.startHour,
    tz,
    new Date(at.getTime() + DAY_MS),
  );
}

export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
}

/**
 * Suma años de calendario respetando el 29 de febrero (cae el 28 en los años
 * que no son bisiestos, no el 1 de marzo).
 */
export function addYears(at: Date, years: number): Date {
  const y = at.getUTCFullYear() + years;
  const m = at.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = Math.min(at.getUTCDate(), lastDay);
  return new Date(
    Date.UTC(
      y,
      m,
      d,
      at.getUTCHours(),
      at.getUTCMinutes(),
      at.getUTCSeconds(),
      at.getUTCMilliseconds(),
    ),
  );
}

/** Años completos entre `from` y `to` (0 si aún no ha pasado el primero). */
export function fullYearsBetween(from: Date, to: Date): number {
  let years = to.getUTCFullYear() - from.getUTCFullYear();
  if (addYears(from, years).getTime() > to.getTime()) years -= 1;
  return Math.max(0, years);
}

export function wholeDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}
