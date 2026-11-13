/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Filas de «Tus ventas» (sin DOM: el repo no usa React Testing Library). Lo
 * que se pinta sale tal cual de la venta de la API; aquí se fija qué columna
 * enseña qué importe y en qué moneda. La página entera se mira con capturas.
 */

import { describe, expect, it } from 'vitest';
import enPagos from '@/i18n/messages/en/adminPagos.json';
import esPagos from '@/i18n/messages/es/adminPagos.json';
import { refundExplanation, type RefundTranslator } from '@/components/admin/payouts-refund-dialog';
import {
  debtNoticeText,
  describeSale,
  type SalesTranslator,
} from '@/components/admin/payouts-sales-section';
import {
  debtReasonKey,
  formatStripeAmount,
  parseRefundAmount,
  refundAmountInput,
  type PayoutsDebtDto,
  type PayoutsRefundPreviewDto,
  type PayoutsSaleDto,
} from '@/lib/payouts';

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
  reversedAmount: 0,
  refundState: 'none',
  disputeOpen: false,
  canRefund: true,
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

/** `Intl` separa el importe y el símbolo con un espacio duro. */
const plain = (text: string | null) => (text ?? '').replace(/[\u00a0\u202f]/g, ' ');

describe('E6: reembolsos y reclamaciones en las filas', () => {
  it('reembolso parcial: estado y nota con lo devuelto', () => {
    const row = describeSale(
      sale({ refundedAmount: 4000, reversedAmount: 3730, refundState: 'partial' }),
      money,
      'es',
      t,
    );
    expect(t(`status.${row.status.key}`)).toBe('Reembolsada en parte');
    expect(plain(row.refundNote)).toBe('Devuelto al alumno: 40,00 €');
  });

  it('reembolsada entera y reclamada al banco mandan sobre el envío', () => {
    expect(
      describeSale(sale({ refundState: 'full', refundedAmount: 10000 }), money, 'es', t).status,
    ).toEqual({ key: 'refunded', tone: 'neutral' });
    expect(describeSale(sale({ disputeOpen: true }), money, 'es', t).status).toEqual({
      key: 'disputed',
      tone: 'danger',
    });
  });
});

describe('E6: reclamaciones decididas', () => {
  it('ganada con la venta compensada: lo que recibes es lo devuelto, con su nota', () => {
    const row = describeSale(
      sale({
        status: 'SETTLED_NETTED',
        transferAmount: 0,
        debtNetted: 9160,
        creatorNet: 9160,
        disputeOutcome: 'won',
        reinstatedAmount: 9160,
      }),
      money,
      'es',
      t,
    );
    expect(plain(row.youGet)).toBe('91,60 €');
    expect(row.debtNote).toBe('Te lo devolvimos al ganar la reclamación');
    expect(t(`status.${row.status.key}`)).toBe('Reclamación ganada: te lo devolvimos');
  });

  it('perdida: 0 y por qué, sin hablar de deudas', () => {
    const row = describeSale(
      sale({
        status: 'SETTLED_NETTED',
        transferAmount: 0,
        debtNetted: 9160,
        disputeOutcome: 'lost',
      }),
      money,
      'es',
      t,
    );
    expect(plain(row.youGet)).toBe('0,00 €');
    expect(row.debtNote).toBe('El banco se lo devolvió al alumno');
    expect(row.status).toEqual({ key: 'disputeLost', tone: 'danger' });
  });
});

describe('E6: explicación del reembolso', () => {
  const tr: RefundTranslator = (key, values = {}) => t(`refund.${key}`, values);
  const m = (amount: number, currency: string) => formatStripeAmount(amount, currency, 'es');
  const preview: PayoutsRefundPreviewDto = {
    saleId: 's1',
    chargeCurrency: 'eur',
    refundable: 10000,
    amount: 4000,
    currency: 'eur',
    settlementAmount: 4000,
    creatorShare: 3730,
    cardFee: 70,
    cardFeeToCreator: 70,
    platformFeeReturned: 200,
    platformFeeToCreator: 0,
    creatorTotal: 3800,
    alreadyPaidOut: true,
  };

  it('parcial de 40 € de una venta ya enviada: frases en llano con los importes de la API', () => {
    const lines = refundExplanation(preview, { refundedAmount: 0, gross: 10000 }, 'Didacta', m, tr);
    expect(lines.map((l) => plain(l.text))).toEqual([
      'El alumno recibe 40,00 € en su tarjeta. Suele verlo en 5 a 10 días.',
      'Se te descuentan 37,30 € de lo que recibiste por esta venta.',
      'Como ya te lo habíamos enviado, lo retiramos de tu saldo en Stripe. Si no hay bastante, lo descontamos de tus próximos cobros.',
      'El banco no devuelve la comisión de la tarjeta (0,70 €): la pagas tú y se descuenta de tus próximos cobros.',
      'Didacta te devuelve su parte (2,00 €).',
      'En total se te descuentan 38,00 €.',
      'Con un reembolso parcial, el alumno conserva el acceso al curso.',
    ]);
  });

  it('total de una venta aún no enviada, con la comisión a cargo del operador', () => {
    const lines = refundExplanation(
      {
        ...preview,
        amount: 10000,
        settlementAmount: 10000,
        creatorShare: 9325,
        cardFee: 175,
        cardFeeToCreator: 0,
        platformFeeReturned: 500,
        creatorTotal: 9325,
        alreadyPaidOut: false,
      },
      { refundedAmount: 0, gross: 10000 },
      'Didacta',
      m,
      tr,
    ).map((l) => plain(l.text));
    expect(lines).toContain(
      'Como aún no te lo habíamos enviado, se resta de lo que te íbamos a enviar.',
    );
    expect(lines).toContain(
      'El banco no devuelve la comisión de la tarjeta (1,75 €): la asume Didacta.',
    );
    expect(lines).toContain('Al devolverlo todo, el alumno pierde el acceso al curso.');
  });
});

