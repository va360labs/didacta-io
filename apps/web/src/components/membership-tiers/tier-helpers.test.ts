/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Lógica pura del editor de niveles: importes, nombre por defecto de cada
 * precio, orden, lo que incluye un nivel y la validación de los formularios.
 */

import { describe, expect, it } from 'vitest';
import type { MembershipAdminPlan } from '@/lib/membership';
import {
  amountToMinor,
  buildPlanInput,
  defaultPlanName,
  followPlanName,
  intervalOptions,
  minorToAmount,
  moveTier,
  newPlanDraft,
  planDraftFromPlan,
  suggestCurrency,
  suggestInterval,
  tierCourses,
  validateTierDraft,
  type PlanDraft,
} from './tier-helpers';

function plan(overrides: Partial<MembershipAdminPlan> = {}): MembershipAdminPlan {
  return {
    id: 'p-1',
    name: 'Pro · Mensual',
    tierId: 't-pro',
    intervalMonths: 1,
    amountCents: 2900,
    currency: 'eur',
    compareAtCents: null,
    trialDays: 0,
    isFeatured: false,
    active: true,
    sortOrder: 0,
    stripePriceId: null,
    currencyOptions: null,
    createdAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-20T10:00:00.000Z',
    ...overrides,
  };
}

function draft(overrides: Partial<PlanDraft> = {}): PlanDraft {
  return {
    name: 'Pro · Mensual',
    intervalMonths: 1,
    currency: 'eur',
    amountRaw: '29',
    compareAtRaw: '',
    trialDays: '0',
    isFeatured: false,
    marketPrices: [],
    ...overrides,
  };
}

describe('importes', () => {
  it('lo que escribe el creador → unidad mínima de Stripe, y vuelta al campo', () => {
    expect(amountToMinor('49,90', 'eur', 'es')).toBe(4990);
    expect(amountToMinor('1.200,50', 'eur', 'es')).toBe(120050);
    expect(amountToMinor('1,200.50', 'usd', 'en')).toBe(120050);
    expect(amountToMinor('7900', 'jpy', 'es')).toBe(7900);
    expect(amountToMinor('0', 'eur', 'es')).toBe(0);
    expect(amountToMinor('', 'eur', 'es')).toBeNull();
    expect(amountToMinor('abc', 'eur', 'es')).toBeNull();
    expect(minorToAmount(4990, 'eur', 'es')).toBe('49,90');
    expect(minorToAmount(4900, 'usd', 'en')).toBe('49');
    expect(minorToAmount(null, 'eur', 'es')).toBe('');
  });

  it('el selector de periodicidad añade la del precio si no es de las habituales', () => {
    expect(intervalOptions(3)).toEqual([1, 3, 6, 12]);
    expect(intervalOptions(2)).toEqual([1, 2, 3, 6, 12]);
  });
});

describe('nombre por defecto de un precio', () => {
  it('«<nivel> · <periodicidad>», recortado al largo que admite la API', () => {
    expect(defaultPlanName(' Pro ', 'Mensual')).toBe('Pro · Mensual');
    expect(defaultPlanName('x'.repeat(90), 'Anual')).toHaveLength(80);
  });

  it('sigue a la periodicidad mientras no se haya escrito a mano', () => {
    expect(followPlanName('Pro · Mensual', 'Pro', 'Mensual', 'Anual')).toBe('Pro · Anual');
    expect(followPlanName('', 'Pro', 'Mensual', 'Anual')).toBe('Pro · Anual');
    expect(followPlanName('Oferta de lanzamiento', 'Pro', 'Mensual', 'Anual')).toBe(
      'Oferta de lanzamiento',
    );
  });

  it('propone la primera periodicidad que el nivel aún no tiene', () => {
    expect(suggestInterval([])).toBe(1);
    expect(suggestInterval([{ intervalMonths: 1 }])).toBe(3);
    expect(suggestInterval([{ intervalMonths: 1 }, { intervalMonths: 3 }])).toBe(6);
    expect(suggestInterval([1, 3, 6, 12].map((intervalMonths) => ({ intervalMonths })))).toBe(1);
  });

  it('propone la moneda de los precios que ya hay', () => {
    const usd = { plans: [plan({ currency: 'usd' })] };
    const none = { plans: [] };
    expect(suggestCurrency(usd, [usd], 'eur')).toBe('usd');
    expect(suggestCurrency(none, [none, usd], 'eur')).toBe('usd');
    expect(suggestCurrency(none, [none], 'mxn')).toBe('mxn');
  });

  it('un precio nuevo nace con el nombre por defecto, sin importe y sin prueba', () => {
    expect(
      newPlanDraft({
        tierName: 'Básico',
        intervalMonths: 12,
        intervalLabel: 'Anual',
        currency: 'eur',
      }),
    ).toEqual({
      name: 'Básico · Anual',
      intervalMonths: 12,
      currency: 'eur',
      amountRaw: '',
      compareAtRaw: '',
      trialDays: '0',
      isFeatured: false,
      marketPrices: [],
    });
  });

  it('editar un precio carga sus importes en el formato del idioma', () => {
    const d = planDraftFromPlan(
      plan({
        amountCents: 4990,
        compareAtCents: 5990,
        trialDays: 7,
        currencyOptions: { usd: 5500 },
      }),
      'es',
    );
    expect(d.amountRaw).toBe('49,90');
    expect(d.compareAtRaw).toBe('59,90');
    expect(d.trialDays).toBe('7');
    expect(d.marketPrices).toEqual([{ currency: 'usd', amount: '55' }]);
  });
});

