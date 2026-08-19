import { describe, expect, it } from 'vitest';
import {
  isValidSpanishTaxId,
  normalizeSpanishTaxId,
  validateSpanishTaxId,
} from '../src/spanish-tax-id.js';

describe('normalizeSpanishTaxId', () => {
  it('uppercase + remove whitespace, dashes, dots', () => {
    expect(normalizeSpanishTaxId(' 12.345.678-z ')).toBe('12345678Z');
    expect(normalizeSpanishTaxId('a 5881 8501')).toBe('A58818501');
  });

  it('vacío queda vacío', () => {
    expect(normalizeSpanishTaxId('')).toBe('');
    expect(normalizeSpanishTaxId('   ')).toBe('');
  });
});

describe('validateSpanishTaxId — DNI', () => {
  it('acepta DNI válido', () => {
    const r = validateSpanishTaxId('12345678Z');
    expect(r).toEqual({ ok: true, kind: 'DNI', normalized: '12345678Z' });
  });

  it('acepta DNI con separadores y minúsculas', () => {
    const r = validateSpanishTaxId('12.345.678-z');
    expect(r.ok).toBe(true);
    expect(r.normalized).toBe('12345678Z');
    expect(r.kind).toBe('DNI');
  });

  it('rechaza DNI con letra incorrecta', () => {
    const r = validateSpanishTaxId('12345678A');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('DNI');
    expect(r.reason).toMatch(/Z/);
  });

  it('rechaza DNI con menos de 8 dígitos', () => {
    expect(validateSpanishTaxId('1234567Z').ok).toBe(false);
  });
});

describe('validateSpanishTaxId — NIE', () => {
  it.each([
    // Y -> 1, 10000000 % 23 = 14 -> letra Z
    ['Y0000000Z', true],
    // Y0000000A — letra incorrecta
    ['Y0000000A', false],
    // Z -> 2, 20000000 % 23 = 5 -> letra M
    ['Z0000000M', true],
    // X -> 0, 01234567 % 23 = 19 -> letra L
    ['X1234567L', true],
    // X con letra incorrecta
    ['X1234567Z', false],
  ])('NIE %s -> ok=%s', (input, ok) => {
    expect(validateSpanishTaxId(input).ok).toBe(ok);
    expect(validateSpanishTaxId(input).kind).toBe('NIE');
  });

  it('rechaza NIE con letra inicial inválida', () => {
    const r = validateSpanishTaxId('A1234567L');
    // A...L parece formato CIF, no NIE — debe fallar como CIF (control inválido)
    expect(r.ok).toBe(false);
  });
});

describe('validateSpanishTaxId — CIF', () => {
  it('acepta CIF con dígito de control (letra inicial A — opcional)', () => {
    // A58818501: Telefónica España (público). Calculado en docstring del módulo.
    const r = validateSpanishTaxId('A58818501');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('CIF');
  });

  it('acepta CIF con letra inicial que exige letra de control (P)', () => {
    // Construimos uno válido: P + 7 dígitos + letra calculada.
    // Para el algoritmo: digits 1234567 -> sumOdd = (1*2)+(3*2) sumando dígitos
    //   pos 0: 1*2=2 -> 2
    //   pos 2: 3*2=6 -> 6
    //   pos 4: 5*2=10 -> 1+0=1
    //   pos 6: 7*2=14 -> 1+4=5
    //   sumOdd = 14
    // sumPair = 2 + 4 + 6 = 12
    // total = 26 -> control = (10 - 26%10)%10 = 4 -> letra J-A-B-C-D-E-F-G-H-I[4] = D
    const r = validateSpanishTaxId('P1234567D');
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('CIF');
  });

  it('rechaza CIF con control incorrecto', () => {
    const r = validateSpanishTaxId('A58818500');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('CIF');
  });

  it('rechaza CIF con letra inicial fuera de la lista permitida', () => {
    const r = validateSpanishTaxId('I12345678');
    expect(r.ok).toBe(false);
  });

  it('CIF tipo A acepta tanto letra como dígito de control si coinciden', () => {
    // A58818501 cierra con dígito 1. La letra equivalente sería
    // J-A-B-C-D-E-F-G-H-I[1] = A. Ambas válidas.
    expect(validateSpanishTaxId('A58818501').ok).toBe(true);
    expect(validateSpanishTaxId('A5881850A').ok).toBe(true);
  });

  it('CIF tipo P sólo acepta letra (rechaza dígito)', () => {
    // P1234567 control digit = 4 -> debería ser letra D, no dígito 4.
    expect(validateSpanishTaxId('P1234567D').ok).toBe(true);
    expect(validateSpanishTaxId('P12345674').ok).toBe(false);
  });
});

describe('validateSpanishTaxId — input basura', () => {
  it.each(['', '   ', 'abc', '00000000A', 'X12345', 'A12345', 'invalid-input'])(
    'rechaza "%s"',
    (input) => {
      expect(validateSpanishTaxId(input).ok).toBe(false);
    },
  );
});

describe('isValidSpanishTaxId', () => {
  it('helper booleano coincide con .ok', () => {
    expect(isValidSpanishTaxId('12345678Z')).toBe(true);
    expect(isValidSpanishTaxId('00000000A')).toBe(false);
  });
});

describe('validateSpanishTaxId — NIF K/L/M (L2)', () => {
  // K (menores de 14 sin DNI), L (espanoles no residentes) y M (extranjeros
  // sin NIE) son NIF de PERSONA FISICA con la misma estructura y la misma
  // letra de control que el DNI. Caian en la rama de CIF y se rechazaban: un
  // autonomo extranjero con NIF-M no podia registrarse como empresa
  // bonificada.
  it.each(['K1234567L', 'L1234567L', 'M1234567L'])('acepta %s', (nif) => {
    const r = validateSpanishTaxId(nif);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe('DNI');
  });

  it('rechaza la letra de control equivocada', () => {
    const r = validateSpanishTaxId('M1234567A');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/letra de control/i);
  });

  it('normaliza antes de validar, como el resto', () => {
    expect(validateSpanishTaxId(normalizeSpanishTaxId(' m-1234567 l ')).ok).toBe(true);
  });
});
