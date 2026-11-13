/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { decidir, linea, type AulaRevisada } from '../scripts/fijar-idioma-aulas';

const aula = (o: Partial<AulaRevisada>): AulaRevisada => ({
  id: '00000000-0000-4000-8000-000000000001',
  slug: 'taller',
  actual: null,
  deducido: 'es',
  origen: 'default',
  ...o,
});

describe('fijar-idioma-aulas: qué idioma pone a cada aula', () => {
  it('sin ajuste: el de la deducción de siempre', () => {
    expect(decidir(aula({ deducido: 'en', origen: 'simple-mode' }))).toEqual({
      accion: 'fijar',
      locale: 'en',
    });
    expect(decidir(aula({ deducido: 'es', origen: 'admin' }))).toEqual({
      accion: 'fijar',
      locale: 'es',
    });
  });

  it('con ajuste: no se toca, aunque la deducción diga otra cosa', () => {
    expect(decidir(aula({ actual: 'es', deducido: 'en', origen: 'simple-mode' }))).toEqual({
      accion: 'ya-tiene',
      locale: 'es',
    });
  });

  it('el listado dice qué haría, con qué idioma y de dónde sale', () => {
    expect(linea(aula({ slug: 'cafe', deducido: 'en', origen: 'simple-mode' }))).toContain(
      'fijar     en  cafe',
    );
    expect(linea(aula({ deducido: 'en', origen: 'simple-mode' }))).toContain('alta en 3 preguntas');
    expect(linea(aula({ origen: 'admin' }))).toContain('perfil de quien administra');
    expect(linea(aula({ actual: 'en' }))).toContain('ya fijado');
  });
});
