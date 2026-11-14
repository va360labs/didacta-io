/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { splitLinks } from './linkify';

describe('splitLinks', () => {
  it('separa los enlaces del texto y deja fuera la puntuación final', () => {
    expect(splitLinks('Empieza aquí: https://aula.example.com/courses/cata. ¡Ánimo!')).toEqual([
      { type: 'text', value: 'Empieza aquí: ' },
      { type: 'link', href: 'https://aula.example.com/courses/cata' },
      { type: 'text', value: '. ¡Ánimo!' },
    ]);
  });

  it('un texto sin enlaces queda igual', () => {
    expect(splitLinks('Hola, Ana')).toEqual([{ type: 'text', value: 'Hola, Ana' }]);
  });

  it('nada que no sea http(s) se convierte en enlace', () => {
    expect(splitLinks('mira javascript:alert(1) y ftp://x')).toEqual([
      { type: 'text', value: 'mira javascript:alert(1) y ftp://x' },
    ]);
  });

  it('varios enlaces en líneas distintas', () => {
    const parts = splitLinks('1. https://a.example.com/x\n2. http://b.example.com/y');
    expect(parts.filter((p) => p.type === 'link').map((p) => (p as { href: string }).href)).toEqual(
      ['https://a.example.com/x', 'http://b.example.com/y'],
    );
  });
});
