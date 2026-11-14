import { describe, expect, it } from 'vitest';
import {
  academyInitials,
  academyMarkColors,
  contrastRatio,
  didactaSiteLang,
  drawableWithLatinFont,
  hslToHex,
  MARK_DARK_TEXT,
  MARK_LIGHT_TEXT,
  MIN_MARK_CONTRAST,
  NEUTRAL_MARK_COLORS,
  poweredByHref,
} from './academy-mark';

/**
 * Misma tabla que `apps/api/tests/academy-mark.test.ts`: la web y los correos
 * tienen que sacar las MISMAS iniciales del mismo nombre.
 */
const CASOS_INICIALES: Array<[string | null | undefined, string]> = [
  ['Potenzia', 'P'],
  ['Academia de Yoga', 'AY'],
  ['  Ana   Pérez  ', 'AP'],
  ['ágora escuela', 'ÁE'],
  ['Ágora', 'Á'],
  // «É» descompuesta (E + acento combinado): una sola letra, con su tilde.
  ['E\u0301cole Lumière', 'ÉL'],
  // Una letra sin forma compuesta conserva su marca combinante.
  ['x\u0303avier Ruiz', 'X\u0303R'],
  ['Ñandú Formación', 'ÑF'],
  ['🚀 Cohete Academy', 'CA'],
  ['Cohete 🚀', 'C'],
  ['¡Hola Mundo!', 'HM'],
  ['Yoga-Pilates', 'YP'],
  ['Arte & Diseño', 'AD'],
  ['360 Academy', '3A'],
  ['VA360', 'V'],
  ['东京 学院', '东学'],
  ['Академия Света', 'АС'],
  ['🚀🔥', ''],
  ['   ', ''],
  ['', ''],
  [null, ''],
  [undefined, ''],
];

describe('academyInitials', () => {
  it.each(CASOS_INICIALES)('%j → %j', (name, expected) => {
    expect(academyInitials(name)).toBe(expected);
  });

  it('nunca pasa de dos letras visibles', () => {
    for (const [name] of CASOS_INICIALES) {
      const letras = academyInitials(name).match(/[\p{L}\p{N}]/gu) ?? [];
      expect(letras.length).toBeLessThanOrEqual(2);
    }
  });

  it('una letra que en mayúscula serían dos («ß») se queda como está', () => {
    expect(academyInitials('ßtudio')).toBe('ß');
  });
});

describe('academyMarkColors', () => {
  it('el color por defecto del aula (213/70) lleva letras blancas sobre su azul', () => {
    const c = academyMarkColors(213, 70);
    expect(c).toEqual({ background: hslToHex(213, 72, 38), foreground: MARK_LIGHT_TEXT });
  });

  it('sin color conocido, el de por defecto', () => {
    expect(academyMarkColors(null, undefined)).toEqual(academyMarkColors(213, 70));
    expect(academyMarkColors('rojo', NaN)).toEqual(academyMarkColors(213, 70));
  });

  it('un amarillo no lleva letras blancas (no se leerían): casi negro', () => {
    const c = academyMarkColors(55, 90);
    expect(contrastRatio(hslToHex(55, 92, 38), MARK_LIGHT_TEXT)).toBeLessThan(MIN_MARK_CONTRAST);
    expect(c.foreground).toBe(MARK_DARK_TEXT);
  });

  it('contraste AA para CUALQUIER color de marca (todo el círculo, toda saturación)', () => {
    const peores: string[] = [];
    for (let h = 0; h <= 360; h += 3) {
      for (let s = 0; s <= 100; s += 5) {
        const c = academyMarkColors(h, s);
        const ratio = contrastRatio(c.background, c.foreground);
        if (ratio < MIN_MARK_CONTRAST) peores.push(`${h}/${s}: ${ratio.toFixed(2)}`);
      }
    }
    expect(peores).toEqual([]);
  });

  it('el gris neutro también se lee', () => {
    expect(
      contrastRatio(NEUTRAL_MARK_COLORS.background, NEUTRAL_MARK_COLORS.foreground),
    ).toBeGreaterThanOrEqual(MIN_MARK_CONTRAST);
  });

  it('control: el contraste discrimina (blanco sobre blanco es 1, negro sobre blanco 21)', () => {
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21);
  });
});

describe('poweredByHref', () => {
  it('al alta de didacta.io en el idioma del aula, con la campaña del aula', () => {
    expect(poweredByHref('es-ES', 'mi-academia')).toBe(
      'https://didacta.io/es/start?utm_source=aula&utm_medium=powered_by&utm_campaign=mi-academia',
    );
    expect(poweredByHref('en-US', 'mi-academia')).toBe(
      'https://didacta.io/en/start?utm_source=aula&utm_medium=powered_by&utm_campaign=mi-academia',
    );
    expect(poweredByHref('pt-BR', 'mi-academia')).toBe(
      'https://didacta.io/pt-br/start?utm_source=aula&utm_medium=powered_by&utm_campaign=mi-academia',
    );
  });

  it('sin slug, sin campaña (no se inventa)', () => {
    expect(poweredByHref('es', null)).toBe(
      'https://didacta.io/es/start?utm_source=aula&utm_medium=powered_by',
    );
  });

  it('el español de Argentina va a /es; un idioma ajeno, a /en', () => {
    expect(didactaSiteLang('es-AR')).toBe('es');
    expect(didactaSiteLang('pt')).toBe('pt-br');
    expect(didactaSiteLang('fr-FR')).toBe('en');
    expect(didactaSiteLang(undefined)).toBe('en');
  });
});

describe('drawableWithLatinFont', () => {
  it('latín con tildes sí; cirílico y CJK no', () => {
    expect(drawableWithLatinFont('ÁÑ')).toBe(true);
    expect(drawableWithLatinFont('ÇÃ')).toBe(true);
    expect(drawableWithLatinFont('АС')).toBe(false);
    expect(drawableWithLatinFont('东学')).toBe(false);
  });
});
