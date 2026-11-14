/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RichBody } from './rich-body';

/**
 * La lección de texto (ensayo general, 14-nov-2026) salía tal cual:
 * «**Material:** 1 kg de gres». Ahora pasa por el mismo intérprete seguro que
 * los posts de la comunidad, sin menciones (`mentions={false}`).
 */
const pinta = (body: string) => renderToStaticMarkup(<RichBody body={body} mentions={false} />);

describe('lección de texto con formato básico', () => {
  it('negrita', () => {
    const html = pinta('**Material:** 1 kg de gres, esponja y alambre.');
    expect(html).toContain('<strong class="font-semibold"><span>Material:</span></strong>');
    expect(html).not.toContain('**');
  });

  it('listas con viñetas y numeradas', () => {
    const sinSpans = (h: string) => h.replace(/<\/?span>/g, '');
    expect(sinSpans(pinta('- barro\n- agua'))).toMatch(
      /<ul[^>]*><li>barro<\/li><li>agua<\/li><\/ul>/,
    );
    expect(sinSpans(pinta('1. centrar\n2. abrir'))).toMatch(
      /<ol[^>]*><li>centrar<\/li><li>abrir<\/li><\/ol>/,
    );
  });

  it('enlaces http(s), que se abren aparte', () => {
    const html = pinta('Mira la [guía](https://ejemplo.test/guia).');
    expect(html).toContain('href="https://ejemplo.test/guia"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('seguro: el HTML que escriba alguien sale como texto, nunca como etiqueta', () => {
    const html = pinta('<script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('seguro: un enlace que no es http(s) no se convierte en enlace', () => {
    const html = pinta('[pulsa](javascript:alert(1))');
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain('<a');
  });

  it('una @ en una lección no es una mención', () => {
    const lesson = pinta('Escríbeme a @lucia');
    expect(lesson).toContain('@lucia');
    expect(lesson).not.toContain('bg-brand-50');
    // CONTROL: en la comunidad sí lo es.
    expect(renderToStaticMarkup(<RichBody body="Escríbeme a @lucia" />)).toContain('bg-brand-50');
  });
});
