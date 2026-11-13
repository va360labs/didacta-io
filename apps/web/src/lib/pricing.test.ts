/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import type { PayoutsStatusDto } from '@/lib/payouts';
import { buildPrice, isForeignCurrency, pricePolicyFrom } from '@/lib/pricing';
import { OWN_KEYS_PRICE_CURRENCIES, PLATFORM_PRICE_CURRENCIES } from '@/lib/stripe-currencies';

const status = (patch: Partial<PayoutsStatusDto>): PayoutsStatusDto => ({
  platform: true,
  operatorName: 'Didacta',
  mode: 'platform',
  ready: true,
  reason: null,
  account: null,
  supportedCountries: [],
  feeBps: 500,
  ...patch,
});

describe('pricePolicyFrom: en qué monedas puede poner precio el aula', () => {
  it('sin cobros de plataforma (Community) o con claves propias: las monedas de siempre', () => {
    for (const s of [null, status({ mode: 'own' }), status({ mode: 'none' })]) {
      const policy = pricePolicyFrom(s, OWN_KEYS_PRICE_CURRENCIES);
      expect(policy).toMatchObject({
        platform: false,
        currencies: OWN_KEYS_PRICE_CURRENCIES,
        defaultCurrency: 'eur',
      });
      expect(isForeignCurrency(policy, 'mxn')).toBe(false);
    }
  });

  it('modo plataforma: la lista de §9 y por defecto la moneda del creador', () => {
    const swiss = pricePolicyFrom(
      status({ settlementCurrency: 'chf', priceCurrencies: [...PLATFORM_PRICE_CURRENCIES] }),
      OWN_KEYS_PRICE_CURRENCIES,
    );
    expect(swiss).toMatchObject({
      platform: true,
      settlementCurrency: 'chf',
      defaultCurrency: 'chf',
    });
    expect(swiss.currencies).toEqual(PLATFORM_PRICE_CURRENCIES);
    expect(swiss.currencies).not.toContain('mxn');
    // Otra moneda de la lista: se avisa (2 % y sin precio en la moneda del alumno).
    expect(isForeignCurrency(swiss, 'eur')).toBe(true);
    expect(isForeignCurrency(swiss, 'CHF')).toBe(false);
  });

  it('modo plataforma sin cuenta conectada: euro por defecto, sin aviso, ready=false', () => {
    const policy = pricePolicyFrom(status({ ready: false, settlementCurrency: null }), []);
    expect(policy).toMatchObject({
      defaultCurrency: 'eur',
      ready: false,
      settlementCurrency: null,
    });
    expect(policy.currencies).toEqual(PLATFORM_PRICE_CURRENCIES);
    expect(isForeignCurrency(policy, 'usd')).toBe(false);
  });
});

describe('buildPrice: del formulario a la API', () => {
  it('importe y precios por mercado en la unidad mínima de Stripe de cada moneda', () => {
    expect(
      buildPrice(
        {
          amount: '49',
          currency: 'eur',
          options: [
            { currency: 'mxn', amount: '999' },
            { currency: 'jpy', amount: '7.900' },
            { currency: 'cop', amount: '229.000' },
            { currency: '', amount: '' },
          ],
        },
        'es',
      ),
    ).toEqual({
      amountCents: 4900,
      currencyOptions: { mxn: 99_900, jpy: 7_900, cop: 22_900_000 },
      errors: [],
    });
  });

  it('sin precios por mercado: currencyOptions null', () => {
    expect(buildPrice({ amount: '39.900', currency: 'huf', options: [] }, 'es')).toEqual({
      amountCents: 3_990_000,
      currencyOptions: null,
      errors: [],
    });
  });

  it('errores por campo: importe, moneda repetida, la principal, ISK con fracción', () => {
    const built = buildPrice(
      {
        amount: '49,999',
        currency: 'eur',
        options: [
          { currency: 'eur', amount: '50' },
          { currency: 'mxn', amount: '999' },
          { currency: 'mxn', amount: '899' },
          { currency: 'isk', amount: '7950,5' },
        ],
      },
      'es',
    );
    expect(built.amountCents).toBeNull();
    expect(built.errors).toEqual([
      { field: 'amount' },
      { field: 'option', index: 0, reason: 'same' },
      { field: 'option', index: 2, reason: 'duplicate' },
      { field: 'option', index: 3, reason: 'invalid' },
    ]);
  });
});
