/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { formatCents, formatCentsExact, formatStripeMinor } from '@/lib/i18n/format';
import {
  isValidStripeAmount,
  majorToMinor,
  minorPerMajor,
  minorToInput,
  minorToMajor,
  parseMajorInput,
  stripeDecimals,
} from '@/lib/stripe-currencies';

// Lo que dice el CLDR, para demostrar que NO coincide con Stripe: es el motivo de esta tabla.
const intlDecimals = (code: string) =>
  // eslint-disable-next-line no-restricted-syntax -- comparación deliberada con Intl
  new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions()
    .maximumFractionDigits;

describe('exponentes de Stripe (no de Intl)', () => {
  it('COP y HUF: Intl dice 0 decimales, Stripe cobra con 2', () => {
    for (const code of ['cop', 'huf']) {
      expect(intlDecimals(code)).toBe(0);
      expect(stripeDecimals(code)).toBe(2);
      expect(minorPerMajor(code)).toBe(100);
    }
    // 142.770 COP se guardan como 14.277.000 (no 142.770: eso cobraría 1.427,70).
    expect(majorToMinor(142_770, 'cop')).toBe(14_277_000);
    expect(minorToMajor(3_990_000, 'huf')).toBe(39_900);
  });

  it('JPY y CLP: sin decimales en Stripe y en Intl', () => {
    for (const code of ['jpy', 'clp']) {
      expect(stripeDecimals(code)).toBe(0);
      expect(minorPerMajor(code)).toBe(1);
    }
    expect(majorToMinor(500, 'jpy')).toBe(500);
    expect(minorToMajor(19_990, 'clp')).toBe(19_990);
  });

  it('ISK: dos decimales en Stripe que deben acabar en 00', () => {
    expect(intlDecimals('isk')).toBe(0);
    expect(stripeDecimals('isk')).toBe(2);
    expect(isValidStripeAmount(795_000, 'isk')).toBe(true);
    expect(isValidStripeAmount(795_050, 'isk')).toBe(false);
  });

  it('una moneda desconocida se trata como de dos decimales', () => {
    expect(stripeDecimals('xyz')).toBe(2);
  });
});

describe('parseMajorInput: lo que escribe el creador → unidad mínima', () => {
  it('euro: coma o punto decimal, sin redondeos', () => {
    expect(parseMajorInput('49', 'eur')).toBe(4900);
    expect(parseMajorInput('49,90', 'eur')).toBe(4990);
    expect(parseMajorInput('49.9', 'eur')).toBe(4990);
    expect(parseMajorInput(' 1 200,50 ', 'eur')).toBe(120_050);
    expect(parseMajorInput('1.200,50', 'eur')).toBe(120_050);
    expect(parseMajorInput('1,200.50', 'eur', 'en')).toBe(120_050);
    expect(parseMajorInput('1,200', 'eur', 'en')).toBe(120_000);
    expect(parseMajorInput('49.90', 'eur', 'en')).toBe(4990);
    // «49,999» en español: ambiguo (¿49,99?, ¿49.999?) → se rechaza.
    expect(parseMajorInput('1.200', 'eur')).toBe(120_000);
    expect(parseMajorInput('49,999', 'eur')).toBeNull();
    expect(parseMajorInput('0', 'eur')).toBeNull();
    expect(parseMajorInput('-5', 'eur')).toBeNull();
    expect(parseMajorInput('abc', 'eur')).toBeNull();
  });

  it('forinto y peso colombiano: miles con punto y dos decimales en Stripe', () => {
    expect(parseMajorInput('39.900', 'huf')).toBe(3_990_000);
    expect(parseMajorInput('39900', 'huf')).toBe(3_990_000);
    expect(parseMajorInput('142.770', 'cop')).toBe(14_277_000);
    expect(parseMajorInput('1.427.698', 'cop')).toBe(142_769_800);
  });

  it('yen y peso chileno: sin decimales', () => {
    expect(parseMajorInput('7900', 'jpy')).toBe(7900);
    expect(parseMajorInput('7.900', 'jpy')).toBe(7900);
    expect(parseMajorInput('19,5', 'clp')).toBeNull();
  });

  it('corona islandesa: sin fracción', () => {
    expect(parseMajorInput('7950', 'isk')).toBe(795_000);
    expect(parseMajorInput('7950,50', 'isk')).toBeNull();
  });

  it('minorToInput es la vuelta para el campo editable', () => {
    expect(minorToInput(4900, 'eur', 'es')).toBe('49');
    expect(minorToInput(4990, 'eur', 'es')).toBe('49,90');
    expect(minorToInput(4990, 'eur', 'en')).toBe('49.90');
    expect(minorToInput(500, 'jpy', 'es')).toBe('500');
    expect(minorToInput(3_990_000, 'huf', 'es')).toBe('39900');
  });
});

describe('formatCents / formatCentsExact / formatStripeMinor con la tabla de Stripe', () => {
  const opts = { locale: 'es-ES' };
  const plain = (s: string) => s.replace(/\s/g, ' ');

  it('euro: igual que antes', () => {
    expect(plain(formatCents(4900, 'EUR', opts))).toBe('49 €');
    expect(plain(formatCents(4990, 'EUR', opts))).toBe('49,90 €');
    expect(plain(formatCentsExact(4900, 'EUR', opts))).toBe('49,00 €');
  });

  it('yen: 500 son 500 yenes (antes salían 5)', () => {
    expect(plain(formatCents(500, 'JPY', opts))).toMatch(/^500\s?(JPY|¥)$/);
    expect(plain(formatCentsExact(500, 'JPY', opts))).toMatch(/^500\s?(JPY|¥)$/);
  });

  it('peso chileno: sin decimales', () => {
    expect(plain(formatStripeMinor(19_990, 'clp', opts))).toMatch(/^19\.990\s?CLP$/);
  });

  it('forinto: 3.990.000 son 39.900 Ft, con sus decimales al cuadrar', () => {
    expect(plain(formatStripeMinor(3_990_000, 'huf', opts))).toMatch(/^39\.900\s?HUF$/);
    expect(plain(formatStripeMinor(3_722_150, 'huf', { ...opts, exact: true }))).toMatch(
      /^37\.221,50\s?HUF$/,
    );
  });

  it('peso colombiano: 14.277.000 son 142.770 COP', () => {
    expect(plain(formatStripeMinor(14_277_000, 'cop', opts))).toMatch(/^142\.770\s?COP$/);
  });

  it('corona islandesa: 795.000 son 7.950 ISK', () => {
    expect(plain(formatStripeMinor(795_000, 'isk', opts))).toMatch(/^7\.?950\s?ISK$/);
  });
});
