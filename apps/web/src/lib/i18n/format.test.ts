import { afterEach, describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import es from '@/i18n/messages/es';
import en from '@/i18n/messages/en';
import pt from '@/i18n/messages/pt';
import {
  formatCents,
  formatCentsExact,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatTime,
  regionNameFormatter,
} from './format';
import { resetUserFormatPrefs, setUserFormatPrefs } from './user-prefs';

const D = new Date('2026-08-07T15:30:00.000Z');

afterEach(() => {
  resetUserFormatPrefs();
});

describe('formatDate / formatDateTime / formatTime', () => {
  it('con overrides explícitos es determinista (patrón RSC)', () => {
    expect(formatDate(D, { locale: 'en-US', timeZone: 'UTC', dateStyle: 'medium' })).toBe(
      'Aug 7, 2026',
    );
    expect(formatDate(D, { locale: 'es-ES', timeZone: 'UTC', day: 'numeric', month: 'long' })).toBe(
      '7 de agosto',
    );
  });

  it('acepta string ISO y epoch además de Date', () => {
    expect(formatDate('2026-08-07T15:30:00.000Z', { locale: 'en-US', timeZone: 'UTC' })).toBe(
      formatDate(D, { locale: 'en-US', timeZone: 'UTC' }),
    );
    expect(formatDate(D.getTime(), { locale: 'en-US', timeZone: 'UTC' })).toBe(
      formatDate(D, { locale: 'en-US', timeZone: 'UTC' }),
    );
  });

  it('usa el singleton de prefs cuando no hay override (patrón client)', () => {
    setUserFormatPrefs({ locale: 'en-US', timeZone: 'America/New_York' });
    expect(formatTime(D, { hour: '2-digit', minute: '2-digit', hour12: false })).toBe('11:30');
    setUserFormatPrefs({ timeZone: 'Europe/Madrid' });
    expect(formatTime(D, { hour: '2-digit', minute: '2-digit', hour12: false })).toBe('17:30');
  });

  it('la timezone del usuario afecta a la FECHA mostrada (bug que motivó F1)', () => {
    const nearMidnight = new Date('2026-08-07T23:30:00.000Z');
    const madrid = formatDateTime(nearMidnight, {
      locale: 'es-ES',
      timeZone: 'Europe/Madrid',
      day: 'numeric',
    });
    const buenosAires = formatDateTime(nearMidnight, {
      locale: 'es-ES',
      timeZone: 'America/Argentina/Buenos_Aires',
      day: 'numeric',
    });
    expect(madrid).not.toBe(buenosAires);
  });
});

describe('formatNumber / formatCurrency', () => {
  it('separadores por locale (es-ES vs en-US)', () => {
    expect(formatNumber(1234.5, { locale: 'es-ES' })).toBe('1234,5');
    expect(formatNumber(1234.5, { locale: 'en-US' })).toBe('1,234.5');
  });

  it('moneda EUR por defecto, otras monedas configurables', () => {
    expect(formatCurrency(1234.5, 'EUR', { locale: 'es-ES' })).toContain('€');
    expect(formatCurrency(99, 'USD', { locale: 'en-US' })).toBe('$99.00');
  });
});

/**
 * Formato de `pt-BR`. Los helpers no tienen ni una línea propia para el
 * portugués: reciben el tag activo y se lo pasan a `Intl`. Lo que estos tests
 * fijan es que el tag que llega es `pt-BR` y NO un `es-ES` degradado — con el
 * español al lado como control, porque los dos idiomas comparten coma decimal
 * y nombres de mes («7 de agosto de 2026» se escribe igual) y solo se
 * distinguen en lo que aquí se afirma.
 *
 * NBSP explícito (` `) entre símbolo e importe: es lo que mete `Intl`.
 */
describe('formato pt-BR (fechas, números y moneda)', () => {
  it('números: punto de millar desde el 1.000 (el español no lo pone hasta 10.000)', () => {
    expect(formatNumber(1234.5, { locale: 'pt-BR' })).toBe('1.234,5');
    // Control: mismo número, locale español.
    expect(formatNumber(1234.5, { locale: 'es-ES' })).toBe('1234,5');
  });

  it('moneda: símbolo DELANTE, al revés que en español', () => {
    expect(formatCurrency(1234.5, 'BRL', { locale: 'pt-BR' })).toBe('R$ 1.234,50');
    expect(formatCurrency(1234.5, 'EUR', { locale: 'pt-BR' })).toBe('€ 1.234,50');
    // Control: el español lo pone detrás.
    expect(formatCurrency(1234.5, 'EUR', { locale: 'es-ES' })).toBe('1234,50 €');
  });

  it('céntimos: la regla del producto (redondo → sin decimales) vale igual', () => {
    expect(formatCents(1900, 'BRL', { locale: 'pt-BR' })).toBe('R$ 19');
    expect(formatCents(1990, 'BRL', { locale: 'pt-BR' })).toBe('R$ 19,90');
    expect(formatCentsExact(1900, 'BRL', { locale: 'pt-BR' })).toBe('R$ 19,00');
  });

  it('fechas: día/mes/año con cero a la izquierda y reloj de 24 h', () => {
    const tz = 'America/Sao_Paulo';
    expect(formatDate(D, { locale: 'pt-BR', timeZone: tz })).toBe('07/08/2026');
    expect(
      formatDate(D, { locale: 'pt-BR', timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' }), // prettier-ignore
    ).toBe('7 de agosto de 2026');
    expect(formatTime(D, { locale: 'pt-BR', timeZone: tz, hour: '2-digit', minute: '2-digit' })).toBe('12:30'); // prettier-ignore
    // Control: el inglés de EE. UU. invierte día y mes y usa AM/PM.
    expect(formatDate(D, { locale: 'en-US', timeZone: tz })).toBe('8/7/2026');
  });

  it('fecha larga con día de la semana: en portugués, no en español', () => {
    const opts = { timeZone: 'America/Sao_Paulo', weekday: 'long', day: 'numeric', month: 'long' } as const; // prettier-ignore
    expect(formatDate(D, { locale: 'pt-BR', ...opts })).toBe('sexta-feira, 7 de agosto');
    // Control: es aquí donde un `pt-BR` degradado a `es-ES` se vería.
    expect(formatDate(D, { locale: 'es-ES', ...opts })).toBe('viernes, 7 de agosto');
  });

  it('el locale activo llega por el singleton (patrón client)', () => {
    setUserFormatPrefs({ locale: 'pt-BR', timeZone: 'America/Sao_Paulo' });
    expect(formatNumber(1234.5)).toBe('1.234,5');
    expect(formatDate(D)).toBe('07/08/2026');
  });
});

describe('formatCents', () => {
  it('cantidad redonda → sin decimales; con resto → 2 decimales', () => {
    expect(formatCents(99900, 'USD', { locale: 'en-US' })).toBe('$999');
    expect(formatCents(99950, 'USD', { locale: 'en-US' })).toBe('$999.50');
  });

  it('respeta overrides explícitos de decimales', () => {
    expect(formatCents(99900, 'USD', { locale: 'en-US', minimumFractionDigits: 2 })).toBe(
      '$999.00',
    );
  });

  /**
   * La regla, escrita en el par de importes con el que se decidió: los dos
   * lados del programa de referidos (`/referrals` y `/admin/referrals`) pintan
   * la MISMA comisión, así que tienen que escribirla igual. El `amountLabel`
   * de `/admin/referrals` conservaba el céntimo cero y es el que se unificó.
   *
   * NBSP explícito (` `): es lo que mete Intl entre importe y símbolo, y
   * un espacio normal daría un rojo indistinguible a simple vista.
   */
  it('en es-ES: 1900 → "19 €" y 297 → "2,97 €"', () => {
    expect(formatCents(1900, 'EUR', { locale: 'es-ES' })).toBe('19 €');
    expect(formatCents(297, 'EUR', { locale: 'es-ES' })).toBe('2,97 €');
  });
});

/**
 * CAMINO DEGRADADO de moneda.
 *
 * El bug que cierra: `Intl.NumberFormat` LANZA `RangeError: Invalid currency
 * code` ante una divisa que no sea ISO-4217 de 3 letras, y la divisa es dato
 * ajeno (proveedor de pago o configuración del tenant). Los `formatAmount` por
 * página a los que sustituyó `formatCents` sí tenían `try/catch`; el canónico
 * nació sin él, así que un código inesperado tumbaba el render de la pantalla.
 */
describe('formatCurrency / formatCents · divisa inválida', () => {
  it('degrada al formato histórico "<importe> <CÓDIGO>" en vez de lanzar', () => {
    expect(formatCurrency(19.99, 'XXXXX', { locale: 'es-ES' })).toBe('19.99 XXXXX');
    expect(formatCurrency(1234.5, 'no-es-una-divisa', { locale: 'en-US' })).toBe(
      '1234.50 NO-ES-UNA-DIVISA',
    );
  });

  it('formatCents y formatCentsExact heredan el degradado por delegación', () => {
    expect(formatCents(1999, 'XXXXX', { locale: 'es-ES' })).toBe('19.99 XXXXX');
    // Céntimo redondo: el degradado NO aplica la regla de "sin decimales", es
    // el formato de emergencia de siempre (2 decimales fijos).
    expect(formatCents(1900, 'XXXXX', { locale: 'es-ES' })).toBe('19.00 XXXXX');
    expect(formatCentsExact(1900, 'XXXXX', { locale: 'es-ES' })).toBe('19.00 XXXXX');
  });

  it('divisa vacía: importe legible, sin espacio colgando', () => {
    expect(formatCents(1999, '', { locale: 'es-ES' })).toBe('19.99');
  });

  it('la divisa VÁLIDA sigue pasando por Intl (el degradado no se cuela)', () => {
    // Intl separa importe y símbolo con un espacio DURO (U+00A0): comparar con
    // un espacio normal daría un falso rojo idéntico a simple vista.
    expect(formatCents(1900, 'EUR', { locale: 'es-ES' })).toBe('19 €');
    expect(formatCents(1999, 'USD', { locale: 'en-US' })).toBe('$19.99');
    expect(formatCentsExact(1900, 'EUR', { locale: 'es-ES' })).toBe('19,00 €');
  });
});

/**
 * CAMINO DEGRADADO de fecha/hora.
 *
 * Mismo agujero, peor exposición: la `timeZone` sale del perfil del usuario
 * (`locale-sync.tsx:58`) y la API la acepta como `z.string().min(1).max(64)`
 * (`me.controller.ts:68`), sin comprobar que sea IANA. Una zona que Intl no
 * conoce LANZA `RangeError: Invalid time zone specified` — y eso es TODA
 * pantalla con una fecha, no una fila.
 */
describe('formatDate / formatDateTime / formatTime · timezone inválida', () => {
  it('reintenta sin timezone y conserva locale, idioma y opciones', () => {
    const opts = { locale: 'es-ES', timeZone: 'Marte/Olympus_Mons' } as const;
    expect(formatDate(D, { ...opts, month: 'long' })).toBe('agosto');
    expect(formatDate(D, { ...opts, year: 'numeric' })).toBe('2026');
    expect(formatDateTime(D, { ...opts, month: 'long' })).toBe('agosto');
    expect(formatTime(D, { ...opts, hour: '2-digit', hour12: false })).toMatch(/^\d{2}$/);
  });

  it('también degrada cuando la tz inválida viene del perfil (singleton)', () => {
    setUserFormatPrefs({ locale: 'es-ES', timeZone: 'no/es/una/zona' });
    expect(formatDate(D, { month: 'long' })).toBe('agosto');
  });

  it('último recurso: ni con locale corrupto lanza', () => {
    const roto = { locale: 'no_es_un_locale', timeZone: 'Marte/Olympus_Mons' } as const;
    expect(() => formatDate(D, roto)).not.toThrow();
    expect(() => formatDateTime(D, roto)).not.toThrow();
    expect(() => formatTime(D, roto)).not.toThrow();
    expect(formatDate(D, roto)).not.toBe('');
  });

  it('una fecha inválida sigue devolviendo "Invalid Date", no una excepción', () => {
    expect(formatDate('no-es-una-fecha', { locale: 'es-ES', timeZone: 'UTC' })).toBe(
      'Invalid Date',
    );
    expect(formatDate('no-es-una-fecha', { locale: 'es-ES', timeZone: 'Marte/Olympus' })).toBe(
      'Invalid Date',
    );
  });

  it('la timezone VÁLIDA sigue mandando (el degradado no se cuela)', () => {
    expect(
      formatTime(D, { locale: 'es-ES', timeZone: 'UTC', hour: '2-digit', hour12: false }),
    ).toBe('15');
    expect(
      formatTime(D, {
        locale: 'es-ES',
        timeZone: 'Australia/Sydney',
        hour: '2-digit',
        hour12: false,
      }),
    ).toBe('01');
  });
});

describe('formatDuration (ICU, sucesora de lib/format)', () => {
  const tEs = createTranslator({ locale: 'es-ES', messages: es, namespace: 'common' });
  const tEn = createTranslator({ locale: 'en-US', messages: en, namespace: 'common' });
  const tPt = createTranslator({ locale: 'pt-BR', messages: pt, namespace: 'common' });

  it('mantiene el contrato de la vieja formatDuration (paridad lib/format.test)', () => {
    expect(formatDuration(45, tEs)).toBe('45 min');
    expect(formatDuration(60, tEs)).toBe('1 h');
    expect(formatDuration(90, tEs)).toBe('1 h 30 min');
    expect(formatDuration(3000, tEs)).toBe('50 h');
    expect(formatDuration(0, tEs)).toBe('0 min');
  });

  it('null/undefined/negativo/no-finito → null', () => {
    expect(formatDuration(null, tEs)).toBeNull();
    expect(formatDuration(undefined, tEs)).toBeNull();
    expect(formatDuration(-5, tEs)).toBeNull();
    expect(formatDuration(Number.NaN, tEs)).toBeNull();
  });

  it('resuelve contra el catálogo del locale activo', () => {
    expect(formatDuration(90, tEn)).toBe('1 h 30 min');
    expect(formatDuration(90, tPt)).toBe('1 h 30 min');
    expect(formatDuration(45, tPt)).toBe('45 min');
  });
});

describe('regionNameFormatter', () => {
  it('traduce códigos de país al idioma pedido y devuelve el código si no lo conoce', () => {
    expect(regionNameFormatter('es')('ES')).toBe('España');
    expect(regionNameFormatter('en')('es')).toBe('Spain');
    expect(regionNameFormatter('es')('ZZ9')).toBe('ZZ9');
  });
});
