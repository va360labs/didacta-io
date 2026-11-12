/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Piezas puras de las condiciones legales: NIF y NIF-IVA, VIES (con un `fetch`
 * de mentira), régimen de IVA y desglose con el IVA incluido, meses en la hora
 * de Madrid, datos que propone Stripe y el PDF. El cálculo de facturas contra
 * Postgres real (numeración concurrente, rectificativas, inmutabilidad) está
 * en `apps/api/tests/integration/payouts-invoices.integration.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  FetchViesClient,
  checkBirthDate,
  checkSpanishNif,
  checkTaxId,
  checkVatId,
  formatInvoiceAmount,
  identityFromStripe,
  isEuVatCountry,
  madridDate,
  monthPeriod,
  missingFields,
  pdfSafe,
  previousMonthKey,
  renderInvoicePdf,
  spanishSpecialTerritory,
  splitVatIncluded,
  vatRegimeFor,
  regimeMention,
} from '../src/index.js';

describe('NIF español', () => {
  it.each([
    ['12345678Z', 'dni'],
    ['12.345.678-z', 'dni'],
    ['X1234567L', 'nie'],
    ['B24805335', 'company'],
    ['ESB24805335', 'company'],
    ['Q2826000H', 'company'],
  ])('%s es válido (%s)', (value, kind) => {
    expect(checkSpanishNif(value)).toMatchObject({ ok: true, kind });
  });

  it.each([
    ['12345678A', 'check_digit'],
    ['X1234567T', 'check_digit'],
    ['B24805336', 'check_digit'],
    ['Q2826000I', 'check_digit'],
    // Sociedad limitada (B): el control ha de ser cifra, nunca letra.
    ['B2480533E', 'check_digit'],
    ['ABC', 'format'],
    ['', 'format'],
  ])('%s no vale (%s)', (value, reason) => {
    expect(checkSpanishNif(value)).toEqual({ ok: false, reason });
  });

  it('una empresa no puede dar un DNI ni un particular un NIF de sociedad', () => {
    expect(checkTaxId('ES', 'company', '12345678Z')).toEqual({
      ok: false,
      reason: 'entity_mismatch',
    });
    expect(checkTaxId('ES', 'individual', 'B24805335')).toEqual({
      ok: false,
      reason: 'entity_mismatch',
    });
    expect(checkTaxId('ES', 'individual', 'x1234567l')).toEqual({ ok: true, value: 'X1234567L' });
    expect(checkTaxId('ES', 'company', null)).toEqual({ ok: false, reason: 'required' });
  });

  it('fuera de España solo se pide una forma razonable', () => {
    expect(checkTaxId('FR', 'company', '123 456 789')).toEqual({ ok: true, value: '123456789' });
    expect(checkTaxId('US', 'individual', '12-3456789')).toEqual({ ok: true, value: '123456789' });
    expect(checkTaxId('DE', 'company', '#')).toEqual({ ok: false, reason: 'format' });
  });
});

describe('NIF-IVA de la UE', () => {
  it('pone o acepta el prefijo del país (Grecia es EL, también si escriben GR)', () => {
    expect(checkVatId('DE', '123456789')).toMatchObject({ ok: true, value: 'DE123456789' });
    expect(checkVatId('DE', 'de 123 456 789')).toMatchObject({ ok: true, prefix: 'DE' });
    expect(checkVatId('GR', 'EL123456789')).toMatchObject({ ok: true, value: 'EL123456789' });
    expect(checkVatId('GR', 'GR123456789')).toMatchObject({ ok: true, value: 'EL123456789' });
    expect(checkVatId('ES', 'B24805335')).toMatchObject({ ok: true, value: 'ESB24805335' });
  });

  it('rechaza el de otro país, el español con control malo y los de fuera de la UE', () => {
    expect(checkVatId('PT', 'ES123456789')).toEqual({ ok: false, reason: 'country_mismatch' });
    expect(checkVatId('ES', 'ESB24805336')).toEqual({ ok: false, reason: 'format' });
    expect(checkVatId('GB', 'GB123456789')).toEqual({ ok: false, reason: 'not_eu' });
    expect(checkVatId('CH', 'CHE123')).toEqual({ ok: false, reason: 'not_eu' });
    expect(isEuVatCountry('NO')).toBe(false);
    expect(isEuVatCountry('gr')).toBe(true);
  });
});

describe('VIES (sin red)', () => {
  type Reply = { status: number; body: string } | Error;
  function client(reply: Reply, seen: Array<Record<string, unknown>> = []) {
    return new FetchViesClient({
      requesterVatId: 'ESB24805335',
      now: () => new Date('2026-11-12T10:00:00Z'),
      timeoutMs: 50,
      fetch: async (_url, init) => {
        seen.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
        if (reply instanceof Error) throw reply;
        return {
          ok: reply.status >= 200 && reply.status < 300,
          status: reply.status,
          headers: { get: () => null },
          text: async () => reply.body,
        };
      },
    });
  }

  it('válido, con número de consulta y el NIF-IVA del operador como solicitante', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const result = await client(
      { status: 200, body: JSON.stringify({ valid: true, requestIdentifier: 'WAPIAAAAX1' }) },
      seen,
    ).check('IE', '6388047V');
    expect(result).toMatchObject({ status: 'valid', consultation: 'WAPIAAAAX1' });
    expect(seen[0]).toEqual({
      countryCode: 'IE',
      vatNumber: '6388047V',
      requesterMemberStateCode: 'ES',
      requesterNumber: 'B24805335',
    });
  });

  it('no válido', async () => {
    await expect(
      client({ status: 200, body: JSON.stringify({ valid: false, requestIdentifier: '' }) }).check(
        'DE',
        '12',
      ),
    ).resolves.toMatchObject({ status: 'invalid', consultation: null });
  });

  it.each([
    [
      'caída de un Estado miembro',
      {
        status: 200,
        body: JSON.stringify({
          actionSucceed: false,
          errorWrappers: [{ error: 'MS_UNAVAILABLE' }],
        }),
      },
      'MS_UNAVAILABLE',
    ],
    ['HTTP 500', { status: 500, body: '{}' }, 'HTTP 500'],
    ['respuesta que no es JSON', { status: 200, body: '<html>' }, 'no JSON'],
    ['red caída', new Error('ECONNRESET'), 'ECONNRESET'],
  ] as const)('%s → pendiente, sin lanzar', async (_name, reply, detail) => {
    const result = await client(reply as Reply).check('FR', '12345678901');
    expect(result.status).toBe('unavailable');
    expect(result.status === 'unavailable' && result.detail).toContain(detail);
  });
});

describe('régimen de IVA y desglose con el IVA incluido', () => {
  it('España, Canarias/Ceuta/Melilla, UE con y sin NIF-IVA válido, fuera de la UE', () => {
    expect(vatRegimeFor({ country: 'ES', postalCode: '11630', vatStatus: 'not_applicable' })).toBe(
      'ES_VAT',
    );
    expect(vatRegimeFor({ country: 'ES', postalCode: '35001', vatStatus: 'not_applicable' })).toBe(
      'NOT_SUBJECT_ES_SPECIAL_TERRITORY',
    );
    expect(spanishSpecialTerritory('38200')).toBe('Canarias');
    expect(spanishSpecialTerritory('51001')).toBe('Ceuta');
    expect(spanishSpecialTerritory('52001')).toBe('Melilla');
    expect(spanishSpecialTerritory('28013')).toBeNull();
    expect(vatRegimeFor({ country: 'DE', vatStatus: 'valid' })).toBe('EU_REVERSE_CHARGE');
    expect(vatRegimeFor({ country: 'DE', vatStatus: 'pending' })).toBe('ES_VAT_EU_NO_VAT_ID');
    expect(vatRegimeFor({ country: 'FR', vatStatus: 'invalid' })).toBe('ES_VAT_EU_NO_VAT_ID');
    expect(vatRegimeFor({ country: 'US', vatStatus: 'not_applicable' })).toBe(
      'NOT_SUBJECT_OUTSIDE_EU',
    );
    expect(vatRegimeFor({ country: 'GB', vatStatus: 'valid' })).toBe('NOT_SUBJECT_OUTSIDE_EU');
    expect(vatRegimeFor({ country: 'NO', vatStatus: 'not_applicable' })).toBe(
      'NOT_SUBJECT_OUTSIDE_EU',
    );
    expect(regimeMention('EU_REVERSE_CHARGE')).toMatch(/art\. 196 de la Directiva 2006\/112\/CE/);
    expect(regimeMention('NOT_SUBJECT_OUTSIDE_EU')).toMatch(/art\. 69\.Uno\.1\.º/);
    expect(regimeMention('ES_VAT')).toBeNull();
  });

  it.each([
    // El ejemplo de las condiciones: 1,50 € = 1,24 de base + 0,26 de IVA.
    [150, 124, 26],
    [500, 413, 87],
    [145, 120, 25],
    [121, 100, 21],
    [1, 1, 0],
    [2, 2, 0],
    [3, 2, 1],
    [0, 0, 0],
    [24_200_000, 20_000_000, 4_200_000],
    [-150, -124, -26],
    [-145, -120, -25],
  ])('total %i → base %i + IVA %i', (total, base, vat) => {
    expect(splitVatIncluded(total, 2100)).toEqual({ taxBase: base, vatAmount: vat });
  });

  it('base + IVA es SIEMPRE el total, y la base es la más cercana a total ÷ 1,21 (de 0 a 200.000)', () => {
    for (let total = 0; total <= 200_000; total += 1) {
      const { taxBase, vatAmount } = splitVatIncluded(total, 2100);
      expect(taxBase + vatAmount).toBe(total);
      expect(Math.abs(taxBase - total / 1.21)).toBeLessThanOrEqual(0.5 + 1e-9);
      const negative = splitVatIncluded(-total, 2100);
      expect(negative).toEqual({ taxBase: -taxBase || 0, vatAmount: -vatAmount || 0 });
    }
  });

  it('sin IVA, la base es el total', () => {
    expect(splitVatIncluded(9325, 0)).toEqual({ taxBase: 9325, vatAmount: 0 });
    expect(() => splitVatIncluded(1.5, 2100)).toThrow(RangeError);
  });
});

describe('meses en la hora de Madrid', () => {
  it('enero empieza a las 23:00 UTC del 31 de diciembre (invierno)', () => {
    const p = monthPeriod('2026-01');
    expect(p.start.toISOString()).toBe('2025-12-31T23:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-01-31T23:00:00.000Z');
    expect(p.firstDay.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(p.lastDay.toISOString().slice(0, 10)).toBe('2026-01-31');
  });

  it('los meses con cambio de hora (marzo y octubre) y febrero bisiesto', () => {
    const march = monthPeriod('2026-03');
    expect(march.start.toISOString()).toBe('2026-02-28T23:00:00.000Z');
    expect(march.end.toISOString()).toBe('2026-03-31T22:00:00.000Z');
    const october = monthPeriod('2026-10');
    expect(october.start.toISOString()).toBe('2026-09-30T22:00:00.000Z');
    expect(october.end.toISOString()).toBe('2026-10-31T23:00:00.000Z');
    expect(monthPeriod('2028-02').lastDay.toISOString().slice(0, 10)).toBe('2028-02-29');
    expect(monthPeriod('2026-12').end.toISOString()).toBe('2026-12-31T23:00:00.000Z');
  });

  it('una venta del 31 a las 23:30 de Madrid es de ese mes; el mes anterior se calcula en Madrid', () => {
    const at = new Date('2026-01-31T22:30:00Z');
    expect(madridDate(at)).toEqual({ year: 2026, month: 1, day: 31 });
    expect(at < monthPeriod('2026-01').end).toBe(true);
    expect(previousMonthKey(new Date('2026-01-01T00:30:00+01:00'))).toBe('2025-12');
    expect(previousMonthKey(new Date('2026-12-01T05:00:00Z'))).toBe('2026-11');
    expect(() => monthPeriod('2026-13')).toThrow(RangeError);
  });
});

describe('datos que propone Stripe', () => {
  it('persona física (respuesta real del sandbox): nombre, dirección y fecha de nacimiento; el NIF no se puede leer', () => {
    const prefill = identityFromStripe(
      {
        country: 'ES',
        business_type: 'individual',
        individual: {
          first_name: 'Jenny',
          last_name: 'Rosen',
          dob: { day: 1, month: 1, year: 1901 },
          address: {
            line1: 'Calle Mayor 1',
            line2: null,
            postal_code: '28013',
            city: 'Madrid',
            state: 'M',
          },
        },
        company: { name: null, address: { line1: null } },
      },
      'ES',
      'individual',
    );
    expect(prefill).toEqual({
      entityType: 'individual',
      legalName: 'Jenny Rosen',
      country: 'ES',
      address: {
        line1: 'Calle Mayor 1',
        line2: null,
        postalCode: '28013',
        city: 'Madrid',
        region: 'M',
      },
      birthDate: '1901-01-01',
    });
    expect(
      missingFields({
        ...prefill,
        taxId: null,
        vatId: null,
        legalName: prefill.legalName ?? '',
        country: 'ES',
      }),
    ).toEqual(['taxId']);
  });

  it('empresa: razón social y domicilio; sin fecha de nacimiento', () => {
    expect(
      identityFromStripe(
        {
          business_type: 'company',
          company: { name: ' Academia SL ', address: { city: 'Cádiz' } },
        },
        'ES',
        'company',
      ),
    ).toMatchObject({ entityType: 'company', legalName: 'Academia SL', birthDate: null });
  });

  it('fecha de nacimiento: real, en el pasado y de alguien mayor de edad', () => {
    const now = new Date('2026-11-12T10:00:00Z');
    expect(checkBirthDate('1990-02-28', now)).toEqual({ ok: true, value: '1990-02-28' });
    expect(checkBirthDate('1990-02-30', now)).toEqual({ ok: false, reason: 'invalid' });
    expect(checkBirthDate('2010-01-01', now)).toEqual({ ok: false, reason: 'underage' });
    expect(checkBirthDate('2008-11-12', now)).toEqual({ ok: true, value: '2008-11-12' });
    expect(checkBirthDate('2008-11-13', now)).toEqual({ ok: false, reason: 'underage' });
    expect(checkBirthDate('', now)).toEqual({ ok: false, reason: 'required' });
  });
});

describe('PDF de la factura', () => {
  it('importes con el código de la moneda (vale para cualquiera) y texto sin caracteres rotos', () => {
    expect(formatInvoiceAmount(123456, 'eur')).toBe('1.234,56 EUR');
    expect(formatInvoiceAmount(-26, 'eur')).toBe('-0,26 EUR');
    expect(formatInvoiceAmount(5000, 'jpy')).toBe('5.000 JPY');
    expect(formatInvoiceAmount(150000, 'huf')).toBe('1.500,00 HUF');
    // «ó» es de Windows-1252 y se queda; «Ł», «Ż» y «ć», no.
    expect(pdfSafe('Łukasz Żółć — 5 % €')).toBe('Lukasz Zólc — 5 % €');
    expect(pdfSafe('Ἀθῆναι 東京')).toBe('?????? ??');
  });

  it('genera un PDF de verdad, ordinario y rectificativo, y marca el modo prueba', async () => {
    const base = {
      fullNumber: 'DCT-2026-000001',
      issueDate: new Date('2026-12-01T00:00:00Z'),
      periodFirstDay: new Date('2026-11-01T00:00:00Z'),
      periodLastDay: new Date('2026-11-30T00:00:00Z'),
      currency: 'eur',
      regime: 'ES_VAT' as const,
      vatRateBps: 2100,
      total: 650,
      taxBase: 537,
      vatAmount: 113,
      issuer: {
        name: 'VA360 LABS, S.L.',
        taxId: 'B24805335',
        vatId: 'ESB24805335',
        address: {
          line1: 'C/ Juan José Sánchez Rodríguez, 24',
          postalCode: '11630',
          city: 'Arcos de la Frontera',
          region: 'Cádiz',
        },
        country: 'ES',
        email: 'hola@didacta.io',
      },
      recipient: {
        name: 'Jenny Rosen',
        taxId: '12345678Z',
        vatId: null,
        address: { line1: 'Calle Mayor 1', postalCode: '28013', city: 'Madrid' },
        country: 'ES',
        complete: true,
      },
      serviceName: 'Didacta Cloud',
      items: [
        {
          date: new Date('2026-11-03T10:00:00Z'),
          description: 'Curso A',
          saleGross: 10000,
          amount: 500,
        },
        {
          date: new Date('2026-11-04T10:00:00Z'),
          description: 'Curso B',
          saleGross: 3000,
          amount: 150,
        },
      ],
      rectifies: [],
      rectificationReason: null,
      mention: null,
      livemode: false,
    };
    const ordinary = await renderInvoicePdf({ ...base, kind: 'ORDINARY' });
    expect(ordinary.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(ordinary.length).toBeGreaterThan(1500);
    const rectifying = await renderInvoicePdf({
      ...base,
      kind: 'RECTIFYING',
      fullNumber: 'DCTR-2026-000001',
      total: -150,
      taxBase: -124,
      vatAmount: -26,
      rectifies: [{ fullNumber: 'DCT-2026-000001', issueDate: '2026-12-01' }],
      rectificationReason: 'Devolución de comisión',
      recipient: { ...base.recipient, country: 'DE', complete: false },
    });
    expect(rectifying.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
