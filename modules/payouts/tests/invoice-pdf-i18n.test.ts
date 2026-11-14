/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Idiomas de la factura de la comisión: español siempre (es el de referencia)
 * y, si el destinatario no está en España, su segunda lengua: portugués para
 * los países de lengua portuguesa, inglés para el resto. Se comprueba sobre el
 * TEXTO del PDF, así se ve también que los acentos del portugués se pintan.
 */

import { describe, expect, it } from 'vitest';
import { invoiceSecondLang, renderInvoicePdf } from '../src/invoices/invoice-pdf';
import { pdfText } from './helpers/pdf-text';

const base = {
  kind: 'ORDINARY' as const,
  fullNumber: 'DC-2026-000001',
  issueDate: new Date('2026-12-01T00:00:00Z'),
  periodFirstDay: new Date('2026-11-01T00:00:00Z'),
  periodLastDay: new Date('2026-11-30T00:00:00Z'),
  currency: 'eur',
  regime: 'NOT_SUBJECT_OUTSIDE_EU' as const,
  vatRateBps: 0,
  total: 650,
  taxBase: 650,
  vatAmount: 0,
  issuer: {
    name: 'VA360 LABS, S.L.',
    taxId: 'B24805335',
    vatId: 'ESB24805335',
    address: null,
    country: 'ES',
    email: 'hola@didacta.io',
  },
  recipient: {
    name: 'Escola da Conceição',
    taxId: '12.345.678/0001-90',
    vatId: null,
    address: { line1: 'Rua Augusta, 100', postalCode: '01305-000', city: 'São Paulo' },
    country: 'BR',
    complete: true,
  },
  serviceName: 'Didacta Cloud',
  items: [
    {
      date: new Date('2026-11-03T10:00:00Z'),
      description: 'Curso de iniciação' as string | null,
      saleGross: 10000,
      amount: 500,
    },
    {
      date: new Date('2026-11-04T10:00:00Z'),
      description: null as string | null,
      saleGross: 3000,
      amount: 150,
    },
  ],
  rectifies: [],
  rectificationReason: null,
  mention: null,
  livemode: false,
};

describe('idiomas de la factura de la comisión', () => {
  it('segunda lengua por país: ninguna en España, portugués en BR/PT, inglés en el resto', () => {
    expect(invoiceSecondLang('ES')).toBeNull();
    expect(invoiceSecondLang('BR')).toBe('pt');
    expect(invoiceSecondLang('pt')).toBe('pt');
    expect(invoiceSecondLang('AO')).toBe('pt');
    expect(invoiceSecondLang('DE')).toBe('en');
    expect(invoiceSecondLang('US')).toBe('en');
  });

  it('destinatario en Brasil: español / portugués, con sus acentos', async () => {
    const text = pdfText(await renderInvoicePdf(base));
    for (const esperado of [
      'MODO PRUEBA — SIN VALIDEZ FISCAL / MODO DE TESTE — SEM VALIDADE FISCAL',
      'Factura / Fatura',
      'Fecha de expedición / Data de emissão: 01/12/2026',
      'Periodo de las operaciones / Período das operações',
      'EMISOR / EMITENTE',
      'DESTINATARIO / DESTINATÁRIO',
      'Escola da Conceição',
      'São Paulo',
      'Brasil',
      'pela gestão do recebimento das suas vendas (impostos incluídos)',
      'Comisión / Comissão',
      'Curso de iniciação',
      'Venta / Venda',
      'Base imponible / Base de cálculo',
      'Valor já pago: foi descontado das vendas que recebemos em seu nome.',
    ]) {
      expect(text, esperado).toContain(esperado);
    }
    expect(text).not.toContain('/ Invoice');
    expect(text).not.toContain('?');
  });

  it('rectificativa a un destinatario en Brasil: «Fatura retificadora» y la devolución rotulada', async () => {
    const text = pdfText(
      await renderInvoicePdf({
        ...base,
        kind: 'RECTIFYING',
        fullNumber: 'DCR-2026-000001',
        total: -150,
        taxBase: -150,
        rectifies: [{ fullNumber: 'DC-2026-000001', issueDate: '2026-12-01' }],
        rectificationReason: 'Devolución de la comisión por reembolsos.',
        items: [
          {
            date: new Date('2026-11-04T10:00:00Z'),
            description: 'Curso B',
            commissionRefund: true,
            saleGross: 3000,
            amount: -150,
            originalInvoice: 'DC-2026-000001',
          },
        ],
      }),
    );
    expect(text).toContain('Factura rectificativa / Fatura retificadora');
    expect(text).toContain('Rectifica / Retifica: DC-2026-000001 (01/12/2026)');
    expect(text).toContain(
      'Devolución de comisión / Devolução de comissão: Curso B (factura / fatura DC-2026-000001)',
    );
    expect(text).toContain('Valor a seu favor');
  });

  it('control: destinatario en España, solo español, como siempre', async () => {
    const text = pdfText(
      await renderInvoicePdf({
        ...base,
        recipient: { ...base.recipient, name: 'Jenny Rosen', country: 'ES' },
        items: [
          { ...base.items[0]!, description: 'Curso A' },
          { ...base.items[1]!, description: null, commissionRefund: true },
        ],
      }),
    );
    expect(text).toContain('MODO PRUEBA — SIN VALIDEZ FISCAL');
    expect(text).toContain('Fecha de expedición: 01/12/2026');
    expect(text).toContain('Concepto: comisión de Didacta Cloud');
    // Lo que antes componía el servicio: «Devolución de comisión: Venta».
    expect(text).toContain('Devolución de comisión: Venta');
    for (const otro of [' / ', 'Fatura', 'Invoice', 'Comissão']) {
      expect(text, otro).not.toContain(otro);
    }
  });

  it('control: destinatario en Alemania, español / inglés, como siempre', async () => {
    const text = pdfText(
      await renderInvoicePdf({ ...base, recipient: { ...base.recipient, country: 'DE' } }),
    );
    expect(text).toContain('Factura / Invoice');
    expect(text).toContain('Base imponible / Tax base');
    expect(text).not.toContain('Fatura');
  });
});
