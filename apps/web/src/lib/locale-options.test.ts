import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES, toSupportedLocale } from '@/i18n/config';
import { LOCALE_OPTIONS } from './me';

/**
 * El selector de idioma de `/cuenta` y `/onboarding`.
 *
 * El fallo que cubren estos tests: `LOCALE_OPTIONS` era una lista suelta,
 * independiente de `SUPPORTED_LOCALES`, y ofrecía `pt-BR` — un idioma sin
 * catálogo de mensajes. El usuario elegía portugués, la API lo guardaba,
 * `/cuenta` le confirmaba «Português (Brasil)» y la interfaz seguía en español.
 */
describe('LOCALE_OPTIONS', () => {
  it('no ofrece pt-BR: el producto no lo tiene traducido', () => {
    expect(LOCALE_OPTIONS.map((o) => o.value)).not.toContain('pt-BR');
    expect(LOCALE_OPTIONS.map((o) => o.label).join(' ')).not.toContain('Português');
  });

  it('ofrece exactamente los idiomas soportados, ni uno más', () => {
    // La igualdad en los DOS sentidos es el punto: ofrecer de menos esconde un
    // idioma que sí existe, y ofrecer de más es el bug que se está arreglando.
    expect(LOCALE_OPTIONS.map((o) => o.value).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it('toda opción tiene etiqueta no vacía', () => {
    for (const option of LOCALE_OPTIONS) {
      expect(option.label.trim(), `sin etiqueta: ${option.value}`).not.toBe('');
    }
  });

  it('CAMINO DEGRADADO: un locale guardado que ya no se ofrece casa con una opción real', () => {
    // `pt-BR` sigue en base de datos (perfiles anteriores a la retirada y altas
    // por SCIM). `/cuenta` y `/onboarding` normalizan antes de pintar el
    // `<select>`; sin eso el desplegable no casaría con ninguna opción y
    // quedaría en blanco.
    const almacenados = ['pt-BR', 'fr-FR', 'zz', ''];
    for (const guardado of almacenados) {
      const normalizado = toSupportedLocale(guardado);
      expect(
        LOCALE_OPTIONS.some((o) => o.value === normalizado),
        `${guardado} degradó a ${normalizado}, que no está en el selector`,
      ).toBe(true);
    }
  });
});
