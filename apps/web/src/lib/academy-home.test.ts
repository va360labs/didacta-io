/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  brandStyle,
  fetchAcademyHome,
  initialsOf,
  primaryAccess,
  referralFromQuery,
  withRef,
  type AcademyHome,
} from './academy-home';

function home(offers: Partial<AcademyHome['offers']> = {}): AcademyHome {
  return {
    enabled: true,
    academy: {
      name: 'Morning Pour',
      logoUrl: null,
      logoDisplayMode: 'logo_only',
      coverUrl: null,
      description: null,
      host: null,
      links: [],
      brandHue: 14,
      brandSaturation: 72,
    },
    members: null,
    creator: null,
    nextLive: null,
    offers: { courses: [], coursesTotal: 0, membership: null, free: null, ...offers },
  };
}

const course = (slug: string) => ({
  slug,
  title: slug,
  excerpt: null,
  thumbnailUrl: null,
  estimatedMinutes: null,
  price: { amountCents: 4900, currency: 'eur', compareAtCents: null, discountPercent: null },
  optionCount: 1,
});

const membership = {
  headline: null,
  subheadline: null,
  plan: {
    name: 'Mensual',
    amountCents: 1900,
    currency: 'eur',
    compareAtCents: null,
    intervalMonths: 1,
    trialDays: 7,
  },
  planCount: 1,
  courseCount: null,
};

describe('portada pública — referidos', () => {
  it('solo acepta el formato de código de la API', () => {
    expect(referralFromQuery('ABC123')).toBe('abc123');
    expect(referralFromQuery(['abc123', 'x'])).toBe('abc123');
    expect(referralFromQuery('ab')).toBeNull();
    expect(referralFromQuery('abc"><script>')).toBeNull();
    expect(referralFromQuery(undefined)).toBeNull();
  });

  it('conserva el ?ref= en las rutas y no lo pone en las anclas', () => {
    expect(withRef('/join', 'abc123')).toBe('/join?ref=abc123');
    expect(withRef('/catalog/x?y=1', 'abc123')).toBe('/catalog/x?y=1&ref=abc123');
    expect(withRef('#courses', 'abc123')).toBe('#courses');
    expect(withRef('/signin', null)).toBe('/signin');
  });
});

describe('portada pública — botón principal', () => {
  it('membresía antes que cursos; curso único a su ficha; varios, a la lista', () => {
    expect(
      primaryAccess(home({ membership, courses: [course('a')], coursesTotal: 1 }), 'r1x'),
    ).toEqual({
      kind: 'membership',
      href: '/join?ref=r1x',
    });
    expect(primaryAccess(home({ courses: [course('latte art')], coursesTotal: 1 }), null)).toEqual({
      kind: 'course',
      href: '/catalog/latte%20art',
    });
    expect(
      primaryAccess(home({ courses: [course('a'), course('b')], coursesTotal: 2 }), 'r1x'),
    ).toEqual({ kind: 'courses', href: '#courses' });
    expect(primaryAccess(home({ free: { courses: [] } }), 'r1x')).toEqual({
      kind: 'free',
      href: '/member-registration?ref=r1x',
    });
  });

  it('sin nada a la venta no hay botón principal (solo «Entrar»)', () => {
    expect(primaryAccess(home(), 'r1x')).toBeNull();
  });
});

describe('portada pública — utilidades', () => {
  it('el color del aula solo con números válidos', () => {
    expect(brandStyle(14, 72)).toBe(':root { --brand-h: 14; --brand-s: 72%; }');
    expect(brandStyle(400, 72)).toBeNull();
    expect(brandStyle('14;}body{', 72)).toBeNull();
    expect(brandStyle(14, null)).toBe(':root { --brand-h: 14;  }');
  });

  it('iniciales de quien lleva el aula', () => {
    expect(initialsOf('Hannah Brooks')).toBe('HB');
    expect(initialsOf('lucía')).toBe('L');
    expect(initialsOf('Ana María del Río')).toBe('AR');
  });
});

describe('portada pública — llamada a la API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('manda el host y la IP del visitante; un fallo es `null` (la raíz va al acceso)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: false }),
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchAcademyHome('aula.example.com', '203.0.113.7')).toEqual({ enabled: false });
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers).toEqual({
      'x-forwarded-host': 'aula.example.com',
      'x-forwarded-for': '203.0.113.7',
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await fetchAcademyHome('aula.example.com', null)).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('caída')));
    expect(await fetchAcademyHome('aula.example.com', null)).toBeNull();
    expect(await fetchAcademyHome(null, null)).toBeNull();
  });
});
