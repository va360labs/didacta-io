import { describe, expect, it } from 'vitest';
import {
  academyUiLocale,
  ACADEMY_LOCALE_NAMES,
  ACADEMY_LOCALES,
  catalogOf,
  DEFAULT_LOCALE,
  isAcademyLocale,
  isUsableLocaleCookie,
  resolveRequestLocale,
  toSupportedLocale,
} from './config';

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

  it('CAMINO DEGRADADO: pt-BR (retirado, pero guardado en perfiles viejos) → es-ES', () => {
    // Ya no se puede elegir ni guardar (fuera de LOCALE_OPTIONS y de
    // ALLOWED_LOCALES), pero sigue existiendo en base de datos: perfiles
    // anteriores a la retirada y altas por SCIM, que copia el locale del IdP
    // sin validar (apps/api/src/scim/scim.mapper.ts). Sin este degradado esos
    // usuarios quedarían con un valor que la UI no sabe pintar.
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

describe('resolveRequestLocale (cookie → idioma del aula → es-ES)', () => {
  it('la cookie manda: es la elección del visitante o la de su perfil', () => {
    expect(resolveRequestLocale('es-AR', 'en')).toBe('es-AR');
    expect(resolveRequestLocale('en-US', 'es')).toBe('en-US');
    expect(resolveRequestLocale('en', 'es')).toBe('en-US');
  });

  it('sin cookie, el idioma del aula (visitantes de la venta, catálogo, /join, acceso)', () => {
    expect(resolveRequestLocale(undefined, 'en')).toBe('en-US');
    expect(resolveRequestLocale(null, 'es')).toBe('es-ES');
    expect(resolveRequestLocale('', 'en')).toBe('en-US');
  });

  it('una cookie con un idioma que la interfaz no tiene no cuenta como elección', () => {
    expect(isUsableLocaleCookie('pt-BR')).toBe(false);
    expect(isUsableLocaleCookie('; DROP')).toBe(false);
    expect(isUsableLocaleCookie('es-ES')).toBe(true);
    expect(isUsableLocaleCookie('EN-gb')).toBe(true);
    expect(resolveRequestLocale('pt-BR', 'en')).toBe('en-US');
  });

  it('sin cookie ni idioma del aula (API caída, host ajeno): es-ES, como siempre', () => {
    expect(resolveRequestLocale(undefined, null)).toBe(DEFAULT_LOCALE);
    expect(resolveRequestLocale('xx', undefined)).toBe(DEFAULT_LOCALE);
  });

  it('idiomas del aula: los de los catálogos, con su nombre en su idioma', () => {
    expect(ACADEMY_LOCALES).toEqual(['es', 'en']);
    expect(ACADEMY_LOCALE_NAMES).toEqual({ es: 'Español', en: 'English' });
    expect(isAcademyLocale('en')).toBe(true);
    expect(isAcademyLocale('pt-BR')).toBe(false);
    expect(isAcademyLocale(null)).toBe(false);
    expect(academyUiLocale('en')).toBe('en-US');
    expect(academyUiLocale('es')).toBe('es-ES');
  });
});
