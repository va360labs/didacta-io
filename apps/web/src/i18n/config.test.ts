import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  academyUiLocale,
  ACADEMY_LOCALE_NAMES,
  ACADEMY_LOCALES,
  catalogOf,
  DEFAULT_LOCALE,
  isAcademyLocale,
  isUsableLocaleCookie,
  MESSAGE_CATALOGS,
  resolveRequestLocale,
  SUPPORTED_LOCALES,
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
    expect(toSupportedLocale('pt-BR')).toBe('pt-BR');
  });

  it('idioma base sin región → variante canónica', () => {
    expect(toSupportedLocale('es')).toBe('es-ES');
    expect(toSupportedLocale('en')).toBe('en-US');
    expect(toSupportedLocale('EN-gb')).toBe('en-US');
    expect(toSupportedLocale('pt')).toBe('pt-BR');
  });

  it('pt-BR ya NO se degrada a español: tiene catálogo propio', () => {
    // Estuvo retirado mientras fue elegible sin catálogo (se elegía portugués y
    // la UI seguía en español). Este test es el que afirmaba el degradado
    // `pt-BR → es-ES`; ahora afirma lo contrario, y el control de abajo
    // demuestra que la comprobación discrimina.
    expect(toSupportedLocale('pt-BR')).not.toBe(DEFAULT_LOCALE);
    expect(catalogOf(toSupportedLocale('pt-BR'))).toBe('pt');
    // Control: un idioma sin catálogo sigue cayendo al default.
    expect(toSupportedLocale('fr-FR')).toBe(DEFAULT_LOCALE);
  });

  it('portugués de otra región (pt-PT, por SCIM) → pt-BR, no español', () => {
    // No hay catálogo europeo, pero servirle español a un lusófono teniendo
    // portugués sería peor que servirle la variante brasileña.
    expect(toSupportedLocale('pt-PT')).toBe('pt-BR');
    expect(toSupportedLocale('PT-pt')).toBe('pt-BR');
  });

  it('CAMINO DEGRADADO: idioma sin catálogo (guardado por SCIM) → es-ES', () => {
    // No se puede elegir ni guardar por la UI (fuera de LOCALE_OPTIONS y de
    // ALLOWED_LOCALES), pero puede existir en base de datos: SCIM copia el
    // locale del IdP sin validar (apps/api/src/scim/scim.mapper.ts). Sin este
    // degradado esos usuarios quedarían con un valor que la UI no sabe pintar.
    expect(toSupportedLocale('fr-FR')).toBe('es-ES');
    expect(toSupportedLocale('de')).toBe('es-ES');
  });

  it('basura → default', () => {
    expect(toSupportedLocale('xx-YY')).toBe(DEFAULT_LOCALE);
    expect(toSupportedLocale('; DROP TABLE')).toBe(DEFAULT_LOCALE);
    // Nombres de propiedades heredadas de Object: no son idiomas.
    expect(toSupportedLocale('constructor')).toBe(DEFAULT_LOCALE);
    expect(toSupportedLocale('__proto__')).toBe(DEFAULT_LOCALE);
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

  it('pt-BR usa catálogo pt', () => {
    expect(catalogOf('pt-BR')).toBe('pt');
  });
});

/**
 * La guarda que faltaba cuando `pt-BR` fue elegible sin catálogo: un tag en
 * `SUPPORTED_LOCALES` cuyo catálogo no existe en el disco es exactamente aquel
 * bug. Se comprueba contra las CARPETAS reales, no contra otra lista.
 */
describe('SUPPORTED_LOCALES ↔ catálogos del disco', () => {
  const MESSAGES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'messages');
  const enDisco = readdirSync(MESSAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  it('MESSAGE_CATALOGS es exactamente la lista de carpetas de messages/', () => {
    expect([...MESSAGE_CATALOGS].sort()).toEqual(enDisco);
  });

  it('todo idioma elegible resuelve a un catálogo que existe', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(enDisco, `${locale} → ${catalogOf(locale)}, que no tiene carpeta`).toContain(
        catalogOf(locale),
      );
    }
  });

  it('todo catálogo del disco es alcanzable desde algún idioma elegible', () => {
    // Al revés: un catálogo traducido que ningún tag activa es trabajo muerto
    // (y es como estaría `pt` si alguien volviera a retirar `pt-BR`).
    const alcanzables = new Set(SUPPORTED_LOCALES.map((l) => catalogOf(l)));
    expect([...alcanzables].sort()).toEqual(enDisco);
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
    expect(isUsableLocaleCookie('fr-FR')).toBe(false);
    expect(isUsableLocaleCookie('; DROP')).toBe(false);
    expect(isUsableLocaleCookie('es-ES')).toBe(true);
    expect(isUsableLocaleCookie('EN-gb')).toBe(true);
    expect(isUsableLocaleCookie('pt-BR')).toBe(true);
    expect(resolveRequestLocale('fr-FR', 'en')).toBe('en-US');
    expect(resolveRequestLocale('pt-BR', 'en')).toBe('pt-BR');
  });

  it('sin cookie ni idioma del aula (API caída, host ajeno): es-ES, como siempre', () => {
    expect(resolveRequestLocale(undefined, null)).toBe(DEFAULT_LOCALE);
    expect(resolveRequestLocale('xx', undefined)).toBe(DEFAULT_LOCALE);
  });

  it('idiomas del aula: uno por catálogo, con su nombre en su idioma', () => {
    expect([...ACADEMY_LOCALES].sort()).toEqual([...MESSAGE_CATALOGS].sort());
    expect(ACADEMY_LOCALE_NAMES).toEqual({
      es: 'Español',
      en: 'English',
      pt: 'Português (Brasil)',
    });
    expect(isAcademyLocale('en')).toBe(true);
    expect(isAcademyLocale('pt')).toBe(true);
    // Se guarda el código del catálogo, no el tag de la interfaz.
    expect(isAcademyLocale('pt-BR')).toBe(false);
    expect(isAcademyLocale(null)).toBe(false);
    expect(academyUiLocale('en')).toBe('en-US');
    expect(academyUiLocale('es')).toBe('es-ES');
    expect(academyUiLocale('pt')).toBe('pt-BR');
  });

  it('un aula en portugués pinta en pt-BR a quien entra sin cookie', () => {
    expect(resolveRequestLocale(undefined, 'pt')).toBe('pt-BR');
    expect(catalogOf(resolveRequestLocale(undefined, 'pt'))).toBe('pt');
  });
});
