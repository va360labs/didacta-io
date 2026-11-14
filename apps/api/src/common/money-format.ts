/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { PLAIN_EMAIL_INTL_LOCALE, type EmailLang } from './branded-email';

/**
 * Divisas sin decimales en Stripe: su «unidad mínima» ya es la unidad (1000 JPY
 * son mil yenes, no diez). Lista de la documentación de Stripe.
 */
const ZERO_DECIMAL = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
]);

/** Importe de Stripe (unidad mínima) legible: «93,25 €», «€93.25», «€ 93,25». */
export function formatMinor(amount: number, currency: string, lang: EmailLang): string {
  const digits = ZERO_DECIMAL.has(currency.toLowerCase()) ? 0 : 2;
  try {
    return new Intl.NumberFormat(PLAIN_EMAIL_INTL_LOCALE[lang], {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(digits === 0 ? amount : amount / 100);
  } catch {
    return `${(digits === 0 ? amount : amount / 100).toFixed(digits)} ${currency.toUpperCase()}`;
  }
}

/**
 * Día legible en el idioma del correo y en la zona del aula: «14 de noviembre
 * de 2026», «14 November 2026», «14 de novembro de 2026». Una zona que `Intl`
 * no conoce cae a UTC (nunca lanza).
 */
export function formatDay(date: Date, lang: EmailLang, timeZone = 'UTC'): string {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' };
  try {
    return new Intl.DateTimeFormat(PLAIN_EMAIL_INTL_LOCALE[lang], { ...opts, timeZone }).format(
      date,
    );
  } catch {
    return new Intl.DateTimeFormat(PLAIN_EMAIL_INTL_LOCALE[lang], {
      ...opts,
      timeZone: 'UTC',
    }).format(date);
  }
}

/** Día y hora con la zona («12 de noviembre de 2026, 17:05 CET»), para la prueba legal. */
export function formatDayTime(date: Date, lang: EmailLang, timeZone = 'Europe/Madrid'): string {
  const opts: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  };
  try {
    return new Intl.DateTimeFormat(PLAIN_EMAIL_INTL_LOCALE[lang], { ...opts, timeZone }).format(
      date,
    );
  } catch {
    return new Intl.DateTimeFormat(PLAIN_EMAIL_INTL_LOCALE[lang], {
      ...opts,
      timeZone: 'Europe/Madrid',
    }).format(date);
  }
}
