import { describe, expect, it } from 'vitest';
import {
  formatIban,
  isValidIban,
  isValidSpanishTaxId,
  maskIban,
  maskTaxId,
  normalizePayee,
  PayeeValidationError,
} from '../src/payee.js';

describe('datos para cobrar en dinero', () => {
  it('IBAN: dígito de control y longitud del país', () => {
    expect(isValidIban('ES91 2100 0418 4502 0005 1332')).toBe(true);
    expect(isValidIban('de89370400440532013000')).toBe(true);
    expect(isValidIban('GB82WEST12345698765432')).toBe(true);
    expect(isValidIban('ES91 2100 0418 4502 0005 1333')).toBe(false); // control mal
    expect(isValidIban('ES9121000418450200051')).toBe(false); // corto para ES
    expect(isValidIban('no es un iban')).toBe(false);
  });

  it('NIF y NIE con su letra de control', () => {
    expect(isValidSpanishTaxId('12345678Z')).toBe(true);
    expect(isValidSpanishTaxId('12345678-z')).toBe(true);
    expect(isValidSpanishTaxId('12345678A')).toBe(false);
    expect(isValidSpanishTaxId('X1234567L')).toBe(true);
    expect(isValidSpanishTaxId('X1234567A')).toBe(false);
    expect(isValidSpanishTaxId('B12345678')).toBe(false);
  });

  it('normaliza y valida; fuera de España vale el identificador del país', () => {
    expect(
      normalizePayee({
        fullName: '  Lucía   Pérez ',
        country: 'es',
        taxId: '12345678-z',
        iban: 'es91 2100 0418 4502 0005 1332',
      }),
    ).toEqual({
      fullName: 'Lucía Pérez',
      country: 'ES',
      taxId: '12345678Z',
      iban: 'ES9121000418450200051332',
    });
    expect(
      normalizePayee({
        fullName: 'Anna Schmidt',
        country: 'DE',
        taxId: '12 345 678 901',
        iban: 'DE89 3704 0044 0532 0130 00',
      }).taxId,
    ).toBe('12345678901');
  });

  it('dice QUÉ campos fallan y nunca sus valores', () => {
    try {
      normalizePayee({ fullName: 'Lucía', country: 'ES', taxId: '12345678A', iban: 'ES00' });
      throw new Error('no debía pasar');
    } catch (err) {
      expect(err).toBeInstanceOf(PayeeValidationError);
      expect((err as PayeeValidationError).fields).toEqual(['fullName', 'taxId', 'iban']);
      expect((err as Error).message).not.toContain('12345678A');
      expect((err as Error).message).not.toContain('ES00');
    }
  });

  it('enmascara lo que ve el alumno y agrupa el IBAN para el creador', () => {
    expect(maskIban('ES9121000418450200051332')).toBe('ES•• •••• 1332');
    expect(maskTaxId('12345678Z')).toBe('•••••678Z');
    expect(formatIban('ES9121000418450200051332')).toBe('ES91 2100 0418 4502 0005 1332');
  });
});