describe('orden y contenido de los niveles', () => {
  it('subir y bajar intercambia con el vecino; en los extremos no se mueve', () => {
    expect(moveTier(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveTier(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moveTier(['a', 'b', 'c'], 'a', -1)).toBeNull();
    expect(moveTier(['a', 'b', 'c'], 'c', 1)).toBeNull();
    expect(moveTier(['a', 'b'], 'z', 1)).toBeNull();
  });

  it('lo que incluye: todos, los títulos publicados y cuántos sin publicar', () => {
    const courses = [
      { id: 'c1', title: 'Torno' },
      { id: 'c2', title: 'Esmaltes' },
    ];
    expect(tierCourses({ allCourses: true, courseIds: [] }, courses)).toEqual({
      all: true,
      titles: [],
      hidden: 0,
    });
    expect(tierCourses({ allCourses: false, courseIds: ['c2', 'c9'] }, courses)).toEqual({
      all: false,
      titles: ['Esmaltes'],
      hidden: 1,
    });
  });
});

describe('validación del nivel', () => {
  const base = { name: 'Pro', description: '', content: 'choose' as const, courseIds: ['c1'] };

  it('pide nombre y, si se eligen cursos, al menos uno', () => {
    expect(validateTierDraft(base, { coursesAvailable: true })).toBeNull();
    expect(validateTierDraft({ ...base, name: '  ' }, { coursesAvailable: true })).toBe('name');
    expect(validateTierDraft({ ...base, courseIds: [] }, { coursesAvailable: true })).toBe(
      'courses',
    );
    expect(
      validateTierDraft({ ...base, content: 'all', courseIds: [] }, { coursesAvailable: true }),
    ).toBeNull();
  });

  it('sin cursos publicados en el aula se deja crear vacío', () => {
    expect(validateTierDraft({ ...base, courseIds: [] }, { coursesAvailable: false })).toBeNull();
  });
});

describe('validación del precio', () => {
  const opts = { locale: 'es', withMarketPrices: false };

  it('arma el cuerpo de la API con importes en unidad mínima', () => {
    const r = buildPlanInput(
      draft({ amountRaw: '49,90', compareAtRaw: '59', trialDays: '7', isFeatured: true }),
      opts,
    );
    expect(r).toEqual({
      ok: true,
      input: {
        name: 'Pro · Mensual',
        intervalMonths: 1,
        currency: 'eur',
        amountCents: 4990,
        compareAtCents: 5900,
        trialDays: 7,
        isFeatured: true,
      },
    });
  });

  it('sin precios por mercado el campo no viaja (la API conserva los que hubiera)', () => {
    const r = buildPlanInput(draft(), opts);
    expect(r.ok && 'currencyOptions' in r.input).toBe(false);
  });

  it('rechaza nombre vacío, precio cero, tachado no mayor y días de prueba fuera de rango', () => {
    const error = (d: Partial<PlanDraft>) => {
      const r = buildPlanInput(draft(d), opts);
      return r.ok ? null : r.error;
    };
    expect(error({ name: ' ' })).toBe('name');
    expect(error({ amountRaw: '0' })).toBe('amount');
    expect(error({ amountRaw: '' })).toBe('amount');
    expect(error({ compareAtRaw: '29' })).toBe('compareAt');
    expect(error({ compareAtRaw: 'mucho' })).toBe('compareAt');
    expect(error({ trialDays: '400' })).toBe('trial');
    expect(error({ trialDays: '-1' })).toBe('trial');
    expect(error({ trialDays: '' })).toBeNull();
  });

  it('con precios por mercado los valida y los manda', () => {
    const ok = buildPlanInput(draft({ marketPrices: [{ currency: 'usd', amount: '32' }] }), {
      locale: 'es',
      withMarketPrices: true,
    });
    expect(ok.ok && ok.input.currencyOptions).toEqual({ usd: 3200 });
    const bad = buildPlanInput(draft({ marketPrices: [{ currency: 'eur', amount: '32' }] }), {
      locale: 'es',
      withMarketPrices: true,
    });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toBe('market');
    expect(!bad.ok && bad.marketErrors).toEqual([{ field: 'option', index: 0, reason: 'same' }]);
  });
});
