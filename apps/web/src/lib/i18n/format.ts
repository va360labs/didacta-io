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

type LocaleDateMethod = 'toLocaleDateString' | 'toLocaleString' | 'toLocaleTimeString';

/**
 * Motor común de `formatDate`/`formatDateTime`/`formatTime` con su CAMINO
 * DEGRADADO. Los tres reciben una `timeZone` que NO controlamos: sale del
 * perfil del usuario (`LocaleSync` → `setUserFormatPrefs`, locale-sync.tsx:58)
 * y la API la acepta como `z.string().min(1).max(64)` (me.controller.ts:68), sin
 * comprobar que sea una zona IANA. Ante una zona que no reconoce, `Intl` no
 * devuelve nada raro: LANZA `RangeError: Invalid time zone specified`. Con un
 * solo perfil mal guardado, eso tumbaba TODA pantalla con una fecha.
 *
 * Dos escalones, del menos al más destructivo (el dato se conserva siempre):
 *  1. Reintento SIN `timeZone` — el único argumento que aquí viene de dato
 *     ajeno. La fecha sigue formateada en el locale e idioma correctos, solo
 *     que en la zona del navegador.
 *  2. Reintento sin locale ni opciones: `d.toLocale*String()` sin argumentos no
 *     puede lanzar para ningún `Date` (una fecha inválida da "Invalid Date",
 *     que es exactamente lo que ya devolvía antes este helper).
 *
 * El camino feliz queda intacto: si `Intl` no lanza, no se entra en ningún
 * catch y la salida es byte a byte la de siempre.
 */
function formatLocaleDate(
  d: DateInput,
  method: LocaleDateMethod,
  opts?: Intl.DateTimeFormatOptions & FmtOverrides,
): string {
  const date = toDate(d);
  const { locale: _l, timeZone: _tz, ...rest } = opts ?? {};
  const fmt: (locales?: string, options?: Intl.DateTimeFormatOptions) => string =
    date[method].bind(date);
  try {
    return fmt(resolveLocale(opts), { timeZone: resolveTimeZone(opts), ...rest });
  } catch {
    try {
      return fmt(resolveLocale(opts), rest);
    } catch {
      return fmt();
    }
  }
}

/** Reemplazo mecánico de `d.toLocaleDateString('es-ES', opts)`. */
export function formatDate(d: DateInput, opts?: Intl.DateTimeFormatOptions & FmtOverrides): string {
  return formatLocaleDate(d, 'toLocaleDateString', opts);
}

/** Reemplazo de `d.toLocaleString('es-ES', opts)` (fecha + hora). */
export function formatDateTime(
  d: DateInput,
  opts?: Intl.DateTimeFormatOptions & FmtOverrides,
): string {
  return formatLocaleDate(d, 'toLocaleString', opts);
}

/** Reemplazo de `d.toLocaleTimeString('es-ES', opts)`. */
export function formatTime(d: DateInput, opts?: Intl.DateTimeFormatOptions & FmtOverrides): string {
  return formatLocaleDate(d, 'toLocaleTimeString', opts);
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
 * Decimales del importe en el CAMINO DEGRADADO de moneda. No es una preferencia:
 * es el formato exacto que ya daban los `formatAmount`/`fmtAmount` por página a
 * los que sustituyeron estos helpers, y que sí llevaban el `try/catch` que aquí
 * faltaba — `lib/payment-connections.ts:339` (formatAmount),
 * `modules/subscriptions/client.ts:152`, `modules/billing/client.ts:154`,
 * `admin/billing/products/page.tsx:48`,
 * `admin/integraciones/payment-connections/page.tsx:62` y
 * `…/subscriptions-dashboard.tsx:91` (los dos, fmtAmount). Los seis coinciden
 * en el mismo texto: `` `${v.toFixed(2)} ${CUR}` ``.
 */
const FALLBACK_CURRENCY_FRACTION_DIGITS = 2;

/**
 * CAMINO DEGRADADO de moneda: "19.99 EUR".
 *
 * `Intl.NumberFormat` no tolera un código de divisa que no sea ISO-4217 de tres
 * letras: LANZA `RangeError: Invalid currency code`. Y la divisa aquí es DATO
 * AJENO — llega de un proveedor de pago (el `currency` de una suscripción de
 * Stripe/WooCommerce/PayPal, `subscription-tab.tsx:54`, `user-dossier.tsx:68`,
 * `renewal-email-modal.tsx:80`) o de la configuración de un tenant
 * (`admin/membresia/page.tsx:390`, `referidos/page.tsx:228`). Sin este
 * degradado, un código inesperado no da un importe feo: tumba el render entero
 * de la pantalla contra el error boundary.
 */
function fallbackCurrency(value: number, currency: string): string {
  const importe = value.toFixed(FALLBACK_CURRENCY_FRACTION_DIGITS);
  return `${importe} ${String(currency).toUpperCase()}`.trim();
}

/**
 * Reemplazo del patrón `new Intl.NumberFormat('es-ES', { style: 'currency',
 * currency }).format(v)` (membership, payment-connections, billing, referidos).
 *
 * Es el único punto por el que la divisa entra a `Intl`, así que aquí —y no en
 * `formatNumber`— vive el `try/catch`: `formatCents` y `formatCentsExact` lo
 * heredan por delegación. `formatNumber` se queda estricto a propósito: su
 * único argumento con riesgo es el locale, que nunca es dato (sale del conjunto
 * cerrado de `@/i18n/config`, vía override explícito o vía `LocaleSync`).
 */
export function formatCurrency(
  n: number,
  currency = 'EUR',
  opts?: Intl.NumberFormatOptions & FmtOverrides,
): string {
  try {
    return formatNumber(n, { style: 'currency', currency, ...opts });
  } catch {
    return fallbackCurrency(n, opts?.currency ?? currency);
  }
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
