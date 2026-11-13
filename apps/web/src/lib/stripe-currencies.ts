/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cuántos decimales tiene una moneda, según STRIPE. Única autoridad del
 * producto para pasar del número que escribe una persona («49,90») al entero
 * que guardan Stripe y la base (4990), y al revés para pintarlo.
 *
 * No se le pregunta al navegador (`Intl…resolvedOptions().maximumFractionDigits`):
 * el CLDR describe cómo se ESCRIBE un precio en la calle y Stripe define en qué
 * unidad se COBRA, y discrepan justo donde duele. En el peso colombiano el CLDR
 * dice cero decimales y Stripe pide dos: el 25-ago-2026 tres planes de VA360
 * salieron a producción cobrando la centésima parte (el anual de 399 € iba a
 * cobrar 3,99 €), y nada lo cazó porque la misma función pintaba la pantalla.
 * Portado de didacta-community (#125, `apps/web/src/lib/divisas-stripe.ts`).
 *
 * Monedas donde `Intl` y Stripe discrepan hoy: COP, HUF, ISK, IDR y CLF.
 *
 * Fuente: https://docs.stripe.com/currencies#zero-decimal
 */

/**
 * Monedas sin decimales: el importe que se manda a Stripe ES el que se cobra.
 * Para cobrar 500 JPY se manda `500`.
 *
 * ISK y UGX NO están: perdieron los decimales, pero Stripe sigue exigiendo
 * mandarlas con dos decimales acabados en `00` (ver `STRIPE_WHOLE_UNIT_CURRENCIES`).
 */
export const STRIPE_ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
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

/**
 * Monedas de dos decimales que no admiten fracciones al cobrar: el importe debe
 * acabar en `00`. Stripe rechaza 5,50 ISK; no lo redondea.
 *
 * HUF y TWD tienen esa restricción solo en transferencias, no en cobros: no
 * entran (bloquear un precio válido sería peor).
 */
export const STRIPE_WHOLE_UNIT_CURRENCIES: ReadonlySet<string> = new Set(['isk', 'ugx']);

/**
 * Monedas en las que un creador de Didacta Cloud puede poner precio: las de
 * liquidación de los países admitidos (`PAYMENTS_PLATFORM_SUPPORTED_COUNTRIES`).
 * Misma lista, en el mismo orden, que `PLATFORM_PRICE_CURRENCIES` de
 * `modules/payouts/src/currencies.ts`, que la valida en el servidor.
 */
export const PLATFORM_PRICE_CURRENCIES: readonly string[] = [
  'eur',
  'gbp',
  'chf',
  'sek',
  'dkk',
  'nok',
  'pln',
  'czk',
  'huf',
  'ron',
  'usd',
  'cad',
];

/** Monedas que se ofrecían siempre con claves propias (Community). No cambia. */
export const OWN_KEYS_PRICE_CURRENCIES: readonly string[] = ['eur', 'usd', 'gbp', 'mxn'];

const norm = (currency: string) => currency.trim().toLowerCase();

/** Decimales de la moneda en Stripe: 0 o 2. Lo desconocido se trata como 2, la norma. */
export function stripeDecimals(currency: string): 0 | 2 {
  return STRIPE_ZERO_DECIMAL_CURRENCIES.has(norm(currency)) ? 0 : 2;
}

/** Unidades mínimas por unidad: 100 en el euro, 1 en el yen. */
export function minorPerMajor(currency: string): number {
  return stripeDecimals(currency) === 0 ? 1 : 100;
}

/** Unidad mínima de Stripe → unidades de la moneda (4990 EUR → 49,9; 500 JPY → 500). */
export function minorToMajor(amount: number, currency: string): number {
  return amount / minorPerMajor(currency);
}

/** Unidades de la moneda → unidad mínima de Stripe, sin perder céntimos por coma flotante. */
export function majorToMinor(major: number, currency: string): number {
  return Math.round(major * minorPerMajor(currency));
}

/**
 * ¿Es un importe (en unidad mínima) cobrable en esa moneda? Entero positivo y,
 * en ISK/UGX, sin fracción. El resto de la validación vive en el servidor.
 */
export function isValidStripeAmount(minor: number, currency: string): boolean {
  if (!Number.isInteger(minor) || minor <= 0) return false;
  return STRIPE_WHOLE_UNIT_CURRENCIES.has(norm(currency)) ? minor % 100 === 0 : true;
}

/**
 * Lo que escribe el creador («49», «49,90», «49.9», «39 900», «39.900»,
 * «1.200,50»; en inglés «1,200.50») → unidad mínima de Stripe. `null` si no es un importe válido
 * y positivo para esa moneda. Sin redondeos: más decimales de los que admite la
 * moneda es un error, no se recorta en silencio.
 */
export function parseMajorInput(input: string, currency: string, locale = 'es'): number | null {
  // `\s` ya cubre el espacio duro y el fino que pega `Intl` al formatear.
  const compact = input.trim().replace(/\s/g, '');
  if (!compact) return null;
  const decimals = stripeDecimals(currency);
  // Separador de miles del idioma: punto en español («39.900», «1.200,50»),
  // coma en inglés («1,200.50»). Un grupo de tres cifras tras el OTRO
  // separador («49,999» en español) es ambiguo y se rechaza: mejor que el
  // creador lo reescriba a cobrar mil veces más. En monedas sin decimales los
  // dos separadores son de miles («7.900» o «7,900» yenes).
  const group = locale.startsWith('en') ? ',' : '.';
  const point = group === '.' ? ',' : '.';
  const g = group === '.' ? '\\.' : ',';
  const p = point === '.' ? '\\.' : ',';
  let normalized = compact;
  if (decimals === 0 && /^\d{1,3}([.,]\d{3})+$/.test(compact)) {
    normalized = compact.replace(/[.,]/g, '');
  } else if (new RegExp(`^\\d{1,3}(${g}\\d{3})+(${p}\\d{1,2})?$`).test(compact)) {
    normalized = compact.split(group).join('').replace(point, '.');
  } else if (new RegExp(`^\\d+${p}\\d{3,}$`).test(compact)) {
    return null;
  }
  const match =
    decimals === 0
      ? /^(\d{1,12})$/.exec(normalized)
      : /^(\d{1,12})(?:[.,](\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const units = Number(match[1]);
  const fraction = decimals === 0 ? 0 : Number((match[2] ?? '').padEnd(2, '0') || '0');
  const minor = decimals === 0 ? units : units * 100 + fraction;
  return isValidStripeAmount(minor, currency) ? minor : null;
}

/** Unidad mínima → texto editable en un campo («49,90» en español, «49.90» en inglés). */
export function minorToInput(amount: number, currency: string, locale = 'es'): string {
  if (stripeDecimals(currency) === 0) return String(amount);
  const whole = amount % 100 === 0;
  const text = whole ? String(amount / 100) : (amount / 100).toFixed(2);
  return locale.startsWith('en') ? text : text.replace('.', ',');
}
