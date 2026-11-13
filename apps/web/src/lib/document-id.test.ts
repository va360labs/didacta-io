/**
 * Espejo de `apps/api/tests/document-id.test.ts`: los dos validadores (API y
 * web) deben aceptar y rechazar exactamente lo mismo, o la validación inline
 * mentiría sobre lo que el backend va a guardar.
 */

import { describe, expect, it } from 'vitest';
import {
  asksSpanishDocument,
  isDocumentFieldValid,
  isValidDocumentId,
  normalizeDocumentId,
} from './document-id';

describe('normalizeDocumentId', () => {
  it('quita espacios, puntos y guiones, y pasa a mayúsculas', () => {
    expect(normalizeDocumentId('12.345.678-z')).toBe('12345678Z');
    expect(normalizeDocumentId(' x 123-45 67 l ')).toBe('X1234567L');
    expect(normalizeDocumentId('y-1234567x')).toBe('Y1234567X');
  });
});

describe('isValidDocumentId', () => {
  it('acepta DNIs reales con la letra de control correcta', () => {
    expect(isValidDocumentId('12345678Z')).toBe(true); // 12345678 % 23 = 14 → Z
    expect(isValidDocumentId('00000000T')).toBe(true); // 0 % 23 = 0 → T
    expect(isValidDocumentId('99999999R')).toBe(true); // 99999999 % 23 = 4 → R
  });

  it('acepta NIEs (X/Y/Z) con la letra correcta', () => {
    expect(isValidDocumentId('X1234567L')).toBe(true); // X1234567 → 01234567 % 23 = 19 → L
    expect(isValidDocumentId('Y1234567X')).toBe(true); // Y1234567 → 11234567 % 23 = 10 → X
    expect(isValidDocumentId('Z1234567R')).toBe(true); // Z1234567 → 21234567 % 23 = 1 → R
  });

  it('rechaza letra de control incorrecta', () => {
    expect(isValidDocumentId('12345678A')).toBe(false);
    expect(isValidDocumentId('X1234567A')).toBe(false);
  });

  it('rechaza formato inválido', () => {
    expect(isValidDocumentId('1234567Z')).toBe(false); // 7 dígitos en DNI
    expect(isValidDocumentId('123456789')).toBe(false); // sin letra
    expect(isValidDocumentId('A12345678Z')).toBe(false); // letra al inicio en DNI
    expect(isValidDocumentId('W1234567L')).toBe(false); // prefijo no NIE
    expect(isValidDocumentId('')).toBe(false);
    expect(isValidDocumentId('12.345.678-Z')).toBe(false); // sin normalizar
    expect(isValidDocumentId('asdfaekjr')).toBe(false); // el caso literal del issue #59
  });
});

describe('isDocumentFieldValid (campo opcional de formulario)', () => {
  it('vacío o solo espacios es válido (el campo es opcional)', () => {
    expect(isDocumentFieldValid('')).toBe(true);
    expect(isDocumentFieldValid('   ')).toBe(true);
  });

  it('normaliza antes de validar (acepta variantes razonables)', () => {
    expect(isDocumentFieldValid('12.345.678-z')).toBe(true);
    expect(isDocumentFieldValid(' x1234567l ')).toBe(true);
  });

  it('rechaza texto arbitrario y letras de control incorrectas', () => {
    expect(isDocumentFieldValid('asdfaekjr')).toBe(false);
    expect(isDocumentFieldValid('12345678A')).toBe(false);
  });
});

describe('asksSpanishDocument', () => {
  it('se pide con la interfaz en español (España o Argentina)', () => {
    expect(asksSpanishDocument('es-ES')).toBe(true);
    expect(asksSpanishDocument('es-AR')).toBe(true);
  });

  it('no se pide con la interfaz en inglés', () => {
    expect(asksSpanishDocument('en-US')).toBe(false);
  });
});
