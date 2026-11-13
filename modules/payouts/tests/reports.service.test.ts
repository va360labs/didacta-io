/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * «Tus ventas», su resumen por divisa y el volumen del plano de control.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PayoutsReportsService, estimatePayoutDate } from '../src/index.js';
import { FakePayoutsDb } from './helpers/fake-payouts-db.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

let db: FakePayoutsDb;
let reports: PayoutsReportsService;
const account: Record<string, string> = {};

beforeEach(() => {
  db = new FakePayoutsDb();
  reports = new PayoutsReportsService(db.port());
  for (const tenantId of [A, B]) {
    account[tenantId] = randomUUID();
    db.insert('modPayoutsAccount', {
      id: account[tenantId],
      tenantId,
      stripeAccountId: `acct_${tenantId.slice(0, 4)}`,
      status: 'READY',
      country: 'ES',
      entityType: 'individual',
      payoutSchedule: {
        interval: 'weekly',
        weeklyDay: 'monday',
        monthlyDay: null,
        delayDays: 7,
        minimumBalance: null,
      },
    });
  }
});

function sale(tenantId: string, row: Record<string, unknown>) {
  return db.insert('modPayoutsSale', {
    tenantId,
    accountId: account[tenantId],
    sourceKind: 'ORDER',
    sourceRef: randomUUID(),
    stripeChargeId: `ch_${randomUUID().slice(0, 8)}`,
    presentmentAmount: 10000,
    presentmentCurrency: 'eur',
    chargedAt: new Date('2026-11-12T10:00:00Z'),
    ...row,
  })[0]!;
}

const transferred = (gross: number, fee: number, pf: number, currency: string) => ({
  status: 'TRANSFERRED',
  gross,
  stripeFee: fee,
  platformFee: pf,
  feeBpsApplied: 500,
  creatorNet: gross - fee - pf,
  transferAmount: gross - fee - pf,
  currency,
  availableOn: new Date('2026-11-19T00:00:00Z'),
});

describe('estimatePayoutDate', () => {
  const weekly = (day: string) => ({
    interval: 'weekly',
    weeklyDay: day,
    monthlyDay: null,
    delayDays: 7,
    minimumBalance: null,
  });
  it('semanal (lunes): disponible el jueves 19-nov → lunes 23-nov; disponible en lunes → ese lunes', () => {
    expect(
      estimatePayoutDate(new Date('2026-11-19T00:00:00Z'), weekly('monday'))
        ?.toISOString()
        .slice(0, 10),
    ).toBe('2026-11-23');
    expect(
      estimatePayoutDate(new Date('2026-11-23T00:00:00Z'), weekly('monday'))
        ?.toISOString()
        .slice(0, 10),
    ).toBe('2026-11-23');
  });
  it('diario, mensual (día 31 en noviembre → 30) y manual', () => {
    const d = new Date('2026-11-19T00:00:00Z');
    expect(
      estimatePayoutDate(d, { ...weekly('monday'), interval: 'daily' })
        ?.toISOString()
        .slice(0, 10),
    ).toBe('2026-11-19');
    expect(
      estimatePayoutDate(d, { ...weekly('monday'), interval: 'monthly', monthlyDay: 31 })
        ?.toISOString()
        .slice(0, 10),
    ).toBe('2026-11-30');
    expect(
      estimatePayoutDate(d, { ...weekly('monday'), interval: 'monthly', monthlyDay: 5 })
        ?.toISOString()
        .slice(0, 10),
    ).toBe('2026-12-05');
    expect(estimatePayoutDate(d, { ...weekly('monday'), interval: 'manual' })).toBeNull();
    expect(estimatePayoutDate(null, weekly('monday'))).toBeNull();
  });
});

