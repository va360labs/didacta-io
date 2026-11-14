/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Reglas puras de la oferta al darse de baja, con fechas fijas.
 */

import { describe, expect, it } from 'vitest';
import {
  addMonthsUtc,
  discountPlan,
  discountedAmount,
  EXIT_REASONS,
  invalidRetentionField,
  isExitReason,
  pauseMonthOptions,
  pauseWindow,
  retentionCouponName,
} from '../src/retention.js';
import {
  currentPeriodStartFromSubscription,
  intervalMonthsFromSubscription,
  pauseCollectionFromSubscription,
  subscriptionHasDiscount,
} from '../src/stripe-shape.js';

const iso = (d: Date) => d.toISOString();

describe('addMonthsUtc', () => {
  it('suma meses sin desbordar al mes siguiente (como los ciclos de Stripe)', () => {
    expect(iso(addMonthsUtc(new Date('2027-01-31T10:00:00Z'), 1))).toBe('2027-02-28T10:00:00.000Z');
    expect(iso(addMonthsUtc(new Date('2028-01-31T10:00:00Z'), 1))).toBe('2028-02-29T10:00:00.000Z');
    expect(iso(addMonthsUtc(new Date('2026-12-14T17:29:11Z'), 2))).toBe('2027-02-14T17:29:11.000Z');
    expect(iso(addMonthsUtc(new Date('2026-11-30T00:00:00Z'), 3))).toBe('2027-02-28T00:00:00.000Z');
  });
});

describe('pauseMonthOptions — la pausa salta cobros enteros', () => {
  it('plan mensual: de 1 al máximo', () => {
    expect(pauseMonthOptions(1, 3)).toEqual([1, 2, 3]);
    expect(pauseMonthOptions(1, 1)).toEqual([1]);
  });
  it('plan trimestral con máximo 3: solo 3 (un cobro)', () => {
    expect(pauseMonthOptions(3, 3)).toEqual([3]);
  });
  it('bimestral: 2; anual o semanal: nada', () => {
    expect(pauseMonthOptions(2, 3)).toEqual([2]);
    expect(pauseMonthOptions(12, 3)).toEqual([]);
    expect(pauseMonthOptions(null, 3)).toEqual([]);
  });
});

describe('pauseWindow', () => {
  it('empieza al acabar lo pagado; Stripe reanuda un día antes del primer cobro', () => {
    // Fechas del sondeo real en Stripe de prueba (14-nov-2026): renovación
    // 14-dic, pausa de 2 meses → facturas del 14-dic y 14-ene anuladas, cobro
    // el 14-feb con `resumes_at` el 13-feb.
    const w = pauseWindow(new Date('2026-12-14T17:29:11Z'), 2);
    expect(iso(w.startsAt)).toBe('2026-12-14T17:29:11.000Z');
    expect(iso(w.endsAt)).toBe('2027-02-14T17:29:11.000Z');
    expect(iso(w.resumesAt)).toBe('2027-02-13T17:29:11.000Z');
  });
});

describe('discountPlan', () => {
  it('mensual: N meses repetidos; otro periodo: la siguiente renovación', () => {
    expect(discountPlan(1, 3)).toEqual({ duration: 'repeating', durationInMonths: 3 });
    expect(discountPlan(3, 3)).toEqual({ duration: 'once', durationInMonths: null });
    expect(discountPlan(12, 6)).toEqual({ duration: 'once', durationInMonths: null });
    expect(discountPlan(null, 6)).toEqual({ duration: 'once', durationInMonths: null });
  });
  it('importe con descuento redondeado al céntimo y nombre del cupón sin idioma', () => {
    expect(discountedAmount(2900, 30)).toBe(2030);
    expect(discountedAmount(999, 25)).toBe(749);
    expect(retentionCouponName(30, { duration: 'repeating', durationInMonths: 3 })).toBe(
      '-30% · 3m',
    );
    expect(retentionCouponName(30, { duration: 'once', durationInMonths: null })).toBe('-30%');
  });
});

describe('configuración y motivos', () => {
  it('límites: pausa 1..3 meses, descuento 5..90 % y 1..12 meses', () => {
    expect(
      invalidRetentionField({ pauseMaxMonths: 3, discountPercent: 90, discountMonths: 12 }),
    ).toBeNull();
    expect(invalidRetentionField({ pauseMaxMonths: 4 })).toBe('pauseMaxMonths');
    expect(invalidRetentionField({ pauseMaxMonths: 0 })).toBe('pauseMaxMonths');
    expect(invalidRetentionField({ discountPercent: 100 })).toBe('discountPercent');
    expect(invalidRetentionField({ discountPercent: 4 })).toBe('discountPercent');
    expect(invalidRetentionField({ discountPercent: 12.5 })).toBe('discountPercent');
    expect(invalidRetentionField({ discountMonths: 13 })).toBe('discountMonths');
  });
  it('seis motivos fijos', () => {
    expect(EXIT_REASONS).toEqual([
      'too_expensive',
      'no_time',
      'not_expected',
      'learned_enough',
      'missing_topics',
      'other',
    ]);
    expect(isExitReason('no_time')).toBe(true);
    expect(isExitReason('caro')).toBe(false);
    expect(isExitReason(undefined)).toBe(false);
  });
});

describe('lectores tolerantes de la suscripción de Stripe', () => {
  it('acacia: periodo en la raíz, precio con interval/interval_count', () => {
    const sub = {
      current_period_start: 100,
      current_period_end: 200,
      items: { data: [{ price: { recurring: { interval: 'month', interval_count: 3 } } }] },
      pause_collection: { behavior: 'void', resumes_at: 300 },
      discount: { id: 'di_1' },
      discounts: ['di_1'],
    };
    expect(currentPeriodStartFromSubscription(sub)).toBe(100);
    expect(intervalMonthsFromSubscription(sub)).toBe(3);
    expect(pauseCollectionFromSubscription(sub)).toEqual({ behavior: 'void', resumesAt: 300 });
    expect(subscriptionHasDiscount(sub)).toBe(true);
  });
  it('basil en adelante: periodo por línea; anual = 12; sin pausa ni descuento', () => {
    const sub = {
      items: {
        data: [
          {
            current_period_start: 50,
            current_period_end: 400,
            price: { recurring: { interval: 'year', interval_count: 1 } },
          },
        ],
      },
      pause_collection: null,
      discounts: [],
    };
    expect(currentPeriodStartFromSubscription(sub)).toBe(50);
    expect(intervalMonthsFromSubscription(sub)).toBe(12);
    expect(pauseCollectionFromSubscription(sub)).toBeNull();
    expect(subscriptionHasDiscount(sub)).toBe(false);
  });
  it('por semanas: sin meses', () => {
    expect(
      intervalMonthsFromSubscription({
        items: { data: [{ price: { recurring: { interval: 'week', interval_count: 2 } } }] },
      }),
    ).toBeNull();
  });
});
