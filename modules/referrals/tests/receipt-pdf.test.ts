import { describe, expect, it } from 'vitest';
import {
  formatReceiptAmount,
  pdfSafe,
  receiptLabel,
  renderReceiptPdf,
} from '../src/receipt-pdf.js';

describe('justificante en PDF', () => {
  it('número correlativo con cuatro cifras e importes al estilo de la factura', () => {
    expect(receiptLabel(7)).toBe('0007');
    expect(receiptLabel(12345)).toBe('12345');
    expect(formatReceiptAmount(1470, 'eur')).toBe('14,70 EUR');
    expect(formatReceiptAmount(-1470, 'eur')).toBe('-14,70 EUR');
  });

  it('translitera lo que las fuentes estándar no pintan', () => {
    expect(pdfSafe('Łukasz Pérez €')).toBe('Lukasz Pérez €');
  });

  it('genera un PDF con o sin datos del receptor', async () => {
    const base = {
      number: 1,
      paidAt: new Date('2026-11-13T10:00:00Z'),
      reference: 'TRF-0001',
      currency: 'eur',
      totalCents: 1470,
      issuerName: 'Taller de Acuarela',
      lines: [
        {
          date: new Date('2026-11-01T10:00:00Z'),
          concept: 'Comisión del 30 % sobre una venta de 49,00 EUR',
          amountCents: 1470,
        },
      ],
    };
    const conDatos = await renderReceiptPdf({
      ...base,
      payee: {
        fullName: 'Lucía Pérez',
        country: 'ES',
        taxId: '12345678Z',
        iban: 'ES9121000418450200051332',
      },
    });
    expect(conDatos.subarray(0, 5).toString()).toBe('%PDF-');
    expect(conDatos.length).toBeGreaterThan(1000);
    const sinDatos = await renderReceiptPdf({ ...base, payee: null });
    expect(sinDatos.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
