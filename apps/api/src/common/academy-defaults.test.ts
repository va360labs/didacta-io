/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { ALLOWED_LOCALES } from '../auth/me.controller';
import {
  ACADEMY_LOCALES,
  ACADEMY_LOCALE_SETTING,
  academyDateLocale,
  academyLocale,
  academyTimeZone,
  deducedAcademyLocale,
  explicitAcademyLocale,
  isValidTimeZone,
  newUserLocale,
  newUserTimeZone,
  resolveAcademyLocale,
  toAcademyLocale,
  writeAcademyLocale,
  type AcademyDefaultsPrisma,
  type AcademyLocaleWriter,
} from './academy-defaults';

function fakePrisma(opts: {
  /** `tenant_setting academy/locale` (el ajuste del aula). */
  setting?: unknown;
  /** `tenant_setting simple-mode/state`. */
  state?: unknown;
  admins?: Array<{ locale: string; timezone: string }>;
  live?: { timezone: string } | null;
  failSettings?: boolean;
}): AcademyDefaultsPrisma {
  return {
    tenantSetting: {
      findUnique: async ({ where }) => {
        if (opts.failSettings) throw new Error('boom');
        const { moduleName, key } = where.tenantId_moduleName_key;
        if (moduleName === 'academy' && key === 'locale') {
          return opts.setting === undefined ? null : { valueJson: opts.setting };
        }
        if (moduleName === 'simple-mode' && key === 'state') {
          return opts.state === undefined ? null : { valueJson: opts.state };
        }
        return null;
      },
    },
    user: { findMany: async () => opts.admins ?? [] },
    modZoomSession: { findFirst: async () => opts.live ?? null },
  };
}

describe('toAcademyLocale', () => {
  it('reduce cualquier tag a es/en/pt y descarta lo que no tiene catálogo', () => {
    expect(ACADEMY_LOCALES).toEqual(['es', 'en', 'pt']);
    expect(toAcademyLocale('en-US')).toBe('en');
    expect(toAcademyLocale('es_AR')).toBe('es');
    expect(toAcademyLocale(undefined)).toBeNull();
    expect(toAcademyLocale('fr-FR')).toBeNull();
    expect(academyDateLocale('en')).toBe('en-US');
    expect(academyDateLocale('es')).toBe('es-ES');
  });

  it('portugués: se guarda el código del catálogo (pt) y las fechas van en pt-BR', () => {
    expect(toAcademyLocale('pt-BR')).toBe('pt');
    expect(toAcademyLocale('pt')).toBe('pt');
    expect(toAcademyLocale('PT_pt')).toBe('pt');
    expect(academyDateLocale('pt')).toBe('pt-BR');
  });

  it('el tag de fecha de cada idioma del aula es un idioma de perfil válido', () => {
    for (const l of ACADEMY_LOCALES) {
      expect(ALLOWED_LOCALES as readonly string[]).toContain(academyDateLocale(l));
    }
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
        { locale: 'fr-FR', timezone: 'UTC' },
        { locale: 'en-US', timezone: 'UTC' },
      ],
    });
    expect(await academyLocale(p, 't')).toBe('en');
  });

  it('un aula en portugués: ajuste, alta sencilla o perfil pt-BR dan pt', async () => {
    expect(await resolveAcademyLocale(fakePrisma({ setting: 'pt' }), 't')).toEqual({
      locale: 'pt',
      source: 'setting',
    });
    expect(await academyLocale(fakePrisma({ state: { locale: 'pt' } }), 't')).toBe('pt');
    expect(
      await academyLocale(fakePrisma({ admins: [{ locale: 'pt-BR', timezone: 'UTC' }] }), 't'),
    ).toBe('pt');
  });

  it('camino degradado: español si no puede leer nada', async () => {
    expect(await academyLocale(fakePrisma({ failSettings: true }), 't')).toBe('es');
  });

  it('el ajuste del aula manda sobre la deducción, en los dos sentidos', async () => {
    const en = fakePrisma({
      setting: 'en',
      state: { locale: 'es' },
      admins: [{ locale: 'es-ES', timezone: 'UTC' }],
    });
    expect(await resolveAcademyLocale(en, 't')).toEqual({ locale: 'en', source: 'setting' });
    const es = fakePrisma({ setting: 'es', admins: [{ locale: 'en-US', timezone: 'UTC' }] });
    expect(await resolveAcademyLocale(es, 't')).toEqual({ locale: 'es', source: 'setting' });
  });

  it('un ajuste ilegible o sin catálogo no cuenta: queda la deducción', async () => {
    for (const setting of ['fr-FR', 42, { locale: 'en' }, null, '']) {
      const p = fakePrisma({ setting, admins: [{ locale: 'en-US', timezone: 'UTC' }] });
      expect(await explicitAcademyLocale(p, 't')).toBeNull();
      expect(await resolveAcademyLocale(p, 't')).toEqual({ locale: 'en', source: 'admin' });
    }
  });

  it('la deducción dice de dónde sale (lo lista el script de migración)', async () => {
    expect(await deducedAcademyLocale(fakePrisma({ state: { locale: 'en' } }), 't')).toEqual({
      locale: 'en',
      source: 'simple-mode',
    });
    expect(
      await deducedAcademyLocale(
        fakePrisma({ setting: 'en', admins: [{ locale: 'es-ES', timezone: 'UTC' }] }),
        't',
      ),
    ).toEqual({ locale: 'es', source: 'admin' });
    expect(await deducedAcademyLocale(fakePrisma({}), 't')).toEqual({
      locale: 'es',
      source: 'default',
    });
  });
});

describe('ajuste del idioma del aula', () => {
  it('se guarda como ajuste del aula academy/locale (upsert, sin columna nueva)', async () => {
    const calls: unknown[] = [];
    const writer: AcademyLocaleWriter = {
      tenantSetting: {
        upsert: async (args) => {
          calls.push(args);
          return null;
        },
      },
    };
    await writeAcademyLocale(writer, 't1', 'en', 'u1');
    expect(ACADEMY_LOCALE_SETTING).toEqual({ moduleName: 'academy', key: 'locale' });
    expect(calls).toEqual([
      {
        where: {
          tenantId_moduleName_key: { tenantId: 't1', moduleName: 'academy', key: 'locale' },
        },
        create: {
          tenantId: 't1',
          moduleName: 'academy',
          key: 'locale',
          valueJson: 'en',
          isSecret: false,
          updatedById: 'u1',
        },
        update: { valueJson: 'en', updatedById: 'u1' },
      },
    ]);
  });

  it('usuario nuevo: idioma del navegador si es de los del perfil; si no, el del aula', async () => {
    const aulaEn = fakePrisma({ setting: 'en' });
    expect(await newUserLocale(aulaEn, 't', 'es-AR')).toBe('es-AR');
    expect(await newUserLocale(aulaEn, 't', 'pt-BR')).toBe('pt-BR');
    expect(await newUserLocale(aulaEn, 't', 'fr-FR')).toBe('en-US');
    expect(await newUserLocale(aulaEn, 't', undefined)).toBe('en-US');
    expect(await newUserLocale(fakePrisma({}), 't', null)).toBe('es-ES');
    expect(await newUserLocale(fakePrisma({ setting: 'pt' }), 't', undefined)).toBe('pt-BR');
  });

  it('los idiomas de perfil que acepta un usuario nuevo son los de ALLOWED_LOCALES', async () => {
    const aulaEn = fakePrisma({ setting: 'en' });
    for (const l of ALLOWED_LOCALES) expect(await newUserLocale(aulaEn, 't', l)).toBe(l);
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
