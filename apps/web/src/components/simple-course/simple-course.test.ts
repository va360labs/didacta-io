/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { parseAmount, saleState, suggestCurrency } from '@/lib/simple-mode';
import { lessonReady } from './simple-course-editor';
import { toSlug } from './slug';

describe('editor de curso sencillo', () => {
  it('el enlace sale solo del título', () => {
    expect(toSlug('Acuarela desde cero')).toBe('acuarela-desde-cero');
    expect(toSlug('Ñandú: ¿qué es?')).toBe('nandu-que-es');
    expect(toSlug('!!!')).toBe('curso');
  });

  it('una lección sin contenido no está lista', () => {
    expect(lessonReady({ type: 'TEXT', content: {} })).toBe(false);
    expect(lessonReady({ type: 'TEXT', content: { text: 'Hola' } })).toBe(true);
    expect(lessonReady({ type: 'VIDEO', content: { videoUrl: 'https://vimeo.com/1' } })).toBe(true);
    expect(lessonReady({ type: 'PDF', content: { pdfUrl: '' } })).toBe(false);
  });
});

describe('precio en el alta', () => {
  it('acepta coma o punto y lo pasa a céntimos', () => {
    expect(parseAmount('49', 'eur')).toBe(4900);
    expect(parseAmount('49,90', 'eur')).toBe(4990);
    expect(parseAmount(' 49.5 ', 'usd')).toBe(4950);
    expect(parseAmount('0', 'eur')).toBeNull();
    expect(parseAmount('abc', 'eur')).toBeNull();
  });

  it('propone la moneda del país del navegador si el aula puede cobrar en ella', () => {
    const plataforma = ['eur', 'gbp', 'usd', 'cad', 'chf'];
    expect(suggestCurrency('es-ES', plataforma)).toBe('eur');
    expect(suggestCurrency('en-US', plataforma)).toBe('usd');
    expect(suggestCurrency('en-GB', plataforma)).toBe('gbp');
    expect(suggestCurrency('es-MX', plataforma)).toBe('eur');
    expect(suggestCurrency('es-MX', ['eur', 'mxn'])).toBe('mxn');
  });
});

describe('¿se puede comprar ya?', () => {
  const paso = (done: boolean) => [{ id: 'payments' as const, done }];
  it('sin publicar', () => {
    expect(saleState({ salePath: null, steps: paso(true) })).toBe('unpublished');
  });
  it('publicado sin cobros: NO se puede comprar', () => {
    expect(saleState({ salePath: '/catalog/x', steps: paso(false) })).toBe('not-purchasable');
  });
  it('publicado con cobros: a la venta', () => {
    expect(saleState({ salePath: '/catalog/x', steps: paso(true) })).toBe('on-sale');
  });
});
