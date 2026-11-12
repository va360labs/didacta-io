/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Caminos de vuelta del dinero (E6) de punta a punta con el doble de Stripe y
 * la base en memoria: reembolsos (desde Didacta y a mano en Stripe),
 * disputas (retirada, perdida, ganada), deudas (compensación, recobro,
 * avisos) y desconexión. Importes EXACTOS del plan y del sandbox. Después de
 * cada escenario se comprueban las dos invariantes del conciliador: libro =
 * pendiente de transferir, y asientos de deuda = deuda abierta.
 *
 * La concurrencia y la RLS de verdad (como `didacta_app`) están en
 * `apps/api/tests/integration/payouts-losses.integration.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LOSS_POLICY,
  InMemoryPlatformStripeClient,
  PayoutsDebtsService,
  PayoutsDisputesService,
  PayoutsOffboardingService,
  PayoutsReconcilerService,
  PayoutsRefundsService,
  PayoutsReportsService,
  PayoutsSaleNotFoundError,
  PayoutsSaleNotRefundableError,
  PayoutsRefundExceedsRemainingError,
  PayoutsSettingsService,
  SettlementService,
  handleDisputeEvent,
  handleRefundEvent,
  type PayoutsLossPolicy,
  type PayoutsNotifier,
} from '../src/index.js';
import { FakePayoutsDb } from './helpers/fake-payouts-db.js';
import { installLosses, seedDispute, type FakeLossesWorld } from './helpers/losses-world.js';
import { installTransfers, seedCharge, type FakeTransfers } from './helpers/stripe-world.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ACCT_A = 'acct_1CreadorA';
const ACCT_B = 'acct_1CreadorB';
const START = Date.parse('2026-11-12T10:00:00Z');

let db: FakePayoutsDb;
let fake: InMemoryPlatformStripeClient;
let transfers: FakeTransfers;
let world: FakeLossesWorld;
let clock: number;
let settlement: SettlementService;
let refunds: PayoutsRefundsService;
let disputes: PayoutsDisputesService;
let debts: PayoutsDebtsService;
let alerts: Array<Record<string, unknown>>;
let notices: Array<{ kind: string; [key: string]: unknown }>;
let accountA: string;
let accountB: string;

function build(policy: PayoutsLossPolicy = DEFAULT_LOSS_POLICY): void {
  const port = db.port();
  const logger = {
    warn: () => undefined,
    log: () => undefined,
    error: (obj: Record<string, unknown>) => alerts.push(obj),
  };
  const notifier: PayoutsNotifier = {
    disputeOpened: async (input) => void notices.push({ kind: 'disputeOpened', ...input }),
    debtCharged: async (input) => void notices.push({ kind: 'debtCharged', ...input }),
    operatorAlert: async (alert, detail) =>
      void notices.push({ kind: 'operator', alert, ...detail }),
  };
  const now = () => new Date(clock);
  settlement = new SettlementService(port, fake, new PayoutsSettingsService(port, 500), {
    now,
    logger,
  });
  const onSaleChanged = (tenantId: string, saleId: string) =>
    settlement.settleSale(tenantId, saleId, { force: true });
  refunds = new PayoutsRefundsService(port, fake, { policy, notifier, logger, now, onSaleChanged });
  disputes = new PayoutsDisputesService(port, fake, {
    policy,
    notifier,
    logger,
    now,
    onSaleChanged,
  });
  debts = new PayoutsDebtsService(port, fake, {
    notifier,
    logger,
    now,
    alertThresholdMinor: 10_000,
  });
}

beforeEach(() => {
  clock = START;
  alerts = [];
  notices = [];
  db = new FakePayoutsDb();
  db.clock = () => new Date(clock);
  fake = new InMemoryPlatformStripeClient({ livemode: false });
  transfers = installTransfers(fake, { now: () => Math.floor(clock / 1000) });
  world = installLosses(fake);
  accountA = randomUUID();
  accountB = randomUUID();
  db.insert(
    'modPayoutsAccount',
    {
      id: accountA,
      tenantId: A,
      stripeAccountId: ACCT_A,
      status: 'READY',
      country: 'ES',
      entityType: 'individual',
    },
    {
      id: accountB,
      tenantId: B,
      stripeAccountId: ACCT_B,
      status: 'READY',
      country: 'ES',
      entityType: 'individual',
    },
  );
  build();
});

let seq = 0;
/** Venta cobrada con su `balance_transaction`, aún sin liquidar. */
function newSale(input: {
  tenantId?: string;
  gross?: number;
  fee?: number;
  currency?: string;
  description?: string;
}) {
  const tenantId = input.tenantId ?? A;
  const gross = input.gross ?? 10000;
  const currency = input.currency ?? 'eur';
  const chargeId = `ch_3E6x${++seq}x${Math.floor(clock / 1000)}`;
  seedCharge(fake, {
    chargeId,
    onBehalfOf: tenantId === A ? ACCT_A : ACCT_B,
    amount: gross,
    currency,
    bt: { amount: gross, fee: input.fee ?? 175, currency },
  });
  const [sale] = db.insert('modPayoutsSale', {
    tenantId,
    accountId: tenantId === A ? accountA : accountB,
    sourceKind: 'ORDER',
    sourceRef: randomUUID(),
    description: input.description ?? 'Curso de prueba',
    stripeChargeId: chargeId,
    presentmentAmount: gross,
    presentmentCurrency: currency,
    status: 'AWAITING_FEE',
    chargedAt: new Date(clock),
  });
  return { saleId: sale!['id'] as string, chargeId, tenantId };
}

/** Venta cobrada y TRANSFERIDA al creador. */
async function transferredSale(input: Parameters<typeof newSale>[0] = {}) {
  const sale = newSale(input);
  const result = await settlement.settleSale(sale.tenantId, sale.saleId, { force: true });
  expect(result.outcome).toBe('transferred');
  return sale;
}

const sale = (id: string) => db.rows('modPayoutsSale', { id })[0]!;
const debtRows = (where: Record<string, unknown> = {}) => db.rows('modPayoutsDebt', where);
const refundRows = (saleId: string) => db.rows('modPayoutsRefund', { saleId });

/** Asientos de la venta que NO son del reparto (los del grupo de pérdidas). */
function lossEntries(saleId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of db.rows('modPayoutsLedgerEntry', { saleId })) {
    const key = e['idempotencyKey'] as string;
    if (key.startsWith('payouts:sale:') || key.startsWith('payouts:transfer:')) continue;
    if (/^payouts:debt-recovery:[^:]+:sale:/.test(key)) continue;
    const type = e['type'] as string;
    out[type] = (out[type] ?? 0) + (e['amount'] as number);
  }
  return out;
}

async function invariantViolations() {
  const reconciler = new PayoutsReconcilerService({
    db: db.port(),
    stripe: fake,
    settlement,
    replayEvent: async () => ({ outcome: 'processed' }),
  });
  return (await reconciler.checkInvariants(null)).violations;
}

function ledgerTotal(currency = 'eur'): number {
  return db
    .rows('modPayoutsLedgerEntry', { currency })
    .reduce((total, e) => total + (e['amount'] as number), 0);
}

// ────────────────────────────────────────────────────────────────────────────

describe('Reembolso desde Didacta', () => {
  it('total de 10000 con comisión 175: reembolso 10000, reversión 9325, comisión devuelta 500 y deuda REFUND_FEE 175', async () => {
    const s = await transferredSale({});
    const result = await refunds.refund({ tenantId: A, saleId: s.saleId, initiatedBy: 'user-1' });

    expect(result.status).toBe('succeeded');
    expect(result.accounting).toBe('accounted');
    expect(world.refunds).toHaveLength(1);
    expect(world.refunds[0]!['amount']).toBe(10000);
    expect(world.reversals.map((r) => r['amount'])).toEqual([9325]);
    expect(lossEntries(s.saleId)).toEqual({
      REFUND: -10000,
      PLATFORM_FEE_REFUND: 500,
      TRANSFER_REVERSAL: 9325,
      DEBT_CREATED: 175,
    });
    expect(debtRows()).toEqual([
      expect.objectContaining({
        reason: 'REFUND_FEE',
        amountOriginal: 175,
        amountOutstanding: 175,
        currency: 'eur',
        status: 'OPEN',
        originSaleId: s.saleId,
      }),
    ]);
    expect(sale(s.saleId)).toMatchObject({
      status: 'TRANSFERRED',
      refundedAmount: 10000,
      reversedAmount: 9325,
    });
    expect(refundRows(s.saleId)[0]).toMatchObject({ reversalStatus: 'DONE', reversalTarget: 9325 });
    expect(fake.get(sale(s.saleId)['stripeTransferId'] as string)!['amount_reversed']).toBe(9325);
    expect(notices).toContainEqual(
      expect.objectContaining({
        kind: 'debtCharged',
        amount: 175,
        currency: 'eur',
        cause: 'refund',
      }),
    );
    expect(await invariantViolations()).toEqual([]);
    expect(ledgerTotal()).toBe(0);
  });

  it('parcial de 4000: reversión 3730, comisión devuelta 200 y deuda 70', async () => {
    const s = await transferredSale({});
    await refunds.refund({ tenantId: A, saleId: s.saleId, amount: 4000, initiatedBy: 'u' });
    expect(world.reversals.map((r) => r['amount'])).toEqual([3730]);
    expect(lossEntries(s.saleId)).toEqual({
      REFUND: -4000,
      PLATFORM_FEE_REFUND: 200,
      TRANSFER_REVERSAL: 3730,
      DEBT_CREATED: 70,
    });
    expect(sale(s.saleId)).toMatchObject({ refundedAmount: 4000, reversedAmount: 3730 });
    expect(await invariantViolations()).toEqual([]);
  });

  it('dos parciales no superan el total y suman EXACTAMENTE la venta', async () => {
    const s = await transferredSale({});
    await refunds.refund({ tenantId: A, saleId: s.saleId, amount: 4000, initiatedBy: 'u' });
    await expect(
      refunds.refund({ tenantId: A, saleId: s.saleId, amount: 7000, initiatedBy: 'u' }),
    ).rejects.toBeInstanceOf(PayoutsRefundExceedsRemainingError);
    await refunds.refund({ tenantId: A, saleId: s.saleId, amount: 6000, initiatedBy: 'u' });
    await expect(
      refunds.refund({ tenantId: A, saleId: s.saleId, amount: 1, initiatedBy: 'u' }),
    ).rejects.toMatchObject({ reason: 'fully_refunded' });

    expect(world.refunds.map((r) => r['amount'])).toEqual([4000, 6000]);
    expect(world.reversals.map((r) => r['amount'])).toEqual([3730, 5595]);
    expect(lossEntries(s.saleId)).toEqual({
      REFUND: -10000,
      PLATFORM_FEE_REFUND: 500,
      TRANSFER_REVERSAL: 9325,
      DEBT_CREATED: 175,
    });
    expect(debtRows().map((d) => d['amountOriginal'])).toEqual([70, 105]);
    expect(await invariantViolations()).toEqual([]);
  });

  it('reversión con el saldo del creador a cero: deuda REVERSAL_FAILED de 9160 (y 340 de comisión)', async () => {
    const s = await transferredSale({ fee: 340 }); // tarjeta US: 10000 − 340 − 500 = 9160
    world.setBalance(ACCT_A, 'eur', 0);
    const result = await refunds.refund({ tenantId: A, saleId: s.saleId, initiatedBy: 'u' });

    expect(result.accounting).toBe('accounted');
    expect(world.reversals).toHaveLength(0);
    const byReason = Object.fromEntries(
      debtRows().map((d) => [d['reason'], d['amountOutstanding']]),
    );
    expect(byReason).toEqual({ REVERSAL_FAILED: 9160, REFUND_FEE: 340 });
    expect(refundRows(s.saleId)[0]).toMatchObject({ reversalStatus: 'FAILED_TO_DEBT' });
    expect(lossEntries(s.saleId)).toEqual({
      REFUND: -10000,
      PLATFORM_FEE_REFUND: 500,
      DEBT_CREATED: 9500,
    });
    expect(alerts.map((a) => a['alert'])).toContain('payouts.reversal_shortfall');
    expect(await invariantViolations()).toEqual([]);

    // Al día siguiente el creador tiene saldo: el recobro revierte lo que se
    // le transfirió (9160, todo lo que hay); la comisión, 340, sigue abierta.
    world.setBalance(ACCT_A, 'eur', 20000);
    const recovery = await debts.recoverOpenDebts();
    expect(recovery.recovered).toEqual([{ currency: 'eur', amount: 9160 }]);
    expect(world.reversals.reduce((t, r) => t + (r['amount'] as number), 0)).toBe(9160);
    expect(sale(s.saleId)['reversedAmount']).toBe(9160);
    const stillOpen = debtRows({ status: 'OPEN' });
    expect(stillOpen.reduce((t, d) => t + (d['amountOutstanding'] as number), 0)).toBe(340);
    expect(await invariantViolations()).toEqual([]);
    // Reintentar no revierte dos veces.
    expect((await debts.recoverOpenDebts()).recovered).toEqual([]);

    // La siguiente venta en euros salda lo que queda.
    const next = await transferredSale({});
    expect(sale(next.saleId)).toMatchObject({ debtNetted: 340, transferAmount: 9325 - 340 });
    expect(debtRows().every((d) => d['status'] === 'RECOVERED')).toBe(true);
    expect(await invariantViolations()).toEqual([]);
    expect(ledgerTotal()).toBe(0);
  });

  it('saldo parcial: revierte lo que hay (5000) y el resto es deuda', async () => {
    const s = await transferredSale({ fee: 340 });
    world.setBalance(ACCT_A, 'eur', 5000);
    await refunds.refund({ tenantId: A, saleId: s.saleId, initiatedBy: 'u' });
    expect(world.reversals.map((r) => r['amount'])).toEqual([5000]);
    expect(refundRows(s.saleId)[0]).toMatchObject({ reversalStatus: 'PARTIAL' });
    const byReason = Object.fromEntries(
      debtRows().map((d) => [d['reason'], d['amountOutstanding']]),
    );
    expect(byReason).toEqual({ REVERSAL_FAILED: 4160, REFUND_FEE: 340 });
    expect(await invariantViolations()).toEqual([]);
  });

  it('venta de otro tenant → 404 y Stripe ni se entera', async () => {
    const s = await transferredSale({});
    const before = fake.calls.length;
    await expect(
      refunds.refund({ tenantId: B, saleId: s.saleId, initiatedBy: 'admin-b' }),
    ).rejects.toBeInstanceOf(PayoutsSaleNotFoundError);
    await expect(refunds.preview(B, s.saleId)).rejects.toBeInstanceOf(PayoutsSaleNotFoundError);
    expect(fake.calls.length).toBe(before);
    expect(db.rows('modPayoutsRefund')).toHaveLength(0);
  });

  it('doble clic (mismo requestId, a la vez) → un solo reembolso', async () => {
    const s = await transferredSale({});
    const requestId = randomUUID();
    const [one, two] = await Promise.all([
      refunds.refund({ tenantId: A, saleId: s.saleId, amount: 4000, requestId, initiatedBy: 'u' }),
      refunds.refund({ tenantId: A, saleId: s.saleId, amount: 4000, requestId, initiatedBy: 'u' }),
    ]);
    expect(one.refundId).toBe(requestId);
    expect(two.refundId).toBe(requestId);
    expect(fake.callsTo('POST', '/v1/refunds')).toHaveLength(1);
    expect(world.refunds).toHaveLength(1);
    expect(refundRows(s.saleId)).toHaveLength(1);
    expect(world.reversals).toHaveLength(1);
    expect(await invariantViolations()).toEqual([]);
  });

  it('dos «reembolsar todo» a la vez sin requestId → uno solo pasa', async () => {
    const s = await transferredSale({});
    const results = await Promise.allSettled([
      refunds.refund({ tenantId: A, saleId: s.saleId, initiatedBy: 'u' }),
      refunds.refund({ tenantId: A, saleId: s.saleId, initiatedBy: 'u' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(PayoutsSaleNotRefundableError);
    expect(world.refunds).toHaveLength(1);
  });

  it('previsualización: qué recibe el alumno y qué se descuenta al creador', async () => {
    const s = await transferredSale({});
    expect(await refunds.preview(A, s.saleId, 4000)).toMatchObject({
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
    });
    expect(fake.callsTo('POST', /\/v1\/(refunds|transfers)/)).toHaveLength(1); // solo la transferencia de la venta
  });

  it('una venta aún sin comisión asentada no se reembolsa desde el panel', async () => {
    const s = newSale({});
    await expect(
      refunds.refund({ tenantId: A, saleId: s.saleId, initiatedBy: 'u' }),
    ).rejects.toMatchObject({ reason: 'not_settled' });
  });

  it('política: el operador asume la comisión de la tarjeta y no devuelve su 5 %', async () => {
    build({
      refundPlatformFee: false,
      refundCardFeeBearer: 'platform',
      disputeLossBearer: 'creator',
    });
    const s = await transferredSale({});
    await refunds.refund({ tenantId: A, saleId: s.saleId, initiatedBy: 'u' });
    expect(lossEntries(s.saleId)).toEqual({
      REFUND: -10000,
      ADJUSTMENT: 175,
      TRANSFER_REVERSAL: 9325,
      DEBT_CREATED: 500,
    });
    expect(debtRows()[0]).toMatchObject({ reason: 'REFUND_FEE', amountOutstanding: 500 });
    expect(await invariantViolations()).toEqual([]);
  });
});

describe('Reembolso hecho a mano en el panel de Stripe', () => {
  it('charge.refunded lo detecta: fila, reversión y asientos (y la reentrega no duplica)', async () => {
    const s = await transferredSale({});
    // Alguien reembolsa 2500 desde el panel de Stripe (sin metadata nuestra).
    await fake.v1('POST', '/v1/refunds', { charge: s.chargeId, amount: 2500 });

    for (let i = 0; i < 3; i += 1) {
      const result = await handleRefundEvent(
        { refunds },
        { tenantId: A, eventType: 'charge.refunded', object: { id: s.chargeId } },
      );
      expect(result.outcome).toBe('synced');
    }
    const rows = refundRows(s.saleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      initiatedBy: 'stripe_dashboard',
      amount: 2500,
      status: 'succeeded',
    });
    expect(world.reversals.map((r) => r['amount'])).toEqual([2331]); // round(9325 × 0,25)
    expect(lossEntries(s.saleId)).toMatchObject({ REFUND: -2500, TRANSFER_REVERSAL: 2331 });
    expect(await invariantViolations()).toEqual([]);
  });

  it('refund.created de un cargo de otra academia no toca nada', async () => {
    const s = await transferredSale({});
    const result = await handleRefundEvent(
      { refunds },
      { tenantId: B, eventType: 'refund.created', object: { id: 're_x', charge: s.chargeId } },
    );
    expect(result.outcome).toBe('no_sale');
    expect(db.rows('modPayoutsRefund')).toHaveLength(0);
  });
});

describe('Reembolso de una venta aún sin transferir', () => {
  it('parcial: no hay reversión; sale de su transferencia pendiente', async () => {
    db.rows('modPayoutsAccount', { id: accountA });
    // Cuenta restringida: la venta sella su reparto y queda retenida.
    db.tables['modPayoutsAccount']!.find((a) => a['id'] === accountA)!['status'] = 'RESTRICTED';
    const s = newSale({});
    expect((await settlement.settleSale(A, s.saleId, { force: true })).outcome).toBe('held');
    expect(sale(s.saleId)).toMatchObject({ status: 'HELD', transferAmount: 9325 });

    clock += 60_000;
    await refunds.refund({ tenantId: A, saleId: s.saleId, amount: 4000, initiatedBy: 'u' });
    expect(world.reversals).toHaveLength(0);
    expect(sale(s.saleId)).toMatchObject({
      status: 'HELD',
      transferAmount: 9325 - 3730 - 70,
      debtNetted: 3800,
      refundedAmount: 4000,
    });
    expect(debtRows().every((d) => d['status'] === 'RECOVERED')).toBe(true);
    expect(await invariantViolations()).toEqual([]);

    // La cuenta vuelve a estar lista: se transfiere lo que queda, ni un céntimo más.
    db.tables['modPayoutsAccount']!.find((a) => a['id'] === accountA)!['status'] = 'READY';
    clock += 25 * 3_600_000;
    expect((await settlement.settleSale(A, s.saleId)).outcome).toBe('transferred');
    expect(transfers.all.map((t) => t['amount'])).toEqual([5525]);
    expect(await invariantViolations()).toEqual([]);
    expect(ledgerTotal()).toBe(0);
  });

  it('total: la venta queda saldada sin transferencia y solo queda la deuda de 175', async () => {
    db.tables['modPayoutsAccount']!.find((a) => a['id'] === accountA)!['status'] = 'RESTRICTED';
    const s = newSale({});
    await settlement.settleSale(A, s.saleId, { force: true });
    clock += 60_000;
    await refunds.refund({ tenantId: A, saleId: s.saleId, initiatedBy: 'u' });
    expect(sale(s.saleId)).toMatchObject({
      status: 'SETTLED_NETTED',
      transferAmount: 0,
      debtNetted: 9325,
    });
    const open = debtRows({ status: 'OPEN' });
    expect(open).toEqual([
      expect.objectContaining({ reason: 'REFUND_FEE', amountOutstanding: 175 }),
    ]);
    expect(transfers.all).toHaveLength(0);
    expect(await invariantViolations()).toEqual([]);
  });

  it('reembolso hecho en Stripe antes de liquidar: la liquidación retiene, se anota y sigue', async () => {
    const s = newSale({});
    await fake.v1('POST', '/v1/refunds', { charge: s.chargeId, amount: 4000 });
    // Sella el reparto pero no transfiere: el reembolso no está anotado.
    expect((await settlement.settleSale(A, s.saleId, { force: true })).outcome).toBe('held');
    expect(sale(s.saleId)['lastError']).toMatch(/^charge_refunded/);
    expect(transfers.all).toHaveLength(0);

    clock += 10 * 60_000;
    await handleRefundEvent(
      { refunds },
      { tenantId: A, eventType: 'charge.refunded', object: { id: s.chargeId } },
    );
    // `onSaleChanged` relanza la liquidación: ya cuadra y transfiere lo que queda.
    expect(transfers.all.map((t) => t['amount'])).toEqual([5525]);
    expect(sale(s.saleId)['status']).toBe('TRANSFERRED');
    expect(await invariantViolations()).toEqual([]);
  });
});

describe('Disputas', () => {
  async function disputeEvent(type: string, id: string, tenantId = A) {
    return handleDisputeEvent({ disputes }, { tenantId, eventType: type, object: { id } });
  }

  it('tarjeta US: funds_withdrawn 10000 + tasa 2000, reversión 9160; perdida → repercusión 2340', async () => {
    const s = await transferredSale({ fee: 340 });
    seedDispute(fake, {
      id: 'dp_us1',
      chargeId: s.chargeId,
      amount: 10000,
      currency: 'eur',
      status: 'needs_response',
    });
    await disputeEvent('charge.dispute.created', 'dp_us1');
    expect(notices).toContainEqual(
      expect.objectContaining({ kind: 'disputeOpened', amount: 10000, saleId: s.saleId }),
    );
    expect(lossEntries(s.saleId)).toEqual({});

    seedDispute(fake, {
      id: 'dp_us1',
      chargeId: s.chargeId,
      amount: 10000,
      currency: 'eur',
      status: 'needs_response',
      withdrawn: { amount: 10000, fee: 2000, currency: 'eur' },
    });
    await disputeEvent('charge.dispute.funds_withdrawn', 'dp_us1');
    expect(world.reversals.map((r) => r['amount'])).toEqual([9160]);
    expect(lossEntries(s.saleId)).toEqual({
      DISPUTE_WITHDRAWN: -10000,
      DISPUTE_FEE: -2000,
      PLATFORM_FEE_REFUND: 500,
      TRANSFER_REVERSAL: 9160,
      ADJUSTMENT: 2340,
    });
    expect(debtRows()).toHaveLength(0);
    expect(await invariantViolations()).toEqual([]);
    // Reentrega: nada nuevo.
    await disputeEvent('charge.dispute.funds_withdrawn', 'dp_us1');
    expect(world.reversals).toHaveLength(1);

    seedDispute(fake, {
      id: 'dp_us1',
      chargeId: s.chargeId,
      amount: 10000,
      currency: 'eur',
      status: 'lost',
      withdrawn: { amount: 10000, fee: 2000, currency: 'eur' },
    });
    await disputeEvent('charge.dispute.closed', 'dp_us1');
    expect(debtRows()).toEqual([
      expect.objectContaining({ reason: 'DISPUTE_FEE', amountOutstanding: 2340, status: 'OPEN' }),
    ]);
    expect(lossEntries(s.saleId)).toMatchObject({ ADJUSTMENT: 0, DEBT_CREATED: 2340 });
    expect(db.rows('modPayoutsDispute')[0]).toMatchObject({
      outcome: 'lost',
      amount: 10000,
      fee: 2000,
    });
    expect(notices).toContainEqual(
      expect.objectContaining({ kind: 'debtCharged', amount: 2340, cause: 'dispute_lost' }),
    );
    expect(await invariantViolations()).toEqual([]);

    // La deuda se compensa con la próxima venta en euros.
    const next = await transferredSale({});
    expect(sale(next.saleId)).toMatchObject({ debtNetted: 2340, transferAmount: 6985 });
    expect(await invariantViolations()).toEqual([]);
  });

  it('ganada: transferencia nueva por lo revertido y la deuda de la disputa cancelada', async () => {
    const s = await transferredSale({ fee: 340 });
    world.setBalance(ACCT_A, 'eur', 5000);
    seedDispute(fake, {
      id: 'dp_won',
      chargeId: s.chargeId,
      amount: 10000,
      currency: 'eur',
      status: 'under_review',
      withdrawn: { amount: 10000, fee: 2000, currency: 'eur' },
    });
    await disputeEvent('charge.dispute.funds_withdrawn', 'dp_won');
    expect(world.reversals.map((r) => r['amount'])).toEqual([5000]);
    expect(debtRows()).toEqual([
      expect.objectContaining({ reason: 'DISPUTE', amountOutstanding: 4160, status: 'OPEN' }),
    ]);
    expect(await invariantViolations()).toEqual([]);

    // Mientras se decide, la deuda está congelada: otra venta NO la compensa
    // y el recobro diario no la toca.
    const other = await transferredSale({});
    expect(sale(other.saleId)).toMatchObject({ debtNetted: 0, transferAmount: 9325 });
    world.setBalance(ACCT_A, 'eur', 1_000_000);
    expect((await debts.recoverOpenDebts()).recovered).toEqual([]);

    seedDispute(fake, {
      id: 'dp_won',
      chargeId: s.chargeId,
      amount: 10000,
      currency: 'eur',
      status: 'won',
      withdrawn: { amount: 10000, fee: 2000, currency: 'eur' },
      reinstated: { amount: 10000, fee: 2000, currency: 'eur' },
    });
    await disputeEvent('charge.dispute.funds_reinstated', 'dp_won');
    await disputeEvent('charge.dispute.closed', 'dp_won');

    const reinstatement = transfers.all.filter(
      (t) => t['transfer_group'] === 'didacta_dispute_dp_won',
    );
    expect(reinstatement.map((t) => t['amount'])).toEqual([5000]);
    expect(debtRows()).toEqual([
      expect.objectContaining({ reason: 'DISPUTE', amountOutstanding: 0, status: 'WRITTEN_OFF' }),
    ]);
    expect(db.rows('modPayoutsDispute')[0]).toMatchObject({ outcome: 'won' });
    expect(await invariantViolations()).toEqual([]);
    expect(ledgerTotal()).toBe(0);
  });

  it('ganada sin que Stripe devuelva la tasa: la asume la plataforma, con asiento y alerta', async () => {
    const s = await transferredSale({ fee: 340 });
    seedDispute(fake, {
      id: 'dp_fee',
      chargeId: s.chargeId,
      amount: 10000,
      currency: 'eur',
      status: 'won',
      withdrawn: { amount: 10000, fee: 2000, currency: 'eur' },
      reinstated: { amount: 10000, fee: 0, currency: 'eur' },
    });
    await disputeEvent('charge.dispute.closed', 'dp_fee');
    expect(
      transfers.all.filter((t) => t['transfer_group'] === 'didacta_dispute_dp_fee'),
    ).toHaveLength(1);
    const adjustments = db
      .rows('modPayoutsLedgerEntry', { type: 'ADJUSTMENT' })
      .filter((e) => (e['idempotencyKey'] as string).endsWith(':won-cost'));
    expect(adjustments.map((e) => e['amount'])).toEqual([2000]);
    expect(alerts.map((a) => a['alert'])).toContain('payouts.platform_absorbed');
    expect(await invariantViolations()).toEqual([]);
  });

  it('una disputa abierta bloquea el reembolso desde el panel', async () => {
    const s = await transferredSale({});
    seedDispute(fake, {
      id: 'dp_block',
      chargeId: s.chargeId,
      amount: 10000,
      currency: 'eur',
      status: 'needs_response',
    });
    await disputeEvent('charge.dispute.created', 'dp_block');
    await expect(
      refunds.refund({ tenantId: A, saleId: s.saleId, initiatedBy: 'u' }),
    ).rejects.toMatchObject({ reason: 'disputed' });
  });

  it('una disputa sobre una venta aún sin transferir: no se transfiere hasta decidirse', async () => {
    const s = newSale({ fee: 340 });
    fake.patch(s.chargeId, { disputed: true });
    expect((await settlement.settleSale(A, s.saleId, { force: true })).outcome).toBe('held');
    seedDispute(fake, {
      id: 'dp_pend',
      chargeId: s.chargeId,
      amount: 10000,
      currency: 'eur',
      status: 'lost',
      withdrawn: { amount: 10000, fee: 2000, currency: 'eur' },
    });
    clock += 60_000;
    await disputeEvent('charge.dispute.closed', 'dp_pend');
    expect(transfers.all).toHaveLength(0);
    expect(sale(s.saleId)).toMatchObject({
      status: 'SETTLED_NETTED',
      transferAmount: 0,
      debtNetted: 9160,
    });
    expect(debtRows({ status: 'OPEN' })).toEqual([
      expect.objectContaining({ reason: 'DISPUTE_FEE', amountOutstanding: 2340 }),
    ]);
    expect(await invariantViolations()).toEqual([]);
  });
});

describe('Monedas', () => {
  it('reembolso de una venta en CHF: todo en CHF y la deuda no se cruza con euros', async () => {
    const chf = await transferredSale({ currency: 'chf', fee: 320 });
    await refunds.refund({ tenantId: A, saleId: chf.saleId, initiatedBy: 'u' });
    const entries = db.rows('modPayoutsLedgerEntry', { saleId: chf.saleId });
    expect(new Set(entries.map((e) => e['currency']))).toEqual(new Set(['chf']));
    expect(debtRows()).toEqual([
      expect.objectContaining({ currency: 'chf', reason: 'REFUND_FEE', amountOutstanding: 320 }),
    ]);

    const eur = await transferredSale({ currency: 'eur' });
    expect(sale(eur.saleId)).toMatchObject({ debtNetted: 0, transferAmount: 9325 });
    const usd = await transferredSale({ currency: 'usd', fee: 320 });
    expect(sale(usd.saleId)).toMatchObject({ debtNetted: 0, transferAmount: 9180 });

    const chf2 = await transferredSale({ currency: 'chf', fee: 320 });
    expect(sale(chf2.saleId)).toMatchObject({ debtNetted: 320, transferAmount: 9180 - 320 });
    expect(await invariantViolations()).toEqual([]);
    for (const currency of ['eur', 'usd', 'chf']) expect(ledgerTotal(currency)).toBe(0);
  });
});

describe('Deudas: avisos al operador', () => {
  it('avisa si la deuda supera el umbral o tiene más de 30 días', async () => {
    db.insert(
      'modPayoutsDebt',
      {
        tenantId: A,
        accountId: accountA,
        reason: 'REFUND_FEE',
        amountOriginal: 50,
        amountOutstanding: 50,
        currency: 'eur',
        status: 'OPEN',
        createdAt: new Date(START - 31 * 86_400_000),
      },
      {
        tenantId: B,
        accountId: accountB,
        reason: 'DISPUTE_FEE',
        amountOriginal: 20000,
        amountOutstanding: 20000,
        currency: 'eur',
        status: 'OPEN',
      },
      {
        tenantId: B,
        accountId: accountB,
        reason: 'REFUND_FEE',
        amountOriginal: 50,
        amountOutstanding: 50,
        currency: 'usd',
        status: 'OPEN',
      },
    );
    const report = await debts.alertOldOrLargeDebts();
    expect(report.alerts).toBe(2);
    const operator = notices.filter((n) => n.kind === 'operator');
    expect(operator.map((n) => [n['tenantId'], n['currency'], n['why']])).toEqual(
      expect.arrayContaining([
        [A, 'eur', ['antigüedad']],
        [B, 'eur', ['importe']],
      ]),
    );
  });
});

describe('Informes con reembolsos, disputas y deudas', () => {
  it('«Tus ventas» marca lo reembolsado y el resumen trae deudas y disputas abiertas', async () => {
    const refunded = await transferredSale({ description: 'Curso A' });
    const disputed = await transferredSale({ description: 'Curso B' });
    await refunds.refund({ tenantId: A, saleId: refunded.saleId, amount: 4000, initiatedBy: 'u' });
    seedDispute(fake, {
      id: 'dp_rep',
      chargeId: disputed.chargeId,
      amount: 10000,
      currency: 'eur',
      status: 'needs_response',
    });
    await handleDisputeEvent(
      { disputes },
      { tenantId: A, eventType: 'charge.dispute.created', object: { id: 'dp_rep' } },
    );

    const reports = new PayoutsReportsService(db.port());
    const page = await reports.listSales(A);
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(byId.get(refunded.saleId)).toMatchObject({
      refundState: 'partial',
      refundedAmount: 4000,
      reversedAmount: 3730,
      canRefund: true,
    });
    expect(byId.get(disputed.saleId)).toMatchObject({ disputeOpen: true, canRefund: false });

    const summary = await reports.summary(A);
    expect(summary.debts).toEqual([
      expect.objectContaining({
        reason: 'REFUND_FEE',
        amountOutstanding: 70,
        saleDescription: 'Curso A',
        frozen: false,
      }),
    ]);
    expect(summary.disputes).toEqual([
      expect.objectContaining({
        saleDescription: 'Curso B',
        amount: 10000,
        evidenceDueBy: '2025-11-22T00:00:00.000Z',
      }),
    ]);
    expect(summary.currencies[0]).toMatchObject({
      refunded: 4000,
      reversed: 3730,
      debtOutstanding: 70,
    });
    // Otro tenant no ve nada de esto.
    expect((await reports.summary(B)).debts).toEqual([]);
  });
});

describe('Conciliador (E6)', () => {
  it('anota un reembolso y una disputa cuyos eventos se perdieron', async () => {
    const s = await transferredSale({});
    const d = await transferredSale({ fee: 340 });
    await fake.v1('POST', '/v1/refunds', { charge: s.chargeId, amount: 10000 });
    seedDispute(fake, {
      id: 'dp_lost_evt',
      chargeId: d.chargeId,
      amount: 10000,
      currency: 'eur',
      status: 'needs_response',
      withdrawn: { amount: 10000, fee: 2000, currency: 'eur' },
    });
    fake.on('GET', '/v1/events', () => ({ data: [], has_more: false }));
    fake.on('GET', '/v1/charges', () => ({ data: [], has_more: false }));
    fake.on('GET', '/v1/disputes', () => ({ data: [fake.get('dp_lost_evt')!], has_more: false }));
    const reconciler = new PayoutsReconcilerService({
      db: db.port(),
      stripe: fake,
      settlement,
      replayEvent: async () => ({ outcome: 'processed' }),
      losses: { refunds, disputes, debts },
      now: () => new Date(clock),
    });
    const report = await reconciler.run({ deep: true });
    expect(report.losses).toMatchObject({
      refunds: { synced: 1, errors: 0 },
      disputes: { checked: 1, errors: 0 },
    });
    expect(refundRows(s.saleId)[0]).toMatchObject({
      initiatedBy: 'stripe_dashboard',
      reversalStatus: 'DONE',
    });
    expect(lossEntries(d.saleId)).toMatchObject({
      DISPUTE_WITHDRAWN: -10000,
      TRANSFER_REVERSAL: 9160,
    });
    expect(report.invariants.violations).toEqual([]);
    expect(report.transfers.unrecorded).toBe(0);
  });
});

describe('Desconexión y baja', () => {
  it('deja las suscripciones vivas para cancelar a final de periodo y no toca las demás', async () => {
    const disconnected: string[] = [];
    db.insert(
      'modPayoutsObjectRef',
      { stripeObjectId: 'sub_viva', tenantId: A, kind: 'subscription', source: 'membership' },
      { stripeObjectId: 'sub_cancelada', tenantId: A, kind: 'subscription', source: 'membership' },
      { stripeObjectId: 'sub_de_B', tenantId: B, kind: 'subscription', source: 'membership' },
    );
    fake.seed(
      { id: 'sub_viva', object: 'subscription', status: 'active', cancel_at_period_end: false },
      {
        id: 'sub_cancelada',
        object: 'subscription',
        status: 'canceled',
        cancel_at_period_end: false,
      },
      { id: 'sub_de_B', object: 'subscription', status: 'active', cancel_at_period_end: false },
    );
    fake.on('POST', '/v1/subscriptions/:id', (req, f) => {
      f.patch(req.pathParams['id']!, { cancel_at_period_end: true });
      return f.get(req.pathParams['id']!)!;
    });
    const offboarding = new PayoutsOffboardingService(db.port(), fake, {
      disconnect: async (tenantId: string) => {
        disconnected.push(tenantId);
        return { account: null, changed: true };
      },
    });
    const result = await offboarding.disconnect(A, { reason: 'creator' });
    expect(disconnected).toEqual([A]);
    expect(result).toMatchObject({ subscriptionsScheduled: 1, subscriptionsFailed: 0 });
    expect(fake.callsTo('POST', /\/v1\/subscriptions\//).map((c) => c.path)).toEqual([
      '/v1/subscriptions/sub_viva',
    ]);
    expect(fake.get('sub_de_B')!['cancel_at_period_end']).toBe(false);
  });
});
