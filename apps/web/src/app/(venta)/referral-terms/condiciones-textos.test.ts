/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en/referidosCondiciones.json';
import es from '@/i18n/messages/es/referidosCondiciones.json';

/**
 * Textos de las condiciones de «Invita y gana» (`/referral-terms`), que el
 * alumno acepta con una casilla. Decisión del dueño (14-nov-2026): una
 * cláusula fiscal genérica —cada parte con sus impuestos; paga la academia,
 * no Didacta; Didacta no retiene— y nada de modelos tributarios concretos ni
 * marcas de borrador entre corchetes.
 */
const CATALOGOS = { es, en } as const;

function textos(o: unknown): string[] {
  if (typeof o === 'string') return [o];
  if (o && typeof o === 'object') return Object.values(o).flatMap(textos);
  return [];
}

describe('condiciones de «Invita y gana»', () => {
  for (const [idioma, cat] of Object.entries(CATALOGOS)) {
    it(`${idioma}: ni marcas de borrador entre corchetes ni el modelo 347`, () => {
      for (const t of textos(cat)) {
        expect(t).not.toMatch(/\[[^\]]*\]/);
        expect(t).not.toMatch(/347/);
      }
    });
  }

  it('es: la cláusula fiscal dice quién paga y que Didacta no retiene', () => {
    const fiscal = es.secciones.s5.p4;
    expect(fiscal).toContain('cada parte es responsable de sus propias obligaciones fiscales');
    expect(fiscal).toContain('te lo paga {academia}, no Didacta');
    expect(fiscal).toContain('Didacta no practica retenciones');
  });

  it('en: la cláusula fiscal dice lo mismo', () => {
    const fiscal = en.secciones.s5.p4;
    expect(fiscal).toContain('each party is responsible for its own tax obligations');
    expect(fiscal).toContain('is paid to you by {academia}, not by Didacta');
    expect(fiscal).toContain('Didacta does not withhold any tax');
  });
});
