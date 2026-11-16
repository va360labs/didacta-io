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
        receivedNet: 18485,
        pending: 6985,
        held: 0,
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
        receivedNet: 0,
        pending: 0,
        held: 0,
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
        receivedNet: 9180,
        pending: 0,
        held: 0,
        debtNetted: 0,
        debtOutstanding: 0,
        refunded: 0,
        reversed: 0,
      },
    ]);
  });
});

describe('ensayo general: lo que ya no es verdad tras un reembolso o una retención', () => {
  it('reembolso total de una venta ya enviada: «Recibido» neto a 0 y sin «hacia el …»', async () => {
    // Lo del ensayo: 49 € → 44,76 € enviados; reembolso total → 44,76 € retirados.
    sale(A, {
      ...transferred(4900, 179, 245, 'eur'),
      refundedAmount: 4900,
      reversedAmount: 4476,
    });
    const page = await reports.listSales(A);
    expect(page.items[0]).toMatchObject({ refundState: 'full', estimatedArrival: null });

    const [eur] = (await reports.summary(A)).currencies;
    expect(eur).toMatchObject({ received: 4476, reversed: 4476, receivedNet: 0, refunded: 4900 });
  });

  it('reembolso parcial: la venta sigue llegando y «Recibido» resta solo lo retirado', async () => {
    sale(A, {
      ...transferred(10000, 175, 500, 'eur'),
      refundedAmount: 4000,
      reversedAmount: 3730,
    });
    const page = await reports.listSales(A);
    expect(page.items[0]).toMatchObject({
      refundState: 'partial',
      estimatedArrival: '2026-11-23',
    });
    const [eur] = (await reports.summary(A)).currencies;
    expect(eur).toMatchObject({ received: 9325, receivedNet: 5595 });
  });

  it('venta retenida (faltan los datos fiscales): va a «held», no a «en camino»', async () => {
    sale(A, {
      ...transferred(4900, 179, 245, 'eur'),
      status: 'HELD',
      lastError: 'tax_profile_incomplete: faltan los datos fiscales',
    });
    sale(A, { ...transferred(10000, 175, 500, 'eur'), status: 'READY' });
    const page = await reports.listSales(A);
    const held = page.items.find((s) => s.status === 'HELD');
    expect(held).toMatchObject({ reason: 'tax_profile_incomplete', estimatedArrival: null });
    const [eur] = (await reports.summary(A)).currencies;
    expect(eur).toMatchObject({ pending: 9325, held: 4476, received: 0, receivedNet: 0 });
  });

  it('reclamación ganada: lo devuelto vuelve a contar en «Recibido»', async () => {
    const won = sale(A, {
      ...transferred(10000, 175, 500, 'eur'),
      reversedAmount: 9325,
    });
    db.insert('modPayoutsLedgerEntry', {
      tenantId: A,
      accountId: account[A],
      saleId: won['id'],
      type: 'TRANSFER',
      amount: -9325,
      currency: 'eur',
      idempotencyKey: 'payouts:reinstate:dispute:dp_1',
      occurredAt: new Date('2026-11-20T00:00:00Z'),
    });
    const [eur] = (await reports.summary(A)).currencies;
    expect(eur).toMatchObject({ received: 9325, reversed: 9325, receivedNet: 9325 });
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

describe('comisión del operador para el plano de control (fees)', () => {
  const from = new Date('2026-11-10T00:00:00Z');
  const to = new Date('2026-11-14T00:00:00Z');

  function entry(
    tenantId: string,
    type: string,
    amount: number,
    currency: string,
    occurredAt: string,
  ) {
    return db.insert('modPayoutsLedgerEntry', {
      tenantId,
      accountId: account[tenantId],
      type,
      amount,
      currency,
      idempotencyKey: `test:${randomUUID()}`,
      occurredAt: new Date(occurredAt),
    })[0]!;
  }

  it('suma −importe de PLATFORM_FEE como cobrada y PLATFORM_FEE_REFUND como devuelta, por aula, día UTC y divisa', async () => {
    entry(A, 'PLATFORM_FEE', -500, 'eur', '2026-11-12T10:00:00Z');
    entry(A, 'PLATFORM_FEE', -150, 'eur', '2026-11-12T23:59:59Z');
    entry(A, 'PLATFORM_FEE_REFUND', 250, 'eur', '2026-11-12T12:00:00Z');
    // Otra divisa el mismo día: fila aparte, nunca se mezcla.
    entry(A, 'PLATFORM_FEE', -500, 'usd', '2026-11-12T10:00:00Z');
    // Otra aula y otro día.
    entry(B, 'PLATFORM_FEE', -300, 'gbp', '2026-11-13T00:00:00Z');

    await expect(reports.fees(from, to)).resolves.toEqual([
      { tenantId: A, day: '2026-11-12', currency: 'eur', feeCollected: 650, feeReturned: 250 },
      { tenantId: A, day: '2026-11-12', currency: 'usd', feeCollected: 500, feeReturned: 0 },
      { tenantId: B, day: '2026-11-13', currency: 'gbp', feeCollected: 300, feeReturned: 0 },
    ]);
  });

  it('un reembolso tardío cae en SU día y deja ese día solo con devolución (neto negativo)', async () => {
    entry(A, 'PLATFORM_FEE', -500, 'eur', '2026-11-10T10:00:00Z');
    entry(A, 'PLATFORM_FEE_REFUND', 500, 'eur', '2026-11-13T10:00:00Z');
    const rows = await reports.fees(from, to);
    expect(rows).toEqual([
      { tenantId: A, day: '2026-11-10', currency: 'eur', feeCollected: 500, feeReturned: 0 },
      { tenantId: A, day: '2026-11-13', currency: 'eur', feeCollected: 0, feeReturned: 500 },
    ]);
  });

  it('el día es el UTC del asiento: 23:59:59Z y 00:00:00Z caen en días distintos; `to` es exclusivo', async () => {
    entry(A, 'PLATFORM_FEE', -100, 'eur', '2026-11-11T23:59:59Z');
    entry(A, 'PLATFORM_FEE', -200, 'eur', '2026-11-12T00:00:00Z');
    entry(A, 'PLATFORM_FEE', -999, 'eur', '2026-11-14T00:00:00Z'); // == to: fuera
    entry(A, 'PLATFORM_FEE', -999, 'eur', '2026-11-09T23:59:59Z'); // antes de from: fuera
    expect(await reports.fees(from, to)).toEqual([
      { tenantId: A, day: '2026-11-11', currency: 'eur', feeCollected: 100, feeReturned: 0 },
      { tenantId: A, day: '2026-11-12', currency: 'eur', feeCollected: 200, feeReturned: 0 },
    ]);
  });

  it('solo cuentan los asientos de comisión: ventas, comisión de Stripe, transferencias y ajustes no', async () => {
    entry(A, 'SALE_GROSS', 10000, 'eur', '2026-11-12T10:00:00Z');
    entry(A, 'STRIPE_FEE', -175, 'eur', '2026-11-12T10:00:00Z');
    entry(A, 'TRANSFER', -9325, 'eur', '2026-11-12T10:00:00Z');
    entry(A, 'ADJUSTMENT', 1250, 'eur', '2026-11-12T10:00:00Z');
    expect(await reports.fees(from, to)).toEqual([]);
  });

  it('sin asientos en el rango → lista vacía, no ceros', async () => {
    expect(await reports.fees(from, to)).toEqual([]);
  });
});
