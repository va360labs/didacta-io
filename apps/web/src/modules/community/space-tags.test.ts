/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { spaceTagLabel } from './space-tags';

const EN = [
  { slug: 'general', title: 'General' },
  { slug: 'anuncios', title: 'Announcements' },
  { slug: 'preguntas', title: 'Questions' },
];

describe('spaceTagLabel', () => {
  it('el slug de un espacio se lee con su título (el del idioma del aula)', () => {
    expect(spaceTagLabel(EN, 'preguntas')).toBe('Questions');
    expect(spaceTagLabel(EN, 'anuncios')).toBe('Announcements');
  });

  it('un tag que no es de ningún espacio se queda como lo escribió la persona', () => {
    expect(spaceTagLabel(EN, 'n8n')).toBe('n8n');
  });

  it('sin espacios cargados todavía, el tag tal cual (nunca vacío)', () => {
    expect(spaceTagLabel([], 'preguntas')).toBe('preguntas');
  });
});
