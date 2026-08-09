/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Helpers de formato locale-aware. Reemplazan TODO uso directo de
 * `toLocaleDateString('es-ES', …)` / `new Intl.NumberFormat('es-ES', …)` en
 * `apps/web/src` (guardarraíl en eslint.config.mjs; esta carpeta está exenta).
 *
 * Resolución de locale/timezone:
 *  - Client components: el singleton de `user-prefs.ts` (poblado por
 *    `LocaleSync` con el locale activo + la timezone del perfil, fallback a la
 *    del navegador). Los call-sites no pasan nada:
 *      `formatDate(d, { day: 'numeric', month: 'long' })`
 *  - RSC: el singleton está vacío a propósito → se pasa `{ locale }` explícito
 *    (de `await getLocale()`) y `timeZone` explícita si el dato lo exige.
 */

import { DEFAULT_LOCALE } from '@/i18n/config';
import { getBrowserTimeZone, getUserFormatPrefs } from './user-prefs';
import type { TranslatorLike } from './labels';

/** Overrides comunes a todos los helpers. */
export interface FmtOverrides {
  locale?: string;
  timeZone?: string;
}

type DateInput = Date | string | number;

function toDate(d: DateInput): Date {
  return d instanceof Date ? d : new Date(d);
}

function resolveLocale(o?: FmtOverrides): string {
  return o?.locale ?? getUserFormatPrefs().locale ?? DEFAULT_LOCALE;
}

function resolveTimeZone(o?: FmtOverrides): string | undefined {
  return o?.timeZone ?? getUserFormatPrefs().timeZone ?? getBrowserTimeZone();
}

/** Reemplazo mecánico de `d.toLocaleDateString('es-ES', opts)`. */
export function formatDate(d: DateInput, opts?: Intl.DateTimeFormatOptions & FmtOverrides): string {
  const { locale: _l, timeZone: _tz, ...rest } = opts ?? {};
  return toDate(d).toLocaleDateString(resolveLocale(opts), {
    timeZone: resolveTimeZone(opts),
    ...rest,
  });
}

/** Reemplazo de `d.toLocaleString('es-ES', opts)` (fecha + hora). */
export function formatDateTime(
  d: DateInput,
  opts?: Intl.DateTimeFormatOptions & FmtOverrides,
): string {
  const { locale: _l, timeZone: _tz, ...rest } = opts ?? {};
  return toDate(d).toLocaleString(resolveLocale(opts), {
    timeZone: resolveTimeZone(opts),
    ...rest,
  });
}

/** Reemplazo de `d.toLocaleTimeString('es-ES', opts)`. */
export function formatTime(d: DateInput, opts?: Intl.DateTimeFormatOptions & FmtOverrides): string {
  const { locale: _l, timeZone: _tz, ...rest } = opts ?? {};
  return toDate(d).toLocaleTimeString(resolveLocale(opts), {
    timeZone: resolveTimeZone(opts),
    ...rest,
  });
}

/**
 * Reemplazo de `n.toLocaleString('es-ES', opts)` sobre números y de
 * `new Intl.NumberFormat('es-ES', opts).format(n)`.
 */
export function formatNumber(n: number, opts?: Intl.NumberFormatOptions & FmtOverrides): string {
  const { locale: _l, timeZone: _tz, ...rest } = opts ?? {};
  return new Intl.NumberFormat(resolveLocale(opts), rest).format(n);
}

/**
 * Reemplazo del patrón `new Intl.NumberFormat('es-ES', { style: 'currency',
 * currency }).format(v)` (membership, payment-connections, billing, referidos).
 */
export function formatCurrency(
  n: number,
  currency = 'EUR',
  opts?: Intl.NumberFormatOptions & FmtOverrides,
): string {
  return formatNumber(n, { style: 'currency', currency, ...opts });
}

/**
 * Céntimos → string de moneda. Conversión canónica de cents del producto: la
 * regla de decimales («sin decimales si la cantidad es redonda»: 1900 → "19 €")
 * vive aquí y solo aquí. Sustituye a los wrappers locales por página.
 *
 * Para importes que se cotejan con un panel externo (Stripe, la aplicación
 * telemática de Fundae, una factura) el céntimo cero SE ESCRIBE: usa
 * `formatCentsExact`, que es la otra regla y también es única.
 */
export function formatCents(
  cents: number,
  currency = 'EUR',
  opts?: Intl.NumberFormatOptions & FmtOverrides,
): string {
  const whole = cents % 100 === 0;
  return formatCurrency(cents / 100, currency, {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
    ...opts,
  });
}

/**
 * Céntimos → string de moneda CONSERVANDO los decimales de la divisa (1900 →
 * "19,00 €"). Segunda —y última— regla de céntimos del producto.
 *
 * No es una preferencia estética: estas cifras se cuadran a mano contra un
 * sistema de fuera (el dashboard de Stripe, el expediente Fundae, una factura,
 * una liquidación de comisiones) y ahí "19 €" y "19,00 €" no se leen igual de
 * un vistazo. No la unifiques con `formatCents`.
 *
 * No fuerza `minimumFractionDigits`: deja que Intl aplique los dígitos propios
 * de la divisa, que es lo que hacían los wrappers que sustituye (idéntico byte
 * a byte para EUR/USD/GBP y correcto para una divisa cero-decimal como JPY).
 */
export function formatCentsExact(
  cents: number,
  currency = 'EUR',
  opts?: Intl.NumberFormatOptions & FmtOverrides,
): string {
  return formatCurrency(cents / 100, currency, opts);
}

/**
 * Sucesora locale-aware de `formatDuration` de `@/lib/format` (deprecada).
 * Mantiene el contrato: null/undefined/negativo/no-finito → null.
 *
 * `t` = `useTranslations('common')` (client) o
 * `await getTranslations('common')` (RSC). Las keys `duration*` viven en
 * `common.json` con ICU, listas para locales que pluralicen unidades.
 */
export function formatDuration(
  minutes: number | null | undefined,
  t: TranslatorLike,
): string | null {
  if (minutes === null || minutes === undefined) return null;
  if (!Number.isFinite(minutes) || minutes < 0) return null;

  const total = Math.floor(minutes);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (total < 60) return t('durationMinutes', { minutes: mins });
  if (mins === 0) return t('durationHours', { hours });
  return t('durationHoursMinutes', { hours, minutes: mins });
}
