/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { canSubmitAddress, signinUrlAt, toLabelDraft } from './academy-address';
import { aliasRedirectUrl, sanitizeRedirectHost } from './alias-redirect';

describe('toLabelDraft: lo que se teclea, llevado a una dirección', () => {
  it.each([
    ['Academía Pérez', 'academia-perez'],
    ['  Joaquín  Formación', 'joaquin-formacion'],
    // El espacio que se teclea entre palabras se queda como guion para que se
    // pueda seguir escribiendo «mi academia» con naturalidad.
    ['mi ', 'mi-'],
    ['Mi_Academia.Online', 'mi-academia-online'],
    ['ÑANDÚ & co', 'nandu-co'],
    ['--hola', 'hola'],
    // A mitad de palabra el guion final se respeta: decide la API al comprobar.
    ['mi-', 'mi-'],
  ])('%s → %s', (raw, expected) => {
    expect(toLabelDraft(raw)).toBe(expected);
  });

  it('nunca más de 63 caracteres', () => {
    expect(toLabelDraft('a'.repeat(80))).toHaveLength(63);
  });
});

describe('signinUrlAt: el acceso de la dirección nueva', () => {
  it('en producción, https y sin puerto', () => {
    expect(signinUrlAt('nueva.didacta.io', { protocol: 'https:', port: '' })).toBe(
      'https://nueva.didacta.io/signin',
    );
  });
  it('en local, con el puerto de la web', () => {
    expect(signinUrlAt('nueva.localhost', { protocol: 'http:', port: '3010' })).toBe(
      'http://nueva.localhost:3010/signin',
    );
  });
});

describe('canSubmitAddress', () => {
  const state = { canChange: true };
  const libre = { label: 'nueva', hostname: 'nueva.didacta.io', status: 'available' as const };

  it('solo con la comprobación diciendo «libre» para lo que hay escrito AHORA', () => {
    expect(canSubmitAddress(state, 'nueva', libre, false)).toBe(true);
    // Se ha seguido escribiendo después de comprobar.
    expect(canSubmitAddress(state, 'nueva2', libre, false)).toBe(false);
    expect(canSubmitAddress(state, 'nueva', { ...libre, status: 'taken' }, false)).toBe(false);
    expect(canSubmitAddress(state, 'nueva', null, false)).toBe(false);
  });

  it('ni sin cambios disponibles, ni mientras se guarda', () => {
    expect(canSubmitAddress({ canChange: false }, 'nueva', libre, false)).toBe(false);
    expect(canSubmitAddress(state, 'nueva', libre, true)).toBe(false);
    expect(canSubmitAddress(null, 'nueva', libre, false)).toBe(false);
  });
});

describe('redirección de una dirección anterior', () => {
  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n] ?? null });

  it('conserva ruta y query y toma el esquema del proxy', () => {
    const url = aliasRedirectUrl(
      new URL('http://vieja.didacta.io/catalog/curso?ref=ANA&x=1'),
      'nueva.didacta.io',
      headers({ host: 'vieja.didacta.io', 'x-forwarded-proto': 'https' }),
    );
    expect(url.toString()).toBe('https://nueva.didacta.io/catalog/curso?ref=ANA&x=1');
  });

  it('sin proxy, el esquema y el puerto de la petición', () => {
    const url = aliasRedirectUrl(
      new URL('http://vieja.localhost:3010/admin'),
      'nueva.localhost',
      headers({ host: 'vieja.localhost:3010' }),
    );
    expect(url.toString()).toBe('http://nueva.localhost:3010/admin');
  });

  it('solo hostnames limpios como destino', () => {
    expect(sanitizeRedirectHost('Nueva.Didacta.io')).toBe('nueva.didacta.io');
    expect(sanitizeRedirectHost('evil.example/phish')).toBeNull();
    expect(sanitizeRedirectHost('evil.example:8080')).toBeNull();
    expect(sanitizeRedirectHost('//evil.example')).toBeNull();
    expect(sanitizeRedirectHost(null)).toBeNull();
    expect(sanitizeRedirectHost(42)).toBeNull();
  });
});
