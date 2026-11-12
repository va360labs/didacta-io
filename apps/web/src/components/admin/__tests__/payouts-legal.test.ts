/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Piezas puras de las condiciones legales en la web (sin DOM, como el resto
 * del repo): la casilla del desistimiento solo deja pagar marcada y manda la
 * versión que se enseñó; los errores de campo de los datos fiscales; el
 * formulario sale de lo guardado o de lo que propone Stripe; la venta
 * retenida por datos fiscales tiene su propio texto; el mes que se factura.
 * Las pantallas enteras se miran con capturas.
 */

import { describe, expect, it } from 'vitest';
import enPagos from '@/i18n/messages/en/adminPagos.json';
import esPagos from '@/i18n/messages/es/adminPagos.json';
import enSite from '@/i18n/messages/en/publicSite.json';
import esSite from '@/i18n/messages/es/publicSite.json';
import { previousMonth } from '@/components/admin/payouts-invoices-section';
import { formFromDto } from '@/components/admin/payouts-tax-profile-card';
import { saleStatusView, taxProfileFieldErrors, type PayoutsTaxProfileDto } from '@/lib/payouts';
import { waiverAcceptance } from '@/lib/purchase-consent';

const WAIVER = {
  version: '2026-11-13',
  locale: 'es',
  statement: 'Quiero acceder al curso ahora mismo.',
  sellerLine: 'Vende: Academia Luz.',
  sellerName: 'Academia Luz',
};

describe('casilla de la renuncia al desistimiento', () => {
  it('sin marcar (o sin texto cargado) no hay con qué pagar; marcada, viaja la versión y el idioma', () => {
    expect(waiverAcceptance(null, true)).toBeNull();
    expect(waiverAcceptance(WAIVER, false)).toBeNull();
    expect(waiverAcceptance(WAIVER, true)).toEqual({
      accepted: true,
      version: '2026-11-13',
      locale: 'es',
    });
  });

  it('los textos de la interfaz existen en los dos idiomas (el legal lo da la API)', () => {
    for (const site of [esSite, enSite]) {
      expect(Object.keys(site.withdrawalWaiver).sort()).toEqual([
        'loadError',
        'loading',
        'mustTick',
        'retry',
      ]);
    }
  });
});

describe('datos fiscales', () => {
  it('el detail del 422 se reparte por campos', () => {
    expect(
      taxProfileFieldErrors('taxId:check_digit,birthDate:required,address.city:required'),
    ).toEqual({ taxId: 'check_digit', birthDate: 'required', 'address.city': 'required' });
    expect(taxProfileFieldErrors(undefined)).toEqual({});
  });

  it('cada motivo que puede mandar la API tiene su texto en los dos idiomas', () => {
    const reasons = [
      'required',
      'invalid',
      'format',
      'check_digit',
      'entity_mismatch',
      'not_eu',
      'country_mismatch',
      'underage',
    ];
    for (const pagos of [esPagos, enPagos]) {
      expect(Object.keys(pagos.payouts.tax.fieldErrors).sort()).toEqual([...reasons].sort());
    }
  });

  it('el formulario parte de lo guardado o, si no hay nada, de lo que propone Stripe; el NIF nunca se rellena', () => {
    const fromStripe: PayoutsTaxProfileDto = {
      status: 'missing',
      required: true,
      profile: null,
      prefill: {
        entityType: 'individual',
        legalName: 'Jenny Rosen',
        country: 'ES',
        address: { line1: 'Calle Mayor 1', postalCode: '28013', city: 'Madrid', region: 'M' },
        birthDate: '1901-01-01',
      },
      missing: ['taxId'],
      heldSales: 2,
    };
    expect(formFromDto(fromStripe)).toMatchObject({
      entityType: 'individual',
      legalName: 'Jenny Rosen',
      country: 'ES',
      taxId: '',
      line1: 'Calle Mayor 1',
      postalCode: '28013',
      birthDate: '1901-01-01',
    });
    const saved: PayoutsTaxProfileDto = {
      ...fromStripe,
      status: 'complete',
      prefill: null,
      profile: {
        entityType: 'company',
        legalName: 'Luz SL',
        country: 'ES',
        taxIdHint: '5335',
        vatIdHint: null,
        vatStatus: 'not_applicable',
        vatCheckedAt: null,
        address: { line1: 'Calle Sol 2', postalCode: '11630', city: 'Arcos' },
        birthDate: null,
        confirmedAt: '2026-11-12T10:00:00Z',
      },
    };
    expect(formFromDto(saved)).toMatchObject({
      entityType: 'company',
      legalName: 'Luz SL',
      taxId: '',
    });
  });
});

describe('Tus ventas y Tus facturas', () => {
  it('una venta retenida por datos fiscales lo dice en llano', () => {
    expect(saleStatusView({ status: 'HELD', reason: 'tax_profile_incomplete' })).toEqual({
      key: 'heldTaxData',
      tone: 'warning',
    });
    expect(esPagos.payouts.sales.status.heldTaxData).toBe(
      'Retenida hasta que completes tus datos fiscales',
    );
    expect(enPagos.payouts.sales.status.heldTaxData).toMatch(/tax details/);
  });

  it('el mes que se factura es el anterior (enero → diciembre del año pasado)', () => {
    expect(previousMonth(new Date(2026, 10, 12))).toBe('2026-10');
    expect(previousMonth(new Date(2027, 0, 3))).toBe('2026-12');
  });

  it('cada régimen de IVA tiene su texto', () => {
    const regimes = [
      'ES_VAT',
      'ES_VAT_EU_NO_VAT_ID',
      'EU_REVERSE_CHARGE',
      'NOT_SUBJECT_OUTSIDE_EU',
      'NOT_SUBJECT_ES_SPECIAL_TERRITORY',
    ];
    for (const pagos of [esPagos, enPagos]) {
      expect(Object.keys(pagos.payouts.invoices.regime).sort()).toEqual([...regimes].sort());
    }
  });
});
