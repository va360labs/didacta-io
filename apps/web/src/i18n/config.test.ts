import { describe, expect, it } from 'vitest';
import { catalogOf, DEFAULT_LOCALE, toSupportedLocale } from './config';

describe('toSupportedLocale', () => {
  it('null/undefined/vacío → default es-ES', () => {
    expect(toSupportedLocale(null)).toBe('es-ES');
    expect(toSupportedLocale(undefined)).toBe('es-ES');
    expect(toSupportedLocale('')).toBe('es-ES');
  });

  it('tags soportados pasan tal cual', () => {
    expect(toSupportedLocale('es-ES')).toBe('es-ES');
    expect(toSupportedLocale('es-AR')).toBe('es-AR');
    expect(toSupportedLocale('en-US')).toBe('en-US');
  });

  it('idioma base sin región → variante canónica', () => {
    expect(toSupportedLocale('es')).toBe('es-ES');
    expect(toSupportedLocale('en')).toBe('en-US');
    expect(toSupportedLocale('EN-gb')).toBe('en-US');
  });

  it('pt-BR (válido en el backend, sin catálogo) → es-ES', () => {
    expect(toSupportedLocale('pt-BR')).toBe('es-ES');
  });

  it('basura → default', () => {
    expect(toSupportedLocale('xx-YY')).toBe(DEFAULT_LOCALE);
    expect(toSupportedLocale('; DROP TABLE')).toBe(DEFAULT_LOCALE);
  });
});

describe('catalogOf', () => {
  it('es-ES y es-AR comparten catálogo es', () => {
    expect(catalogOf('es-ES')).toBe('es');
    expect(catalogOf('es-AR')).toBe('es');
  });

  it('en-US usa catálogo en', () => {
    expect(catalogOf('en-US')).toBe('en');
  });
});
