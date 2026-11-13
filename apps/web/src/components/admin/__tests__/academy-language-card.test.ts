/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * «Idioma de la academia» en Configuración: la lógica del botón «Guardar»,
 * extraída del componente (la web no tiene React Testing Library; el flujo
 * completo lo cubre el E2E `idioma-academia.spec.ts`).
 */

import { describe, expect, it } from 'vitest';
import { canSaveAcademyLocale } from '@/components/admin/academy-language-card';

describe('canSaveAcademyLocale', () => {
  it('no mientras carga ni mientras guarda', () => {
    expect(canSaveAcademyLocale(null, 'en', false)).toBe(false);
    expect(canSaveAcademyLocale({ locale: 'es', localeSource: 'setting' }, 'en', true)).toBe(false);
  });

  it('sí si cambia el idioma', () => {
    expect(canSaveAcademyLocale({ locale: 'es', localeSource: 'setting' }, 'en', false)).toBe(true);
  });

  it('no si ya está fijado y no cambia', () => {
    expect(canSaveAcademyLocale({ locale: 'en', localeSource: 'setting' }, 'en', false)).toBe(
      false,
    );
  });

  it('sí si solo está deducido: se puede fijar el que ya se usa', () => {
    for (const localeSource of ['simple-mode', 'admin', 'default'] as const) {
      expect(canSaveAcademyLocale({ locale: 'es', localeSource }, 'es', false)).toBe(true);
    }
  });
});
