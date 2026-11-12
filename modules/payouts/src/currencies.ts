/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { PayoutsPriceCurrencyError } from './errors.js';
import { defaultCurrencyForCountry } from './stripe/accounts-api.js';

/**
 * Monedas de los precios en modo plataforma (multidivisa, plan §9).
 *
 *  - La moneda principal de un precio es, por defecto, la de liquidación del
 *    país del creador: con `on_behalf_of` Stripe liquida sin convertir, el 5 %
 *    sale exacto y Adaptive Pricing enseña el precio en la moneda del alumno.
 *  - Puede elegir otra de esta lista: Stripe cobra un 2 % por convertir (1 % si
 *    es de EE. UU.) dentro de `balance_transaction.fee`, lo paga el creador, y
 *    Adaptive Pricing deja de funcionar. La interfaz se lo avisa en llano.
 *
 * Los decimales de cada moneda son los de STRIPE, no los de `Intl`: COP y HUF
 * cobran con dos decimales; JPY, CLP y KRW sin ninguno; ISK y UGX con dos que
 * deben acabar en 00. Misma tabla que `apps/web/src/lib/stripe-currencies.ts`.
 * Fuente: https://docs.stripe.com/currencies#zero-decimal
 */

/** Monedas de liquidación de los países admitidos, en el orden del selector. */
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

/** Monedas sin decimales en Stripe: el importe que se manda es el que se cobra. */
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

/** Dos decimales que deben acabar en 00 (Stripe rechaza 5,50 ISK; no redondea). */
export const STRIPE_WHOLE_UNIT_CURRENCIES: ReadonlySet<string> = new Set(['isk', 'ugx']);

/** Tope de precios extra por mercado (`currency_options`) en un mismo precio. */
export const MAX_CURRENCY_OPTIONS = 20;

/** ¿Es un importe (unidad mínima) cobrable en esa moneda? */
export function isValidStripeAmount(minor: number, currency: string): boolean {
  if (!Number.isInteger(minor) || minor <= 0) return false;
  return STRIPE_WHOLE_UNIT_CURRENCIES.has(currency.toLowerCase()) ? minor % 100 === 0 : true;
}

/**
 * Moneda de liquidación del creador: la que tiene su cuenta conectada, o la de
 * su país si Stripe aún no la ha dicho. `null` sin cuenta.
 */
export function settlementCurrencyOf(
  account: { readonly defaultCurrency: string | null; readonly country: string } | null,
): string | null {
  if (!account) return null;
  return (
    (account.defaultCurrency ?? defaultCurrencyForCountry(account.country))?.toLowerCase() ?? null
  );
}

export interface PriceCurrencyCheck {
  readonly currency: string;
  readonly amounts: readonly number[];
  /** Precios fijos extra por mercado: moneda → importe en su unidad mínima. */
  readonly currencyOptions?: Readonly<Record<string, number>> | null;
}

/**
 * Valida un precio en modo plataforma. Lanza `PayoutsPriceCurrencyError` (422)
 * con un motivo estable si:
 *  - la moneda principal no es de la lista (`currency_not_supported`);
 *  - un importe no es cobrable en esa moneda (`invalid_amount`);
 *  - un precio extra repite la principal, no es una moneda, sobra o su importe
 *    no es cobrable (`invalid_currency_option`).
 *
 * Que la moneda no sea la de liquidación del creador NO es un error: se avisa
 * en la interfaz (comisión de conversión y sin Adaptive Pricing).
 */
export function assertPlatformPrice(check: PriceCurrencyCheck): void {
  const currency = check.currency.toLowerCase();
  if (!PLATFORM_PRICE_CURRENCIES.includes(currency)) {
    throw new PayoutsPriceCurrencyError('currency_not_supported', currency);
  }
  for (const amount of check.amounts) {
    if (!isValidStripeAmount(amount, currency)) {
      throw new PayoutsPriceCurrencyError('invalid_amount', currency);
    }
  }
  const options = Object.entries(check.currencyOptions ?? {});
  if (options.length > MAX_CURRENCY_OPTIONS) {
    throw new PayoutsPriceCurrencyError('invalid_currency_option', currency);
  }
  for (const [optionCurrency, amount] of options) {
    const code = optionCurrency.toLowerCase();
    if (!/^[a-z]{3}$/.test(code) || code === currency || !isValidStripeAmount(amount, code)) {
      throw new PayoutsPriceCurrencyError('invalid_currency_option', code);
    }
  }
}

/**
 * Mapa de precios extra normalizado (claves en minúsculas, ordenadas) o `null`
 * si no hay ninguno. Dos mapas iguales dan el mismo JSON: sirve para decidir si
 * hay que crear un Price nuevo (los `currency_options` de Stripe son inmutables).
 */
export function normalizeCurrencyOptions(
  options: Readonly<Record<string, number>> | null | undefined,
): Record<string, number> | null {
  const entries = Object.entries(options ?? {})
    .map(([code, amount]) => [code.toLowerCase(), amount] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? Object.fromEntries(entries) : null;
}
