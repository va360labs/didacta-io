/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_PRICE_CURRENCIES,
  STRIPE_WHOLE_UNIT_CURRENCIES,
  STRIPE_ZERO_DECIMAL_CURRENCIES,
  assertPlatformPrice,
  isValidStripeAmount,
  normalizeCurrencyOptions,
  settlementCurrencyOf,
} from '../src/currencies.js';
import { PayoutsPriceCurrencyError } from '../src/errors.js';
import { defaultCurrencyForCountry } from '../src/stripe/accounts-api.js';

const reasonOf = (fn: () => void) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof PayoutsPriceCurrencyError) return [err.reason, err.detail];
    throw err;
  }
  return null;
};

describe('monedas de los precios en modo plataforma', () => {
  it('la lista es la de liquidación de los países admitidos (§9 del plan)', () => {
    expect(PLATFORM_PRICE_CURRENCIES).toEqual([
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
    ]);
    // Cada país con moneda propia liquida en una de la lista.
    for (const country of [
      'ES',
      'DE',
      'CZ',
      'RO',
      'NO',
      'HU',
      'BG',
      'LI',
      'CH',
      'GB',
      'SE',
      'DK',
      'PL',
      'US',
      'CA',
    ]) {
      expect(PLATFORM_PRICE_CURRENCIES).toContain(defaultCurrencyForCountry(country));
    }
    expect(defaultCurrencyForCountry('LI')).toBe('chf');
    expect(defaultCurrencyForCountry('BG')).toBe('eur');
  });

  it('exponentes de Stripe, no de Intl: COP y HUF con decimales, JPY y CLP sin, ISK solo enteros', () => {
    // Intl dice 0 decimales para COP, HUF e ISK; Stripe cobra con 2.
    for (const code of ['cop', 'huf', 'isk']) {
      expect(STRIPE_ZERO_DECIMAL_CURRENCIES.has(code)).toBe(false);
      expect(
        new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions()
          .maximumFractionDigits,
      ).toBe(0);
    }
    expect(STRIPE_ZERO_DECIMAL_CURRENCIES.has('jpy')).toBe(true);
    expect(STRIPE_ZERO_DECIMAL_CURRENCIES.has('clp')).toBe(true);
    expect(STRIPE_WHOLE_UNIT_CURRENCIES.has('isk')).toBe(true);
    expect(isValidStripeAmount(550, 'isk')).toBe(false);
    expect(isValidStripeAmount(500, 'isk')).toBe(true);
    expect(isValidStripeAmount(3_990_000, 'huf')).toBe(true);
    expect(isValidStripeAmount(14_277_000, 'cop')).toBe(true);
    expect(isValidStripeAmount(0, 'eur')).toBe(false);
    expect(isValidStripeAmount(49.5, 'eur')).toBe(false);
  });

  it('assertPlatformPrice: moneda de la lista y cobrable; otra moneda de la lista no es error', () => {
    expect(() => assertPlatformPrice({ currency: 'EUR', amounts: [4900] })).not.toThrow();
    expect(() => assertPlatformPrice({ currency: 'chf', amounts: [10_000] })).not.toThrow();
    expect(() => assertPlatformPrice({ currency: 'huf', amounts: [3_990_000] })).not.toThrow();
    expect(reasonOf(() => assertPlatformPrice({ currency: 'mxn', amounts: [200_000] }))).toEqual([
      'currency_not_supported',
      'MXN',
    ]);
    expect(reasonOf(() => assertPlatformPrice({ currency: 'jpy', amounts: [500] }))).toEqual([
      'currency_not_supported',
      'JPY',
    ]);
    expect(reasonOf(() => assertPlatformPrice({ currency: 'eur', amounts: [0] }))).toEqual([
      'invalid_amount',
      'EUR',
    ]);
  });

  it('precios fijos por mercado: otra moneda, cobrable, sin repetir la principal', () => {
    expect(() =>
      assertPlatformPrice({
        currency: 'eur',
        amounts: [4900],
        currencyOptions: { mxn: 99_900, jpy: 7_900, cop: 22_900_000 },
      }),
    ).not.toThrow();
    expect(
      reasonOf(() =>
        assertPlatformPrice({ currency: 'eur', amounts: [4900], currencyOptions: { eur: 5000 } }),
      ),
    ).toEqual(['invalid_currency_option', 'EUR']);
    expect(
      reasonOf(() =>
        assertPlatformPrice({ currency: 'eur', amounts: [4900], currencyOptions: { isk: 7_950 } }),
      ),
    ).toEqual(['invalid_currency_option', 'ISK']);
    expect(
      reasonOf(() =>
        assertPlatformPrice({ currency: 'eur', amounts: [4900], currencyOptions: { mx: 100 } }),
      ),
    ).toEqual(['invalid_currency_option', 'MX']);
  });

  it('normalizeCurrencyOptions: mismo contenido → mismo JSON; vacío → null', () => {
    expect(normalizeCurrencyOptions({ MXN: 1, cop: 2 })).toEqual({ cop: 2, mxn: 1 });
    expect(JSON.stringify(normalizeCurrencyOptions({ mxn: 1, cop: 2 }))).toBe(
      JSON.stringify(normalizeCurrencyOptions({ COP: 2, MXN: 1 })),
    );
    expect(normalizeCurrencyOptions({})).toBeNull();
    expect(normalizeCurrencyOptions(null)).toBeNull();
  });

  it('settlementCurrencyOf: la de la cuenta, o la de su país si Stripe aún no la ha dicho', () => {
    expect(settlementCurrencyOf(null)).toBeNull();
    expect(settlementCurrencyOf({ defaultCurrency: null, country: 'CH' })).toBe('chf');
    expect(settlementCurrencyOf({ defaultCurrency: 'EUR', country: 'CH' })).toBe('eur');
    expect(settlementCurrencyOf({ defaultCurrency: null, country: 'HU' })).toBe('huf');
  });

  it('la web usa exactamente la misma tabla (apps/web/src/lib/stripe-currencies.ts)', () => {
    const web = readFileSync(
      resolve(__dirname, '../../../apps/web/src/lib/stripe-currencies.ts'),
      'utf8',
    );
    const listAfter = (name: string) => {
      const start = web.indexOf(`export const ${name}`);
      const open = web.indexOf('[', web.indexOf('=', start));
      const block = web.slice(open, web.indexOf(']', open));
      return [...block.matchAll(/'([a-z]{3})'/g)].map((m) => m[1]);
    };
    expect(listAfter('STRIPE_ZERO_DECIMAL_CURRENCIES')).toEqual([
      ...STRIPE_ZERO_DECIMAL_CURRENCIES,
    ]);
    expect(listAfter('STRIPE_WHOLE_UNIT_CURRENCIES')).toEqual([...STRIPE_WHOLE_UNIT_CURRENCIES]);
    expect(listAfter('PLATFORM_PRICE_CURRENCIES')).toEqual([...PLATFORM_PRICE_CURRENCIES]);
  });
});
