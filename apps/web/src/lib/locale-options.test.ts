import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES, toSupportedLocale } from '@/i18n/config';
import { LOCALE_OPTIONS } from './me';

/**
 * El selector de idioma de `/account` y `/onboarding`.
 *
 * El fallo que cubren estos tests: `LOCALE_OPTIONS` era una lista suelta,
 * independiente de `SUPPORTED_LOCALES`, y ofrecía `pt-BR` cuando todavía no
 * tenía catálogo de mensajes. El usuario elegía portugués, la API lo guardaba,
 * `/account` le confirmaba «Português (Brasil)» y la interfaz seguía en español.
 *
 * Hoy `pt-BR` SÍ se ofrece, porque tiene catálogo (`i18n/messages/pt`). Lo que
 * estos tests siguen impidiendo es la divergencia: el selector no puede ofrecer
 * nada que `SUPPORTED_LOCALES` no declare, y `i18n/config.test.ts` comprueba
 * que todo lo que esa lista declara tiene catálogo en el disco.
 */
describe('LOCALE_OPTIONS', () => {
  it('ofrece pt-BR con su endónimo: el producto ya lo tiene traducido', () => {
    const pt = LOCALE_OPTIONS.find((o) => o.value === 'pt-BR');
    expect(pt?.label).toBe('Português (Brasil)');
  });

  it('no ofrece idiomas sin catálogo (control: francés)', () => {
    expect(LOCALE_OPTIONS.map((o) => o.value)).not.toContain('fr-FR');
    expect(LOCALE_OPTIONS.map((o) => o.label).join(' ')).not.toContain('Français');
  });

  it('ofrece exactamente los idiomas soportados, ni uno más', () => {
    // La igualdad en los DOS sentidos es el punto: ofrecer de menos esconde un
    // idioma que sí existe, y ofrecer de más es el bug que se arregló.
    expect(LOCALE_OPTIONS.map((o) => o.value).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it('toda opción tiene etiqueta no vacía', () => {
    for (const option of LOCALE_OPTIONS) {
      expect(option.label.trim(), `sin etiqueta: ${option.value}`).not.toBe('');
    }
  });

  it('CAMINO DEGRADADO: un locale guardado que no se ofrece casa con una opción real', () => {
    // En base de datos puede haber tags que el selector no ofrece (altas por
    // SCIM, que copia el locale del IdP sin validar). `/account` y `/onboarding`
    // normalizan antes de pintar el `<select>`; sin eso el desplegable no
    // casaría con ninguna opción y quedaría en blanco.
    const almacenados = ['pt-PT', 'fr-FR', 'zz', ''];
    for (const guardado of almacenados) {
      const normalizado = toSupportedLocale(guardado);
      expect(
        LOCALE_OPTIONS.some((o) => o.value === normalizado),
        `${guardado} degradó a ${normalizado}, que no está en el selector`,
      ).toBe(true);
    }
  });
});
