/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Filas de «Tus ventas» (sin DOM: el repo no usa React Testing Library). Lo
 * que se pinta sale tal cual de la venta de la API; aquí se fija qué columna
 * enseña qué importe y en qué moneda. La página entera se mira con capturas.
 */

import { describe, expect, it } from 'vitest';
import esPagos from '@/i18n/messages/es/adminPagos.json';
import { describeSale, type SalesTranslator } from '@/components/admin/payouts-sales-section';
import { formatStripeAmount, type PayoutsSaleDto } from '@/lib/payouts';

const texts = esPagos.payouts.sales as unknown as Record<string, unknown>;
const t: SalesTranslator = (key, values = {}) => {
  const template = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], texts) as string;
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => String(values[name]));
};
const money = (amount: number | null, currency: string | null) =>
  amount === null || !currency ? null : formatStripeAmount(amount, currency, 'es');

const sale = (over: Partial<PayoutsSaleDto>): PayoutsSaleDto => ({
  id: 's1',
  chargedAt: '2026-11-12T10:00:00.000Z',
  description: 'Curso de IA',
  sourceKind: 'ORDER',
  status: 'TRANSFERRED',
  reason: null,
  presentmentAmount: 10000,
  presentmentCurrency: 'eur',
  currency: 'eur',
  gross: 10000,
  stripeFee: 175,
  feeBpsApplied: 500,
  platformFee: 500,
  creatorNet: 9325,
  debtNetted: 0,
  transferAmount: 9325,
  refundedAmount: 0,
  transferredAt: '2026-11-12T10:01:00.000Z',
  availableOn: '2026-11-19T00:00:00.000Z',
  estimatedArrival: '2026-11-23',
  ...over,
});

describe('describeSale', () => {
  it('venta de 100 € con tarjeta española: 1,75 € de tarjeta, 5,00 € del operador, 93,25 € para ti', () => {
    const row = describeSale(sale({}), money, 'es', t);
    expect(row).toMatchObject({
      item: 'Curso de IA',
      paid: '100,00 €',
      studentPaid: null,
      cardFee: '1,75 €',
      operatorFee: '5,00 €',
      youGet: '93,25 €',
      debtNote: null,
      status: { key: 'sent', tone: 'success' },
    });
    expect(row.arrives).toMatch(/^hacia el 23 nov/);
  });

  it('alumno de México con Adaptive Pricing: cobras en euros y se ve lo que pagó él en pesos', () => {
    const row = describeSale(
      sale({
        presentmentAmount: 214977,
        presentmentCurrency: 'mxn',
        stripeFee: 340,
        creatorNet: 9160,
        transferAmount: 9160,
      }),
      money,
      'es',
      t,
    );
    expect(row.paid).toBe('100,00 €');
    expect(row.studentPaid).toBe('El alumno pagó 2149,77 MXN');
    expect(row.youGet).toBe('91,60 €');
  });

  it('recién cobrada: se enseña lo que pagó el alumno y lo demás «Pendiente»', () => {
    const row = describeSale(
      sale({
        status: 'AWAITING_FEE',
        currency: null,
        gross: null,
        stripeFee: null,
        platformFee: null,
        creatorNet: null,
        transferAmount: null,
        estimatedArrival: null,
      }),
      money,
      'es',
      t,
    );
    expect(row).toMatchObject({
      paid: '100,00 €',
      cardFee: 'Pendiente',
      operatorFee: 'Pendiente',
      youGet: 'Pendiente',
      arrives: 'En cuanto se confirme el pago',
      status: { key: 'calculating' },
    });
  });

  it('con deuda: lo que recibes es lo transferido y se explica lo descontado', () => {
    const row = describeSale(sale({ debtNetted: 2340, transferAmount: 6985 }), money, 'es', t);
    expect(row.youGet).toBe('69,85 €');
    expect(row.debtNote).toBe('23,40 € para saldar lo que debías');
  });

  it('retenida por la cuenta: sin fecha de llegada', () => {
    const row = describeSale(
      sale({ status: 'HELD', reason: 'account_not_ready', transferredAt: null }),
      money,
      'es',
      t,
    );
    expect(row.arrives).toBe('—');
    expect(t(`status.${row.status.key}`)).toBe('Retenida hasta que completes tus datos de cobro');
  });

  it('en francos suizos y en forintos, cada una en su moneda', () => {
    expect(
      describeSale(
        sale({
          currency: 'chf',
          presentmentCurrency: 'chf',
          stripeFee: 320,
          creatorNet: 9180,
          transferAmount: 9180,
        }),
        money,
        'es',
        t,
      ).youGet,
    ).toBe('91,80 CHF');
    expect(
      describeSale(
        sale({
          currency: 'huf',
          presentmentCurrency: 'huf',
          presentmentAmount: 3990000,
          gross: 3990000,
          stripeFee: 68350,
          platformFee: 199500,
          creatorNet: 3722150,
          transferAmount: 3722150,
        }),
        money,
        'es',
        t,
      ).youGet,
    ).toBe('37.221,50 HUF');
  });
});
