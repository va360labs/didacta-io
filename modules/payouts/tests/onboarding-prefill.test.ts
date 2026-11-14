import { describe, expect, it } from 'vitest';
import { identityFor } from '../src/accounts.service.js';
import { esProvinceCode, esProvinceName } from '../src/tax/es-provinces.js';
import { identityFromStripe, onboardingIdentityFromTax } from '../src/tax/tax-profile.service.js';

// ============================================================================
// Prueba real del 14-nov-2026: al conectar cobros se preguntaba lo mismo varias
// veces y la provincia llegaba de Stripe como «CA» (código ISO 3166-2 de
// Cádiz). Aquí se fija lo puro: la tabla de provincias, qué se precarga en la
// cuenta de Stripe a partir de los datos fiscales y cuándo.
// ============================================================================

describe('provincias de España ↔ ISO 3166-2 (formato de Stripe)', () => {
  it.each([
    ['Cádiz', 'CA'],
    ['cadiz', 'CA'],
    ['  CÁDIZ ', 'CA'],
    ['Provincia de Cádiz', 'CA'],
    ['Madrid', 'M'],
    ['A Coruña', 'C'],
    ['La Coruña', 'C'],
    ['Alicante/Alacant', 'A'],
    ['Alacant', 'A'],
    ['València', 'V'],
    ['Castelló', 'CS'],
    ['Vizcaya', 'BI'],
    ['Gipuzkoa', 'SS'],
    ['Guipúzcoa', 'SS'],
    ['Álava', 'VI'],
    ['Illes Balears', 'PM'],
    ['Baleares', 'PM'],
    ['Las Palmas', 'GC'],
    ['Santa Cruz de Tenerife', 'TF'],
    ['Lérida', 'L'],
    ['Ceuta', 'CE'],
  ])('«%s» → %s', (name, code) => {
    expect(esProvinceCode(name)).toBe(code);
  });

  it('acepta el propio código, con o sin «ES-»', () => {
    expect(esProvinceCode('CA')).toBe('CA');
    expect(esProvinceCode('es-ca')).toBe('CA');
    expect(esProvinceCode('M')).toBe('M');
  });

  it('lo que no se reconoce no se inventa: null (control)', () => {
    expect(esProvinceCode('Andalucía')).toBeNull();
    expect(esProvinceCode('California')).toBeNull();
    expect(esProvinceCode('XX')).toBeNull();
    expect(esProvinceCode('')).toBeNull();
    expect(esProvinceCode(null)).toBeNull();
  });

  it('código de Stripe → nombre; un nombre ya escrito se deja como está', () => {
    expect(esProvinceName('CA')).toBe('Cádiz');
    expect(esProvinceName('ES-M')).toBe('Madrid');
    expect(esProvinceName('PM')).toBe('Illes Balears');
    expect(esProvinceName('Sevilla')).toBe('Sevilla');
    expect(esProvinceName('Comarca inventada')).toBe('Comarca inventada');
    expect(esProvinceName(null)).toBeNull();
  });

  it('las 52 provincias van y vuelven sin perderse', () => {
    const codes = [
      'A',
      'AB',
      'AL',
      'AV',
      'B',
      'BA',
      'BI',
      'BU',
      'C',
      'CA',
      'CC',
      'CE',
      'CO',
      'CR',
      'CS',
      'CU',
      'GC',
      'GI',
      'GR',
      'GU',
      'H',
      'HU',
      'J',
      'L',
      'LE',
      'LO',
      'LU',
      'M',
      'MA',
      'ML',
      'MU',
      'NA',
      'O',
      'OR',
      'P',
      'PM',
      'PO',
      'S',
      'SA',
      'SE',
      'SG',
      'SO',
      'SS',
      'T',
      'TE',
      'TF',
      'TO',
      'V',
      'VA',
      'VI',
      'Z',
      'ZA',
    ];
    expect(codes).toHaveLength(52);
    for (const code of codes) {
      expect(esProvinceCode(esProvinceName(code))).toBe(code);
    }
  });
});

