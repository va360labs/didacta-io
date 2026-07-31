import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearIntendedPath,
  consumeIntendedPath,
  rememberIntendedPath,
  sanitizeInternalPath,
} from './post-login-redirect';

/** Stub mínimo de sessionStorage (vitest de apps/web corre en entorno node). */
function stubSessionStorage() {
  const store = new Map<string, string>();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
}

describe('sanitizeInternalPath', () => {
  it('acepta rutas internas con query', () => {
    expect(sanitizeInternalPath('/comunidad/abc-123')).toBe('/comunidad/abc-123');
    expect(sanitizeInternalPath('/comunidad/abc?comment=c1')).toBe('/comunidad/abc?comment=c1');
  });

  it('rechaza URLs externas y protocol-relative (open redirect)', () => {
    expect(sanitizeInternalPath('https://evil.test/x')).toBeNull();
    expect(sanitizeInternalPath('//evil.test/x')).toBeNull();
    expect(sanitizeInternalPath('javascript:alert(1)')).toBeNull();
  });

  it('rechaza payloads que el parser WHATWG normaliza a cross-origin', () => {
    // Backslash equivale a `/` en URLs de esquema especial: /\evil.test → //evil.test
    expect(sanitizeInternalPath('/\\evil.test/x')).toBeNull();
    // Tab/CR/LF se eliminan antes de parsear: /<TAB>/evil.test → //evil.test
    expect(sanitizeInternalPath('/\t/evil.test')).toBeNull();
    expect(sanitizeInternalPath('/\r\n//evil.test')).toBeNull();
    // Dot-segment que esquivaría el filtro anti-bucle textual
    expect(sanitizeInternalPath('/./signin')).toBeNull();
    expect(sanitizeInternalPath('/comunidad/../signin')).toBeNull();
  });

  it('rechaza pantallas de auth y la raíz (evita bucles y redirects vacíos)', () => {
    expect(sanitizeInternalPath('/signin')).toBeNull();
    expect(sanitizeInternalPath('/auth/callback?accessToken=x')).toBeNull();
    expect(sanitizeInternalPath('/mfa/verify')).toBeNull();
    expect(sanitizeInternalPath('/onboarding')).toBeNull();
    expect(sanitizeInternalPath('/')).toBeNull();
    expect(sanitizeInternalPath(null)).toBeNull();
    expect(sanitizeInternalPath('')).toBeNull();
  });
});

describe('rememberIntendedPath / consumeIntendedPath', () => {
  beforeEach(stubSessionStorage);
  afterEach(() => {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });

  it('guarda y consume una sola vez', () => {
    rememberIntendedPath('/comunidad/abc-123');
    expect(consumeIntendedPath()).toBe('/comunidad/abc-123');
    expect(consumeIntendedPath()).toBeNull();
  });

  it('no guarda rutas inválidas', () => {
    rememberIntendedPath('//evil.test');
    expect(consumeIntendedPath()).toBeNull();
  });

  it('no pisa un destino válido con uno inválido', () => {
    rememberIntendedPath('/comunidad/abc');
    rememberIntendedPath('/signin');
    expect(consumeIntendedPath()).toBe('/comunidad/abc');
  });

  it('clearIntendedPath borra el destino sin consumirlo (logout)', () => {
    rememberIntendedPath('/comunidad/abc');
    clearIntendedPath();
    expect(consumeIntendedPath()).toBeNull();
  });
});
