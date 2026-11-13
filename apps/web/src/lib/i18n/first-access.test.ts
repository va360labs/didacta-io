/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { extraTimezone } from '@/lib/me';
import { firstAccessPatch, firstAccessTimeZone, isBrowserTimeZone } from './first-access';

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