describe('E6: importe escrito por el creador', () => {
  it('acepta coma o punto y no redondea en silencio', () => {
    expect(parseRefundAmount('40', 'eur')).toBe(4000);
    expect(parseRefundAmount('40,5', 'eur')).toBe(4050);
    expect(parseRefundAmount(' 40.05 ', 'eur')).toBe(4005);
    expect(parseRefundAmount('40,555', 'eur')).toBeNull();
    expect(parseRefundAmount('0', 'eur')).toBeNull();
    expect(parseRefundAmount('-3', 'eur')).toBeNull();
    expect(parseRefundAmount('abc', 'eur')).toBeNull();
    expect(parseRefundAmount('1000', 'jpy')).toBe(1000);
    expect(parseRefundAmount('10,5', 'jpy')).toBeNull();
    expect(refundAmountInput(4050, 'eur', 'es')).toBe('40,50');
    expect(refundAmountInput(4050, 'eur', 'en')).toBe('40.50');
  });

  it('motivo de deuda: los conocidos tal cual, el resto como ajuste', () => {
    expect(debtReasonKey('REFUND_FEE')).toBe('REFUND_FEE');
    expect(debtReasonKey('DISPUTE_FEE')).toBe('DISPUTE_FEE');
    expect(debtReasonKey('ALGO_NUEVO')).toBe('MANUAL');
  });
});

describe('E6: avisos', () => {
  it('«Te descontaremos {importe} de tus próximos cobros por {motivo}»', () => {
    const reason = t(`debtReasons.${debtReasonKey('REFUND_FEE')}`, { item: 'Curso de IA' });
    expect(t('noticeDebtItem', { amount: '1,75 €', reason })).toBe(
      'Te descontaremos 1,75 € de tus próximos cobros por la comisión de la tarjeta de un reembolso («Curso de IA»).',
    );
  });

  const debt = (over: Partial<PayoutsDebtDto>): PayoutsDebtDto => ({
    id: 'd1',
    reason: 'DISPUTE_FEE',
    amountOriginal: 2000,
    amountOutstanding: 2000,
    currency: 'eur',
    createdAt: '2026-11-12T10:00:00.000Z',
    saleId: 's1',
    saleDescription: 'Curso de IA',
    frozen: false,
    ...over,
  });

  it('reclamación ganada: se dice que se ganó y que la tasa del banco se descuenta, sin jerga', () => {
    const text = debtNoticeText(debt({ fromWonDispute: true }), money, t);
    expect(text).toBe(
      `Ganamos la reclamación de «Curso de IA». El banco no devuelve su tasa (${money(2000, 'eur')}) aunque ganemos: se descontará de tus próximos cobros.`,
    );
    for (const word of ['chargeback', 'fee', 'payout', 'Stripe', 'disputa']) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it('reclamación perdida y deuda congelada: el texto de siempre', () => {
    expect(debtNoticeText(debt({ fromWonDispute: false }), money, t)).toBe(
      `Te descontaremos ${money(2000, 'eur')} de tus próximos cobros por una reclamación al banco que no ganamos: la tasa del banco y la comisión de la tarjeta («Curso de IA»).`,
    );
    // Una API anterior no manda `fromWonDispute`.
    expect(
      debtNoticeText(debt({ reason: 'DISPUTE', frozen: true, amountOutstanding: 4160 }), money, t),
    ).toBe(
      `Te descontaremos ${money(4160, 'eur')} de tus próximos cobros por una reclamación al banco («Curso de IA»). Si el banco nos da la razón, esta cantidad no se te descontará.`,
    );
  });

  it('los textos nuevos existen en los dos idiomas (mismas claves)', () => {
    const keys = (node: unknown, prefix = ''): string[] =>
      node && typeof node === 'object'
        ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
            keys(v, `${prefix}${k}.`),
          )
        : [prefix.slice(0, -1)];
    const es = keys(esPagos.payouts.sales);
    const en = keys(enPagos.payouts.sales);
    expect(new Set(es)).toEqual(new Set(en));
    for (const key of [
      'refundCta',
      'refund.confirm',
      'noticeDebtItem',
      'noticeDebtDisputeWon',
      'noticeDispute',
      'debtReasons.DISPUTE_FEE',
    ]) {
      expect(es).toContain(key);
    }
  });
});
