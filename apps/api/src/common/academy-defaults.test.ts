/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import {
  academyDateLocale,
  academyLocale,
  academyTimeZone,
  isValidTimeZone,
  newUserTimeZone,
  toAcademyLocale,
  type AcademyDefaultsPrisma,
} from './academy-defaults';

function fakePrisma(opts: {
  state?: unknown;
  admins?: Array<{ locale: string; timezone: string }>;
  live?: { timezone: string } | null;
  failSettings?: boolean;
}): AcademyDefaultsPrisma {
  return {
    tenantSetting: {
      findUnique: async () => {
        if (opts.failSettings) throw new Error('boom');
        return opts.state === undefined ? null : { valueJson: opts.state };
      },
    },
    user: { findMany: async () => opts.admins ?? [] },
    modZoomSession: { findFirst: async () => opts.live ?? null },
  };
}

describe('toAcademyLocale', () => {
  it('reduce cualquier tag a es/en y descarta lo que no tiene catálogo', () => {
    expect(toAcademyLocale('en-US')).toBe('en');
    expect(toAcademyLocale('es_AR')).toBe('es');
    expect(toAcademyLocale('pt-BR')).toBeNull();
    expect(toAcademyLocale(undefined)).toBeNull();
    expect(academyDateLocale('en')).toBe('en-US');
    expect(academyDateLocale('es')).toBe('es-ES');
  });
});

describe('academyLocale', () => {
  it('manda el idioma con el que se montó el aula (alta en 3 preguntas)', async () => {
    const p = fakePrisma({
      state: { locale: 'en' },
      admins: [{ locale: 'es-ES', timezone: 'UTC' }],
    });
    expect(await academyLocale(p, 't')).toBe('en');
  });

  it('sin alta sencilla, el del perfil de quien administra', async () => {
    const p = fakePrisma({
      state: { quickStartAt: 'x' },
      admins: [{ locale: 'en-US', timezone: 'UTC' }],
    });
    expect(await academyLocale(p, 't')).toBe('en');
  });

  it('salta perfiles con un idioma sin catálogo', async () => {
    const p = fakePrisma({
      admins: [
        { locale: 'pt-BR', timezone: 'UTC' },
        { locale: 'en-US', timezone: 'UTC' },
      ],
    });
    expect(await academyLocale(p, 't')).toBe('en');
  });

  it('camino degradado: español si no puede leer nada', async () => {
    expect(await academyLocale(fakePrisma({ failSettings: true }), 't')).toBe('es');
  });
});

describe('zona horaria', () => {
  it('valida zonas IANA', () => {
    expect(isValidTimeZone('Europe/Madrid')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });

  it('la del aula: el perfil de quien administra si no es UTC; si no, el último directo', async () => {
    expect(
      await academyTimeZone(
        fakePrisma({ admins: [{ locale: 'es-ES', timezone: 'Europe/Madrid' }] }),
        't',
      ),
    ).toBe('Europe/Madrid');
    expect(
      await academyTimeZone(
        fakePrisma({
          admins: [{ locale: 'es-ES', timezone: 'UTC' }],
          live: { timezone: 'America/Mexico_City' },
        }),
        't',
      ),
    ).toBe('America/Mexico_City');
    expect(await academyTimeZone(fakePrisma({}), 't')).toBeNull();
  });

  it('usuario nuevo: navegador > aula > UTC', async () => {
    const aula = fakePrisma({ admins: [{ locale: 'es-ES', timezone: 'Europe/Madrid' }] });
    expect(await newUserTimeZone(aula, 't', 'America/Bogota')).toBe('America/Bogota');
    expect(await newUserTimeZone(aula, 't', 'no/existe')).toBe('Europe/Madrid');
    expect(await newUserTimeZone(aula, 't', undefined)).toBe('Europe/Madrid');
    expect(await newUserTimeZone(fakePrisma({}), 't', null)).toBe('UTC');
  });
});
