/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { extraTimezone } from '@/lib/me';
import {
  firstAccessPatch,
  firstAccessTimeZone,
  isBrowserTimeZone,
  profileLocaleToApply,
  viewingLocale,
} from './first-access';

const NUEVO = {
  onboarded: false,
  profileLocale: 'es-ES',
  profileTimeZone: 'UTC',
  cookieLocale: null,
  browserTimeZone: 'Europe/Madrid',
};

describe('primer acceso: zona e idioma del navegador', () => {
  it('un alumno nuevo en UTC toma la zona de su navegador (el directo de las 19:00 ya no sale a las 18:00)', () => {
    expect(firstAccessPatch(NUEVO)).toEqual({ timezone: 'Europe/Madrid' });
  });

  it('también sustituye la zona del aula que puso el servidor', () => {
    expect(
      firstAccessPatch({
        ...NUEVO,
        profileTimeZone: 'Europe/Madrid',
        browserTimeZone: 'America/Bogota',
      }),
    ).toEqual({ timezone: 'America/Bogota' });
  });

  it('en un aula en inglés, el perfil en español no le cambia la interfaz: se adopta la cookie', () => {
    expect(firstAccessPatch({ ...NUEVO, cookieLocale: 'en-US' })).toEqual({
      timezone: 'Europe/Madrid',
      locale: 'en-US',
    });
  });

  it('sin cookie no hay idioma que adoptar; sin zona válida, nada que cambiar', () => {
    expect(firstAccessPatch({ ...NUEVO, browserTimeZone: 'Mars/Olympus' })).toBeNull();
    expect(firstAccessPatch({ ...NUEVO, browserTimeZone: undefined })).toBeNull();
    expect(firstAccessPatch({ ...NUEVO, browserTimeZone: 'UTC' })).toBeNull();
  });

  it('no pisa lo que el usuario ya eligió (primer acceso terminado)', () => {
    expect(
      firstAccessPatch({
        ...NUEVO,
        onboarded: true,
        cookieLocale: 'en-US',
        browserTimeZone: 'Asia/Tokyo',
      }),
    ).toBeNull();
  });

  it('el formulario del primer acceso propone la del navegador; si no hay, la del perfil (la del aula)', () => {
    expect(firstAccessTimeZone('UTC', 'Europe/Madrid')).toBe('Europe/Madrid');
    expect(firstAccessTimeZone('Europe/Madrid', undefined)).toBe('Europe/Madrid');
    expect(isBrowserTimeZone('nope/nope')).toBe(false);
  });

  it('una zona fuera de la lista se ofrece aparte en el selector', () => {
    expect(extraTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(extraTimezone('Europe/Madrid')).toBeNull();
    expect(extraTimezone('America/New_York')).toBeNull();
  });
});

describe('idioma del aula para quien entra sin cookie', () => {
  it('está viendo el aula en su cookie o, sin ella, en el idioma del aula', () => {
    expect(viewingLocale('es-AR', 'en')).toBe('es-AR');
    expect(viewingLocale(null, 'en')).toBe('en-US');
    expect(viewingLocale(null, 'es')).toBe('es-ES');
    expect(viewingLocale(null, null)).toBeNull();
  });

  it('primer acceso sin cookie en un aula en inglés: el perfil pasa a inglés', () => {
    expect(
      firstAccessPatch({
        ...NUEVO,
        cookieLocale: viewingLocale(null, 'en'),
        browserTimeZone: undefined,
      }),
    ).toEqual({ locale: 'en-US' });
  });

  it('la preferencia del usuario manda: se compara con lo que se pinta, no solo con la cookie', () => {
    // Sin cookie, el aula en inglés se pinta en inglés; el perfil en español gana.
    expect(profileLocaleToApply('es-ES', null, 'en-US')).toBe('es-ES');
    // Ya se pinta en su idioma: nada que hacer (ni refresco).
    expect(profileLocaleToApply('en-US', null, 'en-US')).toBeNull();
    expect(profileLocaleToApply('es-AR', 'es-AR', 'es-AR')).toBeNull();
    // La cookie de otra visita no manda sobre el perfil.
    expect(profileLocaleToApply('en-US', 'es-ES', 'es-ES')).toBe('en-US');
  });
});
