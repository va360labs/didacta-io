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
import { invoiceEmailTexts } from '../src/modules/payouts/payouts-invoice-mailer';

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
