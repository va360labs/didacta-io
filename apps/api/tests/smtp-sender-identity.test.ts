import { describe, expect, it } from 'vitest';
import {
  SENDER_NAME_MAX,
  displayNameFromAddress,
  resolveSenderName,
  sanitizeReplyTo,
  sanitizeSenderName,
} from '../src/modules/smtp-sender-identity';

describe('sanitizeSenderName', () => {
  it('deja intacto un nombre normal con acentos y ñ', () => {
    expect(sanitizeSenderName('Academia Ñandú de Pruebas')).toBe('Academia Ñandú de Pruebas');
  });

  it('inyección de cabeceras: CR/LF no sobreviven y el resto queda en una línea', () => {
    const out = sanitizeSenderName('Academia\r\nBcc: x@y');
    expect(out).toBe('Academia Bcc: x y');
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).not.toContain('@');
  });

  it('quita controles, separadores Unicode y marcas bidi/ancho cero', () => {
    const out = sanitizeSenderName('A\u0000c\u0007a\u2028d\u2029e\u202Emi\u200Ba\u0085X\tY');
    expect(out).toBe('A c a d e mi a X Y');
  });

  it('nada con forma de dirección: fuera < > @ " \\ y sus parecidos de ancho completo', () => {
    expect(sanitizeSenderName('PayPal <soporte@paypal.com>')).toBe('PayPal soporte paypal.com');
    expect(sanitizeSenderName('"Banco" \\ x')).toBe('Banco x');
    expect(sanitizeSenderName('Banco\uFF1Csoporte\uFF20banco.com\uFF1E')).toBe(
      'Banco soporte banco.com',
    );
  });

  it(`corta a ${SENDER_NAME_MAX} caracteres sin partir un carácter compuesto`, () => {
    const out = sanitizeSenderName('ñ'.repeat(200))!;
    expect(Array.from(out)).toHaveLength(SENDER_NAME_MAX);
    expect(out).toBe('ñ'.repeat(SENDER_NAME_MAX));
  });

  it('null si no queda nada o no es texto', () => {
    expect(sanitizeSenderName('  \r\n <@> ')).toBeNull();
    expect(sanitizeSenderName(undefined)).toBeNull();
    expect(sanitizeSenderName(42)).toBeNull();
  });
});

describe('sanitizeReplyTo', () => {
  it('acepta una dirección simple', () => {
    expect(sanitizeReplyTo(' contacto@academia.es ')).toBe('contacto@academia.es');
  });

  it.each([
    ['dos direcciones', 'a@x.com, b@y.com'],
    ['punto y coma', 'a@x.com;b@y.com'],
    ['inyección', 'a@x.com\r\nBcc: b@y.com'],
    ['con nombre', 'Yo <a@x.com>'],
    ['sin dominio', 'a@x'],
    ['sin arroba', 'ax.com'],
    ['vacía', '   '],
  ])('rechaza %s', (_, v) => {
    expect(sanitizeReplyTo(v)).toBeNull();
  });
});

describe('displayNameFromAddress / resolveSenderName', () => {
  it('extrae el nombre de «Nombre <email>» y nada si solo hay dirección', () => {
    expect(displayNameFromAddress('Didacta <hola@didacta.io>')).toBe('Didacta');
    expect(displayNameFromAddress('"Didacta" <hola@didacta.io>')).toBe('Didacta');
    expect(displayNameFromAddress('hola@didacta.io')).toBeNull();
    expect(displayNameFromAddress(undefined)).toBeNull();
  });

  it('precedencia: SMTP propio → academia → plataforma', () => {
    expect(resolveSenderName({ fixedName: 'Mío', fallbackName: 'Didacta' }, 'Academia')).toBe(
      'Mío',
    );
    expect(resolveSenderName({ fallbackName: 'Didacta' }, 'Academia')).toBe('Academia');
    expect(resolveSenderName({ fallbackName: 'Didacta' }, undefined)).toBe('Didacta');
    // Un nombre de academia que se queda vacío al sanear cae al de la plataforma.
    expect(resolveSenderName({ fallbackName: 'Didacta' }, '<@>')).toBe('Didacta');
    expect(resolveSenderName(undefined, undefined)).toBeNull();
  });
});