describe('datos de Stripe → formulario fiscal: la provincia con su nombre', () => {
  it('España: «CA» llega como «Cádiz» (lo que tuvo que corregir a mano)', () => {
    const prefill = identityFromStripe(
      {
        country: 'ES',
        business_type: 'individual',
        individual: {
          first_name: 'Ana',
          last_name: 'Prueba',
          address: { line1: 'Calle Ancha 1', postal_code: '11001', city: 'Cádiz', state: 'CA' },
        },
      },
      'ES',
      'individual',
    );
    expect(prefill.address?.region).toBe('Cádiz');
  });

  it('fuera de España el estado se deja como lo da Stripe (control)', () => {
    const prefill = identityFromStripe(
      {
        country: 'US',
        business_type: 'individual',
        individual: {
          address: { line1: '1 Main St', postal_code: '10001', city: 'New York', state: 'NY' },
        },
      },
      'US',
      'individual',
    );
    expect(prefill.address?.region).toBe('NY');
  });
});

describe('datos fiscales guardados → precarga de la cuenta de Stripe', () => {
  const PERSONA = {
    entityType: 'individual' as const,
    legalName: 'Ana Prueba',
    country: 'ES',
    taxId: '12345678Z',
    address: {
      line1: 'Calle Ancha 1',
      line2: '2º B',
      postalCode: '11001',
      city: 'Cádiz',
      region: 'Cádiz',
    },
    birthDate: '1990-02-28',
  };

  it('persona en España: dirección con la provincia en código, fecha partida y NIF', () => {
    expect(onboardingIdentityFromTax(PERSONA)).toEqual({
      country: 'ES',
      entityType: 'individual',
      companyName: null,
      address: {
        line1: 'Calle Ancha 1',
        line2: '2º B',
        postalCode: '11001',
        city: 'Cádiz',
        state: 'CA',
      },
      birthDate: { year: 1990, month: 2, day: 28 },
      taxId: '12345678Z',
    });
  });

  it('provincia que no se reconoce: la dirección va, la provincia no', () => {
    const out = onboardingIdentityFromTax({
      ...PERSONA,
      address: { ...PERSONA.address, region: 'Andalucía' },
    });
    expect(out?.address).toMatchObject({ city: 'Cádiz', state: null });
  });

  it('empresa: razón social, sin fecha de nacimiento', () => {
    const out = onboardingIdentityFromTax({
      ...PERSONA,
      entityType: 'company',
      legalName: 'Academia Prueba SL',
      taxId: 'B12345674',
      birthDate: null,
    });
    expect(out).toMatchObject({
      entityType: 'company',
      companyName: 'Academia Prueba SL',
      birthDate: null,
      taxId: 'B12345674',
    });
  });

  it('dirección incompleta: no se precarga ninguna (que la pida el alta)', () => {
    const out = onboardingIdentityFromTax({
      ...PERSONA,
      address: { line1: 'Calle Ancha 1', postalCode: '', city: 'Cádiz' },
    });
    expect(out?.address).toBeNull();
  });

  it('sin datos fiscales, nada', () => {
    expect(onboardingIdentityFromTax(null)).toBeNull();
  });
});

describe('identityFor: solo se precarga lo que casa con lo elegido al conectar', () => {
  const BASE = { email: 'admin@academia.test', displayName: 'Academia' };
  const FISCALES = onboardingIdentityFromTax({
    entityType: 'individual',
    legalName: 'Ana Prueba',
    country: 'ES',
    taxId: '12345678Z',
    address: { line1: 'Calle Ancha 1', postalCode: '11001', city: 'Cádiz', region: 'Cádiz' },
    birthDate: '1990-02-28',
  });

  it('sin datos fiscales: el correo de quien conecta como correo de la persona', () => {
    expect(identityFor(BASE, 'ES', 'individual')).toEqual({ email: 'admin@academia.test' });
  });

  it('empresa sin datos fiscales: nada (el correo es de la persona, no de la empresa)', () => {
    expect(identityFor(BASE, 'ES', 'company')).toBeNull();
  });

  it('datos fiscales del mismo país y tipo: todo', () => {
    expect(identityFor({ ...BASE, identity: FISCALES }, 'ES', 'individual')).toEqual({
      email: 'admin@academia.test',
      companyName: null,
      address: expect.objectContaining({ state: 'CA' }),
      birthDate: { year: 1990, month: 2, day: 28 },
      taxId: '12345678Z',
    });
  });

  it('datos fiscales de particular y conecta como empresa: no se mezclan', () => {
    expect(identityFor({ ...BASE, identity: FISCALES }, 'ES', 'company')).toBeNull();
  });

  it('datos fiscales de otro país: no se mezclan', () => {
    expect(identityFor({ ...BASE, identity: FISCALES }, 'FR', 'individual')).toEqual({
      email: 'admin@academia.test',
    });
  });
});
