import { describe, expect, it } from 'vitest';
import { isValidDocumentId, normalizeDocumentId } from '../src/auth/document-id';

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
    // X1234567 → 01234567 % 23 = 19 → L
    expect(isValidDocumentId('X1234567L')).toBe(true);
    // Y1234567 → 11234567 % 23 = 10 → X
    expect(isValidDocumentId('Y1234567X')).toBe(true);
    // Z1234567 → 21234567 % 23 = 1 → R
    expect(isValidDocumentId('Z1234567R')).toBe(true);
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
  });
});
