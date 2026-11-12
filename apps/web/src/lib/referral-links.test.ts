/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { buildReferralLinks, readReferralParam } from './referral-links';

const personalUrl = 'https://aula.ejemplo.test/unete?ref=abc23xyz';
const cursoA = { slug: 'acuarela-desde-cero', title: 'Acuarela desde cero' };
const cursoB = { slug: 'oleo', title: 'Óleo' };

describe('buildReferralLinks (Invita y gana para todo lo que se vende)', () => {
  it('sin nada a la venta no hay enlace', () => {
    expect(
      buildReferralLinks({ personalUrl, code: 'abc23xyz', membershipOnSale: false, courses: [] }),
    ).toEqual({ general: null, products: [] });
  });

  it('solo un curso suelto: el general es la ficha de ese curso y no hay lista', () => {
    expect(
      buildReferralLinks({
        personalUrl,
        code: 'abc23xyz',
        membershipOnSale: false,
        courses: [cursoA],
      }),
    ).toEqual({
      general: 'https://aula.ejemplo.test/catalogo/acuarela-desde-cero?ref=abc23xyz',
      products: [],
    });
  });

  it('solo la membresía: el general es /unete', () => {
    expect(
      buildReferralLinks({ personalUrl, code: 'abc23xyz', membershipOnSale: true, courses: [] }),
    ).toEqual({ general: 'https://aula.ejemplo.test/unete?ref=abc23xyz', products: [] });
  });

  it('varios cursos sin membresía: general al catálogo y uno por curso', () => {
    const r = buildReferralLinks({
      personalUrl,
      code: 'abc23xyz',
      membershipOnSale: false,
      courses: [cursoA, cursoB],
    });
    expect(r.general).toBe('https://aula.ejemplo.test/catalogo?ref=abc23xyz');
    expect(r.products).toEqual([
      {
        kind: 'course',
        title: 'Acuarela desde cero',
        url: 'https://aula.ejemplo.test/catalogo/acuarela-desde-cero?ref=abc23xyz',
      },
      {
        kind: 'course',
        title: 'Óleo',
        url: 'https://aula.ejemplo.test/catalogo/oleo?ref=abc23xyz',
      },
    ]);
  });

  it('membresía y cursos: general a /unete y la membresía la primera de la lista', () => {
    const r = buildReferralLinks({
      personalUrl,
      code: 'abc23xyz',
      membershipOnSale: true,
      courses: [cursoA],
    });
    expect(r.general).toBe('https://aula.ejemplo.test/unete?ref=abc23xyz');
    expect(r.products.map((p) => p.kind)).toEqual(['membership', 'course']);
    expect(r.products.every((p) => p.url.endsWith('?ref=abc23xyz'))).toBe(true);
  });
});

describe('readReferralParam (captura del ?ref= en cualquier página de venta)', () => {
  it('normaliza a minúsculas y quita espacios', () => {
    expect(readReferralParam('?ref=AbC23Xyz')).toBe('abc23xyz');
    expect(readReferralParam('?foo=1&ref=%20abc23xyz%20')).toBe('abc23xyz');
  });

  it('descarta lo que no tiene formato de código', () => {
    expect(readReferralParam('')).toBeNull();
    expect(readReferralParam('?ref=')).toBeNull();
    expect(readReferralParam('?ref=ab')).toBeNull();
    expect(readReferralParam('?ref=<script>')).toBeNull();
    expect(readReferralParam(`?ref=${'a'.repeat(33)}`)).toBeNull();
  });
});
