/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

'use client';

import { useEffect, useState } from 'react';
import { payoutsApi, type PayoutsStatusDto } from './payouts';
import { PLATFORM_PRICE_CURRENCIES, parseMajorInput } from './stripe-currencies';

/**
 * En qué monedas puede poner precio este aula (multidivisa, plan §9).
 *
 *  - Cobros de plataforma (`mode: 'platform'`): las monedas de liquidación de
 *    los países admitidos; por defecto la del creador (su cuenta o su país).
 *    Si elige otra, se le avisa del 2 % de conversión y de que sus alumnos no
 *    verán el precio en su moneda.
 *  - Claves propias o instalación sin cobros de plataforma: las monedas de
 *    siempre de esa pantalla (`ownCurrencies`). Nada cambia.
 */
export interface PricePolicy {
  readonly platform: boolean;
  /** Moneda en la que cobra el creador. `null` si aún no ha conectado (o no aplica). */
  readonly settlementCurrency: string | null;
  readonly currencies: readonly string[];
  /** Moneda inicial de un precio nuevo. */
  readonly defaultCurrency: string;
  /** En modo plataforma: ¿puede vender ya? (`false` = aún no ha conectado sus cobros). */
  readonly ready: boolean;
}

export function pricePolicyFrom(
  status: PayoutsStatusDto | null,
  ownCurrencies: readonly string[],
): PricePolicy {
  if (!status || status.mode !== 'platform') {
    return {
      platform: false,
      settlementCurrency: null,
      currencies: ownCurrencies,
      defaultCurrency: ownCurrencies[0] ?? 'eur',
      ready: true,
    };
  }
  const currencies = status.priceCurrencies?.length
    ? status.priceCurrencies
    : PLATFORM_PRICE_CURRENCIES;
  const settlement = status.settlementCurrency ?? null;
  return {
    platform: true,
    settlementCurrency: settlement,
    currencies,
    defaultCurrency: settlement && currencies.includes(settlement) ? settlement : 'eur',
    ready: status.ready,
  };
}

/** `null` mientras se consulta. Si la consulta falla, la política de siempre. */
export function usePricePolicy(ownCurrencies: readonly string[]): PricePolicy | null {
  const [policy, setPolicy] = useState<PricePolicy | null>(null);
  const key = ownCurrencies.join(',');
  useEffect(() => {
    let alive = true;
    payoutsApi
      .status()
      .catch(() => null)
      .then((status) => {
        if (alive) setPolicy(pricePolicyFrom(status, ownCurrencies));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- la lista se compara por contenido
  }, [key]);
  return policy;
}

/** ¿Hay que avisar de la conversión? Solo en modo plataforma y con otra moneda. */
export function isForeignCurrency(policy: PricePolicy | null, currency: string): boolean {
  return Boolean(
    policy?.platform &&
    policy.settlementCurrency &&
    policy.settlementCurrency !== currency.toLowerCase(),
  );
}

/** Una fila del bloque «Precio fijo para otros países». */
export interface CurrencyOptionDraft {
  currency: string;
  amount: string;
}

export type PriceDraftError =
  | { field: 'amount' }
  | { field: 'option'; index: number; reason: 'invalid' | 'same' | 'duplicate' };

/**
 * Del borrador del formulario al cuerpo de la API: importe en la unidad mínima
 * de Stripe y precios por mercado. Errores por campo para pintarlos.
 * Las filas vacías (sin moneda o sin importe) se ignoran.
 */
export function buildPrice(
  draft: { amount: string; currency: string; options: readonly CurrencyOptionDraft[] },
  locale: string,
): {
  amountCents: number | null;
  currencyOptions: Record<string, number> | null;
  errors: PriceDraftError[];
} {
  const currency = draft.currency.toLowerCase();
  const errors: PriceDraftError[] = [];
  const amountCents = parseMajorInput(draft.amount, currency, locale);
  if (amountCents === null) errors.push({ field: 'amount' });
  const options: Record<string, number> = {};
  draft.options.forEach((row, index) => {
    const code = row.currency.trim().toLowerCase();
    if (!code && !row.amount.trim()) return;
    if (code === currency) {
      errors.push({ field: 'option', index, reason: 'same' });
      return;
    }
    if (code in options) {
      errors.push({ field: 'option', index, reason: 'duplicate' });
      return;
    }
    const minor = /^[a-z]{3}$/.test(code) ? parseMajorInput(row.amount, code, locale) : null;
    if (minor === null) {
      errors.push({ field: 'option', index, reason: 'invalid' });
      return;
    }
    options[code] = minor;
  });
  return {
    amountCents,
    currencyOptions: Object.keys(options).length ? options : null,
    errors,
  };
}

/**
 * Monedas que se ofrecen para un precio fijo por mercado: las que el alumno
 * suele usar en los países donde más se venden cursos en español, inglés y
 * portugués. Lista abierta: es solo la sugerencia del desplegable.
 */
export const MARKET_PRICE_CURRENCIES: readonly string[] = [
  'usd',
  'eur',
  'gbp',
  'mxn',
  'cop',
  'clp',
  'pen',
  'ars',
  'brl',
  'chf',
  'cad',
  'aud',
  'jpy',
];
