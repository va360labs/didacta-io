/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Meses y días en la hora de España peninsular (`Europe/Madrid`), que es la
 * del emisor: una venta del 31 de enero a las 23:30 en Madrid es de enero,
 * aunque en UTC ya sea 31 a las 22:30 (invierno) o 21:30 (verano).
 */

export const INVOICE_TIME_ZONE = 'Europe/Madrid';

/** `YYYY-MM`. */
export type MonthKey = string;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function parseMonthKey(key: string): { year: number; month: number } {
  const match = MONTH_RE.exec(key);
  if (!match) throw new RangeError(`mes no válido: «${key}» (se espera AAAA-MM)`);
  return { year: Number(match[1]), month: Number(match[2]) };
}

export function monthKey(year: number, month: number): MonthKey {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/** Fecha (año, mes, día) de un instante en Madrid. */
export function madridDate(at: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: INVOICE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** Desfase de Madrid respecto a UTC en un instante, en milisegundos. */
function madridOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: INVOICE_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Instante UTC de las 00:00 de un día en Madrid. */
export function madridMidnight(year: number, month: number, day: number): Date {
  const guess = Date.UTC(year, month - 1, day);
  let instant = guess - madridOffsetMs(new Date(guess));
  // Segunda pasada: el desfase puede cambiar entre la conjetura y el resultado
  // (días de cambio de hora).
  instant = guess - madridOffsetMs(new Date(instant));
  return new Date(instant);
}

/**
 * Periodo de facturación de un mes: `[start, end)` en instantes UTC y las
 * fechas (sin hora) del primer y del último día, para la factura.
 */
export function monthPeriod(key: MonthKey): {
  readonly start: Date;
  readonly end: Date;
  readonly firstDay: Date;
  readonly lastDay: Date;
} {
  const { year, month } = parseMonthKey(key);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const lastDayNumber = new Date(Date.UTC(nextYear, nextMonth - 1, 0)).getUTCDate();
  return {
    start: madridMidnight(year, month, 1),
    end: madridMidnight(nextYear, nextMonth, 1),
    firstDay: new Date(Date.UTC(year, month - 1, 1)),
    lastDay: new Date(Date.UTC(year, month - 1, lastDayNumber)),
  };
}

/** El mes anterior al del instante dado (en Madrid). */
export function previousMonthKey(at: Date): MonthKey {
  const { year, month } = madridDate(at);
  return month === 1 ? monthKey(year - 1, 12) : monthKey(year, month - 1);
}

/** El día de hoy en Madrid como fecha sin hora (00:00 UTC de ese día). */
export function madridToday(at: Date): Date {
  const { year, month, day } = madridDate(at);
  return new Date(Date.UTC(year, month - 1, day));
}
