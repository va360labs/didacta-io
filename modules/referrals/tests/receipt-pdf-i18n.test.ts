/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Idiomas del justificante de un cobro de referidos: español siempre (es el
 * que ve el aula que paga) y, como segunda lengua, el portugués si quien cobra
 * tiene el perfil en portugués; si no, la regla de siempre (fuera de España,
 * inglés). Se comprueba sobre el TEXTO del PDF, así se ve también que los
 * acentos del portugués se pintan con Helvetica.
 */

import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  receiptSecondLang,
  renderReceiptPdf,
  toReceiptLang,
  type ReceiptPdfInput,
} from '../src/receipt-pdf.js';

/** Texto de los streams del PDF (pdfkit, fuentes estándar en Windows-1252). */
function pdfText(pdf: Buffer): string {
  const decoder = new TextDecoder('windows-1252');
  const lines: string[] = [];
  for (const m of pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content = Buffer.from(m[1]!, 'latin1');
    try {
      content = inflateSync(content);
    } catch {
      // Stream sin comprimir: se lee tal cual.
    }
    for (const tj of content.toString('latin1').matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      const hex = [...tj[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1]).join('');
      lines.push(decoder.decode(Buffer.from(hex, 'hex')));
    }
  }
  return lines.join(' ').replace(/\s+/g, ' ');
}

const base: ReceiptPdfInput = {
  number: 3,
  paidAt: new Date('2026-11-13T10:00:00Z'),
  reference: 'TRF-0003',
  currency: 'eur',
  totalCents: 1470,
  issuerName: 'Escola Luz',
  payee: {
    fullName: 'João Conceição',
    country: 'BR',
    taxId: '123.456.789-09',
    iban: 'PT50000201231234567890154',
  },
  lines: [
    {
      date: new Date('2026-11-01T10:00:00Z'),
      concept: 'Comisión del 30 % sobre 49,00 EUR / Comissão de 30 % sobre 49,00 EUR',
      amountCents: 1470,
    },
  ],
};

describe('idiomas del justificante de referidos', () => {
  it('segunda lengua: portugués si el perfil es pt; si no, inglés fuera de España', () => {
    expect(receiptSecondLang('pt', 'ES')).toBe('pt');
    expect(receiptSecondLang('pt', 'BR')).toBe('pt');
    expect(receiptSecondLang('pt', null)).toBe('pt');
    // La regla de siempre para el resto, sin cambiar ni un caso.
    expect(receiptSecondLang('es', 'ES')).toBeNull();
    expect(receiptSecondLang('en', 'ES')).toBeNull();
    expect(receiptSecondLang('es', 'BR')).toBe('en');
    expect(receiptSecondLang(undefined, 'FR')).toBe('en');
    expect(receiptSecondLang(undefined, null)).toBeNull();
    expect(toReceiptLang('pt-BR')).toBe('pt');
    expect(toReceiptLang('en-GB')).toBe('en');
    expect(toReceiptLang('fr-FR')).toBe('es');
    expect(toReceiptLang(null)).toBe('es');
  });

  it('quien cobra en portugués: español / portugués, con sus acentos', async () => {
    const text = pdfText(await renderReceiptPdf({ ...base, payeeLang: 'pt' }));
    for (const esperado of [
      'Justificante de pago / Comprovante de pagamento',
      'Comisiones por referidos / Comissões por indicações',
      'Fecha de pago / Data do pagamento: 13/11/2026',
      'Referencia / Referência: TRF-0003',
      'Paga (emisor) / Paga (emitente)',
      'Recibe / Recebe',
      'João Conceição',
      'Concepto / Descrição',
      'Comissão de 30 % sobre 49,00 EUR',
      'Total pagado / Total pago',
      'pelo programa de indicações da sua escola. A Didacta não intervém no pagamento',
    ]) {
      expect(text, esperado).toContain(esperado);
    }
    expect(text).not.toContain('Payment receipt');
    expect(text).not.toContain('?');
  });

  it('sin datos de cobro, el rótulo también va en portugués', async () => {
    const text = pdfText(await renderReceiptPdf({ ...base, payee: null, payeeLang: 'pt' }));
    expect(text).toContain('Sin datos de cobro / Sem dados para recebimento');
  });

  it('control: sin idioma (o en español) sale como siempre', async () => {
    const espana = pdfText(
      await renderReceiptPdf({
        ...base,
        payee: { ...base.payee!, country: 'ES' },
        lines: [{ ...base.lines[0]!, concept: 'Comisión del 30 % sobre una venta de 49,00 EUR' }],
      }),
    );
    expect(espana).toContain('Justificante de pago');
    expect(espana).not.toContain(' / ');
    const fuera = pdfText(await renderReceiptPdf({ ...base, payeeLang: 'es' }));
    expect(fuera).toContain('Justificante de pago / Payment receipt');
    expect(fuera).not.toContain('Comprovante');
  });
});
