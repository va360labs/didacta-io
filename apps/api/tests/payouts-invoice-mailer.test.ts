/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Correo de la factura de la comisión: en llano, con el desglose del IVA, el
 * periodo «del … al …», qué hacer (nada) y, si faltan los datos fiscales, que
 * se completen. Una rectificativa a favor del creador no dice «ya se
 * descontó». El envío real (SMTP global con el PDF adjunto) se mira en la
 * prueba de punta a punta.
 */

import { describe, expect, it } from 'vitest';
import { OPEN_PAYOUTS, invoiceEmailTexts } from '../src/modules/payouts/payouts-invoice-mailer';

const base = {
  kind: 'ORDINARY' as const,
  fullNumber: 'DC-2026-000007',
  periodStart: '2026-11-01',
  periodEnd: '2026-11-30',
  total: 490,
  taxBase: 405,
  vatAmount: 85,
  vatRateBps: 2100,
  currency: 'eur',
  recipientComplete: true,
  rectifies: [],
};

describe('correo de la factura de la comisión', () => {
  it('ordinaria con IVA: número, periodo, total y desglose; nada que pagar', () => {
    const es = invoiceEmailTexts({
      lang: 'es',
      operator: 'Didacta',
      serviceName: 'Didacta Cloud',
      invoice: base,
    });
    expect(es.subject).toBe('Tu factura de Didacta Cloud DC-2026-000007');
    expect(es.body).toContain(
      'del 1 de noviembre de 2026 al 30 de noviembre de 2026: 4,90 EUR (4,05 EUR + IVA del 21 %)',
    );
    expect(es.body).toContain('No tienes que pagar nada');
    expect(es.body).not.toContain('Faltan tus datos fiscales');
    const en = invoiceEmailTexts({
      lang: 'en',
      operator: 'Didacta',
      serviceName: 'Didacta Cloud',
      invoice: base,
    });
    expect(en.body).toContain(
      'from 1 November 2026 to 30 November 2026: 4,90 EUR (4,05 EUR + 21 % VAT)',
    );
  });

  it('sin IVA (inversión del sujeto pasivo) no inventa un desglose; sin datos fiscales, pide completarlos', () => {
    const texts = invoiceEmailTexts({
      lang: 'es',
      operator: 'Didacta',
      serviceName: 'Didacta Cloud',
      invoice: { ...base, vatRateBps: 0, taxBase: 490, vatAmount: 0, recipientComplete: false },
    });
    expect(texts.body).toContain(': 4,90 EUR.');
    expect(texts.body).not.toContain('IVA');
    expect(texts.body).toContain('Faltan tus datos fiscales');
  });

  it('rectificativa a favor del creador: nombra la factura que corrige y no dice «ya se descontó»', () => {
    const texts = invoiceEmailTexts({
      lang: 'es',
      operator: 'Didacta',
      serviceName: 'Didacta Cloud',
      invoice: {
        ...base,
        kind: 'RECTIFYING',
        fullNumber: 'DCR-2026-000002',
        total: -98,
        taxBase: -81,
        vatAmount: -17,
        rectifies: [{ fullNumber: 'DC-2026-000007', issueDate: '2026-12-01' }],
      },
    });
    expect(texts.subject).toBe('Factura rectificativa DCR-2026-000002 de Didacta');
    expect(texts.body).toContain('que corrige DC-2026-000007. Importe: -0,98 EUR');
    expect(texts.body).toContain('ya volvió a tus cobros');
    expect(texts.body).not.toContain('ya se descontó');
  });
});

describe('correo de la factura en portugués (pt-BR)', () => {
  it('ordinaria: fechas pt-BR, IVA desglosado, «Recebimentos → Suas faturas», sin español', () => {
    const pt = invoiceEmailTexts({
      lang: 'pt',
      operator: 'Didacta',
      serviceName: 'Didacta Cloud',
      invoice: { ...base, recipientComplete: false },
    });
    expect(pt.subject).toBe('Sua fatura de Didacta Cloud DC-2026-000007');
    expect(pt.body).toContain(
      'Segue em anexo a fatura DC-2026-000007 da nossa comissão de Didacta Cloud de 1 de novembro de 2026 a 30 de novembro de 2026: 4,90 EUR (4,05 EUR + 21 % de IVA).',
    );
    expect(pt.body).toContain('Você não precisa pagar nada');
    expect(pt.body).toContain('Recebimentos → Suas faturas');
    expect(pt.body).toContain('Faltam seus dados fiscais. Complete-os em Recebimentos');
    for (const espanol of ['Te adjuntamos', 'noviembre', 'No tienes', 'Cobros', 'IVA del']) {
      expect(`${pt.subject}\n${pt.body}`, espanol).not.toContain(espanol);
    }
    // Control: el español sigue byte a byte.
    const es = invoiceEmailTexts({
      lang: 'es',
      operator: 'Didacta',
      serviceName: 'Didacta Cloud',
      invoice: base,
    });
    expect(es.body).toBe(
      'Te adjuntamos la factura DC-2026-000007 de nuestra comisión de Didacta Cloud del 1 de noviembre de 2026 al 30 de noviembre de 2026: 4,90 EUR (4,05 EUR + IVA del 21 %).\n\nNo tienes que pagar nada: ya se descontó de las ventas que cobramos en tu nombre. También la tienes en Cobros → Tus facturas.',
    );
  });

  it('rectificativa a favor: «fatura retificadora» y que ya volvió a los recebimentos', () => {
    const pt = invoiceEmailTexts({
      lang: 'pt',
      operator: 'Didacta',
      serviceName: 'Didacta Cloud',
      invoice: {
        ...base,
        kind: 'RECTIFYING',
        fullNumber: 'DCR-2026-000002',
        total: -98,
        taxBase: -81,
        vatAmount: -17,
        rectifies: [{ fullNumber: 'DC-2026-000007', issueDate: '2026-12-01' }],
      },
    });
    expect(pt.subject).toBe('Fatura retificadora DCR-2026-000002 de Didacta');
    expect(pt.body).toContain('que corrige DC-2026-000007. Valor: -0,98 EUR');
    expect(pt.body).toContain('já voltou para os seus recebimentos');
    expect(pt.body).not.toContain('já foi descontado');
  });

  it('el enlace al panel se llama como la sección en cada idioma', () => {
    expect(OPEN_PAYOUTS).toEqual({
      es: 'Abrir Cobros',
      en: 'Open Payouts',
      pt: 'Abrir Recebimentos',
    });
  });
});