describe('ventas y resumen', () => {
  it('listSales: solo las del tenant, más recientes primero, paginadas, con «cuándo llega»', async () => {
    sale(A, {
      ...transferred(10000, 175, 500, 'eur'),
      chargedAt: new Date('2026-11-10T10:00:00Z'),
    });
    sale(A, { chargedAt: new Date('2026-11-12T10:00:00Z') }); // AWAITING_FEE
    sale(A, {
      ...transferred(10000, 340, 500, 'eur'),
      status: 'HELD',
      lastError: 'transfer_rejected: balance_insufficient: Insufficient funds',
      chargedAt: new Date('2026-11-11T10:00:00Z'),
    });
    sale(B, transferred(10000, 320, 500, 'usd'));

    const page1 = await reports.listSales(A, { page: 1, pageSize: 2 });
    expect(page1.total).toBe(3);
    expect(page1.items.map((s) => s.status)).toEqual(['AWAITING_FEE', 'HELD']);
    expect(page1.items[0]).toMatchObject({
      currency: null,
      gross: null,
      estimatedArrival: null,
      reason: null,
    });
    // El motivo sale como código: el texto de Stripe no llega a la pantalla.
    expect(page1.items[1]!.reason).toBe('transfer_rejected');
    const page2 = await reports.listSales(A, { page: 2, pageSize: 2 });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]).toMatchObject({
      status: 'TRANSFERRED',
      transferAmount: 9325,
      estimatedArrival: '2026-11-23',
    });

    const fromB = await reports.listSales(B);
    expect(fromB.total).toBe(1);
    expect(fromB.items[0]!.currency).toBe('usd');
  });

  it('summary: una fila por divisa, nunca suma divisas, con lo recibido, lo pendiente y la deuda', async () => {
    sale(A, transferred(10000, 175, 500, 'eur'));
    sale(A, transferred(10000, 340, 500, 'eur'));
    sale(A, {
      ...transferred(10000, 175, 500, 'eur'),
      status: 'READY',
      debtNetted: 2340,
      transferAmount: 6985,
    });
    sale(A, transferred(10000, 320, 500, 'usd'));
    sale(A, {}); // AWAITING_FEE
    db.insert('modPayoutsDebt', {
      tenantId: A,
      accountId: account[A],
      reason: 'MANUAL',
      amountOriginal: 500,
      amountOutstanding: 500,
      currency: 'gbp',
    });
    sale(B, transferred(99999, 1, 1, 'eur'));

    const summary = await reports.summary(A);
    expect(summary.awaitingFeeCount).toBe(1);
    expect(summary.currencies).toEqual([
      {
        currency: 'eur',
        salesCount: 3,
        gross: 30000,
        stripeFees: 690,
        platformFees: 1500,
        received: 18485,
        pending: 6985,
        debtNetted: 2340,
        debtOutstanding: 0,
        refunded: 0,
        reversed: 0,
      },
      {
        currency: 'gbp',
        salesCount: 0,
        gross: 0,
        stripeFees: 0,
        platformFees: 0,
        received: 0,
        pending: 0,
        debtNetted: 0,
        debtOutstanding: 500,
        refunded: 0,
        reversed: 0,
      },
      {
        currency: 'usd',
        salesCount: 1,
        gross: 10000,
        stripeFees: 320,
        platformFees: 500,
        received: 9180,
        pending: 0,
        debtNetted: 0,
        debtOutstanding: 0,
        refunded: 0,
        reversed: 0,
      },
    ]);
  });
});

describe('volumen para el plano de control', () => {
  it('agrega por aula, día UTC del cobro y divisa; excluye lo que aún no tiene reparto y lo de fuera del rango', async () => {
    sale(A, {
      ...transferred(10000, 175, 500, 'eur'),
      chargedAt: new Date('2026-11-12T23:30:00Z'),
    });
    sale(A, { ...transferred(3000, 70, 150, 'eur'), chargedAt: new Date('2026-11-12T01:00:00Z') });
    sale(A, {
      ...transferred(10000, 320, 500, 'usd'),
      chargedAt: new Date('2026-11-12T08:00:00Z'),
    });
    sale(A, { chargedAt: new Date('2026-11-12T09:00:00Z') }); // sin reparto aún
    sale(B, {
      ...transferred(10000, 170, 500, 'gbp'),
      chargedAt: new Date('2026-11-13T00:00:00Z'),
    });
    sale(B, {
      ...transferred(10000, 170, 500, 'gbp'),
      chargedAt: new Date('2026-11-14T00:00:00Z'),
    }); // fuera
    db.insert('modPayoutsRefund', {
      tenantId: A,
      saleId: randomUUID(),
      amount: 4000,
      currency: 'eur',
      status: 'succeeded',
      createdAt: new Date('2026-11-12T12:00:00Z'),
    });

    const rows = await reports.volume(
      new Date('2026-11-12T00:00:00Z'),
      new Date('2026-11-14T00:00:00Z'),
    );
    expect(rows).toEqual([
      {
        tenantId: A,
        day: '2026-11-12',
        currency: 'eur',
        gmv: 13000,
        stripeFees: 245,
        platformFees: 650,
        refunds: 4000,
        disputes: 0,
        salesCount: 2,
      },
      {
        tenantId: A,
        day: '2026-11-12',
        currency: 'usd',
        gmv: 10000,
        stripeFees: 320,
        platformFees: 500,
        refunds: 0,
        disputes: 0,
        salesCount: 1,
      },
      {
        tenantId: B,
        day: '2026-11-13',
        currency: 'gbp',
        gmv: 10000,
        stripeFees: 170,
        platformFees: 500,
        refunds: 0,
        disputes: 0,
        salesCount: 1,
      },
    ]);
  });
});
