/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Liquidación de punta a punta con el doble de Stripe y una base en memoria:
 * cargo sin `balance_transaction` → `charge.updated` → transferencia exacta y
 * cuatro asientos, con los importes REALES del sandbox (tabla de E1 y la de
 * divisas de la sección 9). La concurrencia y el aislamiento contra Postgres
 * real (como `didacta_app`) están en
 * `apps/api/tests/integration/payouts-settlement.integration.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleChargeEvent } from '../src/handlers/charge.js';
import {
  InMemoryPlatformStripeClient,
  PayoutsReconcilerService,
  PayoutsSettingsService,
  SettlementService,
} from '../src/index.js';
import sandbox from './fixtures/sandbox-2026-11-12.json';
import divisas from './fixtures/sandbox-divisas-2026-11-12.json';
import { FakePayoutsDb } from './helpers/fake-payouts-db.js';
import {
  installTransfers,
  seedCharge,
  settleChargeInStripe,
  type FakeTransfers,
} from './helpers/stripe-world.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ACCT_A = 'acct_1CreadorA';
const ACCT_B = 'acct_1CreadorB';
const START = Date.parse('2026-11-12T10:00:00Z');
const HOUR = 3_600_000;

let db: FakePayoutsDb;
let fake: InMemoryPlatformStripeClient;
let transfers: FakeTransfers;
let clock: number;
let service: SettlementService;
let settings: PayoutsSettingsService;
let alerts: Array<Record<string, unknown>>;
let accountA: string;

function build(): void {
  const port = db.port();
  const logger = {
    warn: () => undefined,
    log: () => undefined,
    error: (obj: Record<string, unknown>) => alerts.push(obj),
  };
  settings = new PayoutsSettingsService(port, 500);
  service = new SettlementService(port, fake, settings, { now: () => new Date(clock), logger });
}

beforeEach(() => {
  clock = START;
  alerts = [];
  db = new FakePayoutsDb();
  db.clock = () => new Date(clock);
  fake = new InMemoryPlatformStripeClient({ livemode: false });
  transfers = installTransfers(fake, { now: () => Math.floor(clock / 1000) });
  accountA = randomUUID();
  db.insert(
    'modPayoutsAccount',
    {
      id: accountA,
      tenantId: A,
      stripeAccountId: ACCT_A,
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
    },
    {
      id: randomUUID(),
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
function newSale(
  input: {
    tenantId?: string;
    presentmentAmount?: number;
    presentmentCurrency?: string;
    onBehalfOf?: string;
    chargeAmount?: number;
    chargeCurrency?: string;
    bt?: { amount: number; fee: number; currency: string };
    transferGroup?: string;
    sourceKind?: 'ORDER' | 'SUBSCRIPTION_INVOICE';
  } = {},
) {
  const tenantId = input.tenantId ?? A;
  const chargeId = `ch_3Prueba${++seq}x${Math.floor(clock / 1000)}`;
  seedCharge(fake, {
    chargeId,
    onBehalfOf: input.onBehalfOf ?? (tenantId === A ? ACCT_A : ACCT_B),
    amount: input.chargeAmount ?? input.presentmentAmount ?? 10000,
    currency: input.chargeCurrency ?? input.presentmentCurrency ?? 'eur',
    bt: input.bt,
    transferGroup: input.transferGroup,
  });
  const accountId = db.rows('modPayoutsAccount', { tenantId })[0]!['id'] as string;
  const [sale] = db.insert('modPayoutsSale', {
    tenantId,
    accountId,
    sourceKind: input.sourceKind ?? 'ORDER',
    sourceRef: randomUUID(),
    description: 'Curso de prueba',
    stripeChargeId: chargeId,
    presentmentAmount: input.presentmentAmount ?? 10000,
    presentmentCurrency: input.presentmentCurrency ?? 'eur',
    status: 'AWAITING_FEE',
    chargedAt: new Date(clock),
  });
  return { saleId: sale!['id'] as string, chargeId, tenantId };
}

function sale(id: string) {
  return db.rows('modPayoutsSale', { id })[0]!;
}

function entries(saleId: string) {
  return db
    .rows('modPayoutsLedgerEntry', { saleId })
    .map((e) => ({ type: e['type'], amount: e['amount'], currency: e['currency'] }));
}

function transferPosts() {
  return fake.callsTo('POST', '/v1/transfers');
}

async function invariantViolations() {
  const reconciler = new PayoutsReconcilerService({
    db: db.port(),
    stripe: fake,
    settlement: service,
    replayEvent: async () => ({ outcome: 'processed' }),
  });
  return (await reconciler.checkInvariants(null)).violations;
}

const chargeUpdated = (tenantId: string, chargeId: string) =>
  handleChargeEvent(
    { db: db.port(), settlement: service },
    { tenantId, eventType: 'charge.updated', chargeId },
  );

type Case = {
  case: string;
  presentmentAmount: number;
  presentmentCurrency: string;
  gross: number;
  stripeFee: number;
  platformFee: number;
  creatorNet: number;
  currency: string;
};

const TABLE: Case[] = [
  ...(sandbox.sales as Case[]),
  sandbox.subscriptionInvoice as Case,
  ...(divisas.cases as Case[]),
];

describe('liquidación de punta a punta: tabla del sandbox (E1 + divisas)', () => {
  it('la tabla tiene los 12 casos de E1 y los 10 de divisas', () => {
    expect(TABLE).toHaveLength(22);
    expect(TABLE.map((c) => c.currency)).toEqual(
      expect.arrayContaining(['eur', 'usd', 'gbp', 'chf', 'sek', 'pln', 'dkk', 'cad', 'huf']),
    );
  });

  it.each(TABLE)(
    '$case: $gross $currency − $stripeFee − $platformFee → transferencia $creatorNet',
    async (c) => {
      const { saleId, chargeId } = newSale({
        presentmentAmount: c.presentmentAmount,
        presentmentCurrency: c.presentmentCurrency,
        sourceKind: c.case.startsWith('factura') ? 'SUBSCRIPTION_INVOICE' : 'ORDER',
        transferGroup: `didacta_${c.case}`,
      });

      // 1) Recién cobrado: sin balance_transaction no se reparte nada.
      const first = await chargeUpdated(A, chargeId);
      expect(first).toMatchObject({ outcome: 'settled', result: { outcome: 'awaiting_fee' } });
      expect(transferPosts()).toHaveLength(0);
      expect(entries(saleId)).toEqual([]);
      expect(sale(saleId)).toMatchObject({ status: 'AWAITING_FEE', transferAmount: null });

      // 2) Stripe asienta el cargo y avisa con charge.updated.
      settleChargeInStripe(fake, chargeId, {
        amount: c.gross,
        fee: c.stripeFee,
        currency: c.currency,
      });
      const second = await chargeUpdated(A, chargeId);
      expect(second).toMatchObject({
        outcome: 'settled',
        result: { outcome: 'transferred', transferAmount: c.creatorNet, currency: c.currency },
      });

      // Transferencia exacta, con source_transaction y la clave de idempotencia.
      const posts = transferPosts();
      expect(posts).toHaveLength(1);
      expect(posts[0]!.params).toEqual({
        amount: c.creatorNet,
        currency: c.currency,
        destination: ACCT_A,
        source_transaction: chargeId,
        transfer_group: `didacta_${c.case}`,
        description: 'Curso de prueba',
        metadata: { didacta_sale_id: saleId, didacta_tenant_id: A },
      });
      expect(posts[0]!.options.idempotencyKey).toBe(`payouts:transfer:${saleId}`);

      // Cuatro asientos que suman cero.
      expect(entries(saleId)).toEqual([
        { type: 'SALE_GROSS', amount: c.gross, currency: c.currency },
        { type: 'STRIPE_FEE', amount: -c.stripeFee, currency: c.currency },
        { type: 'PLATFORM_FEE', amount: -c.platformFee, currency: c.currency },
        { type: 'TRANSFER', amount: -c.creatorNet, currency: c.currency },
      ]);

      expect(sale(saleId)).toMatchObject({
        status: 'TRANSFERRED',
        presentmentAmount: c.presentmentAmount,
        presentmentCurrency: c.presentmentCurrency,
        gross: c.gross,
        stripeFee: c.stripeFee,
        feeBpsApplied: 500,
        platformFee: c.platformFee,
        creatorNet: c.creatorNet,
        transferAmount: c.creatorNet,
        debtNetted: 0,
        currency: c.currency,
        stripeTransferId: transfers.all[0]!['id'],
        nextAttemptAt: null,
        lastError: null,
      });
      expect(await invariantViolations()).toEqual([]);
    },
  );
});

describe('idempotencia y concurrencia', () => {
  it('charge.updated ×5 A LA VEZ → una sola transferencia y cuatro asientos', async () => {
    const { saleId, chargeId } = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    const results = await Promise.all(Array.from({ length: 5 }, () => chargeUpdated(A, chargeId)));
    const outcomes = results.map((r) => (r.outcome === 'settled' ? r.result.outcome : r.outcome));
    expect(outcomes.filter((o) => o === 'transferred')).toHaveLength(1);
    expect(outcomes.filter((o) => o !== 'transferred').every((o) => o === 'busy')).toBe(true);
    expect(transferPosts()).toHaveLength(1);
    expect(transfers.all).toHaveLength(1);
    expect(entries(saleId)).toHaveLength(4);
    expect(sale(saleId)['transferAmount']).toBe(9325);
  });

  it('charge.updated ×5 seguidos (reentregas) → una transferencia; el resto ve la venta liquidada', async () => {
    const { saleId, chargeId } = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await chargeUpdated(A, chargeId);
      outcomes.push(r.outcome === 'settled' ? r.result.outcome : r.outcome);
    }
    expect(outcomes).toEqual(['transferred', ...Array(4).fill('already_settled')]);
    expect(transferPosts()).toHaveLength(1);
    expect(entries(saleId)).toHaveLength(4);
  });

  it('el webhook y el barrido a la vez → una transferencia', async () => {
    const { chargeId } = newSale({ bt: { amount: 10000, fee: 340, currency: 'eur' } });
    await Promise.all([chargeUpdated(A, chargeId), service.sweep(), service.sweep()]);
    expect(transferPosts()).toHaveLength(1);
    expect(transfers.all[0]!['amount']).toBe(9160);
  });

  it('el proceso muere tras crear la transferencia y antes de anotarla: el barrido la ADOPTA sin crear otra', async () => {
    const { saleId } = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    let die = true;
    fake.on('POST', '/v1/transfers', (req, f) => {
      const transfer = {
        id: f.nextId('tr'),
        object: 'transfer',
        amount: req.params['amount'],
        amount_reversed: 0,
        currency: req.params['currency'],
        destination: req.params['destination'],
        source_transaction: req.params['source_transaction'],
        transfer_group: req.params['transfer_group'],
        metadata: req.params['metadata'],
        balance_transaction: f.nextId('txn'),
        created: Math.floor(clock / 1000),
      };
      transfers.all.push(transfer);
      f.seed(transfer);
      if (die) {
        die = false;
        throw new Error('el worker se cae a mitad');
      }
      return transfer;
    });
    await expect(service.sweep()).resolves.toMatchObject({ errors: 1 });
    expect(sale(saleId)).toMatchObject({ status: 'READY', stripeTransferId: null });
    expect(entries(saleId).map((e) => e.type)).toEqual([
      'SALE_GROSS',
      'STRIPE_FEE',
      'PLATFORM_FEE',
    ]);

    // Mientras dura el arriendo nadie la toca.
    await expect(service.settleSale(A, saleId)).resolves.toMatchObject({ outcome: 'busy' });

    clock += 6 * 60_000;
    const sweep = await service.sweep();
    expect(sweep.outcomes).toEqual({ transferred: 1 });
    expect(transferPosts()).toHaveLength(1);
    expect(transfers.all).toHaveLength(1);
    expect(sale(saleId)).toMatchObject({
      status: 'TRANSFERRED',
      stripeTransferId: transfers.all[0]!['id'],
    });
    expect(entries(saleId)).toHaveLength(4);
    expect(await invariantViolations()).toEqual([]);
  });

  it('error transitorio de Stripe (500) → sigue READY y el reintento usa la MISMA clave', async () => {
    const { saleId } = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    fake.failNext('/v1/transfers', {
      method: 'POST',
      status: 500,
      message: 'boom',
      type: 'api_error',
    });
    await expect(service.settleSale(A, saleId)).resolves.toMatchObject({ outcome: 'retry' });
    expect(sale(saleId)).toMatchObject({ status: 'READY', attempts: 0 });
    expect(String(sale(saleId)['lastError'])).toMatch(/^stripe_unavailable:/);
    clock += 6 * 60_000;
    await expect(service.settleSale(A, saleId)).resolves.toMatchObject({ outcome: 'transferred' });
    expect(transferPosts().map((c) => c.options.idempotencyKey)).toEqual([
      `payouts:transfer:${saleId}`,
      `payouts:transfer:${saleId}`,
    ]);
  });
});

describe('retenciones y reintentos', () => {
  it('transferencia rechazada → HELD con motivo; el reintento del día siguiente la completa', async () => {
    const { saleId } = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    fake.failNext('/v1/transfers', {
      method: 'POST',
      status: 400,
      stripeCode: 'balance_insufficient',
      message: 'Insufficient funds in Stripe account.',
    });
    await expect(service.settleSale(A, saleId)).resolves.toEqual({
      outcome: 'held',
      saleId,
      reason: 'transfer_rejected',
    });
    expect(sale(saleId)).toMatchObject({ status: 'HELD', attempts: 1, transferAmount: 9325 });
    expect(String(sale(saleId)['lastError'])).toContain('transfer_rejected: balance_insufficient');
    expect((sale(saleId)['nextAttemptAt'] as Date).getTime()).toBe(clock + 24 * HOUR);
    expect(entries(saleId).map((e) => e.type)).toEqual([
      'SALE_GROSS',
      'STRIPE_FEE',
      'PLATFORM_FEE',
    ]);

    // Antes de tiempo, no.
    await expect(service.settleSale(A, saleId)).resolves.toMatchObject({ outcome: 'busy' });
    expect((await service.sweep()).due).toBe(0);

    // Mientras tanto cambia la comisión del aula: el reparto sellado no se toca.
    await settings.setFeeBps(A, 1000, 'test');

    clock += 24 * HOUR + 1;
    expect(await service.sweep()).toMatchObject({ due: 1, outcomes: { transferred: 1 } });
    // Tras un 4xx Stripe guarda la respuesta 24 h con esa clave: el reintento usa otra.
    expect(transferPosts().map((c) => c.options.idempotencyKey)).toEqual([
      `payouts:transfer:${saleId}`,
      `payouts:transfer:${saleId}:1`,
    ]);
    expect(transfers.all.map((t) => t['amount'])).toEqual([9325]);
    expect(sale(saleId)).toMatchObject({
      status: 'TRANSFERRED',
      lastError: null,
      feeBpsApplied: 500,
    });
    expect(entries(saleId)).toEqual([
      { type: 'SALE_GROSS', amount: 10000, currency: 'eur' },
      { type: 'STRIPE_FEE', amount: -175, currency: 'eur' },
      { type: 'PLATFORM_FEE', amount: -500, currency: 'eur' },
      { type: 'TRANSFER', amount: -9325, currency: 'eur' },
    ]);
    expect(await invariantViolations()).toEqual([]);
  });

  it('cuenta restringida → HELD sin llamar a Stripe; al volver a estar lista se transfiere', async () => {
    db.tables['modPayoutsAccount']!.find((a) => a['id'] === accountA)!['status'] = 'RESTRICTED';
    const { saleId } = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    await expect(service.settleSale(A, saleId)).resolves.toMatchObject({
      outcome: 'held',
      reason: 'account_not_ready',
    });
    expect(transferPosts()).toHaveLength(0);
    db.tables['modPayoutsAccount']!.find((a) => a['id'] === accountA)!['status'] = 'READY';
    clock += 24 * HOUR + 1;
    await expect(service.settleSale(A, saleId)).resolves.toMatchObject({ outcome: 'transferred' });
    expect(transferPosts()[0]!.options.idempotencyKey).toBe(`payouts:transfer:${saleId}`);
  });

  it('sin datos fiscales completos → HELD tax_profile_incomplete sin llamar a Stripe; completos → se transfiere', async () => {
    let complete = false;
    const gated = new SettlementService(db.port(), fake, settings, {
      now: () => new Date(clock),
      transferGate: {
        transferBlockReason: async () => (complete ? null : 'tax_profile_incomplete'),
      },
    });
    const { saleId } = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    await expect(gated.settleSale(A, saleId)).resolves.toMatchObject({
      outcome: 'held',
      reason: 'tax_profile_incomplete',
    });
    expect(transferPosts()).toHaveLength(0);
    // El reparto queda sellado: lo que se retiene es solo la transferencia.
    expect(sale(saleId)).toMatchObject({
      status: 'HELD',
      transferAmount: 9325,
      platformFee: 500,
    });
    expect(String(sale(saleId)['lastError'])).toMatch(/^tax_profile_incomplete:/);
    complete = true;
    // (Al completar los datos, el perfil adelanta el reintento a «ya»; aquí,
    // con la base en memoria, basta con llegar al reintento programado.)
    clock += 24 * HOUR + 1;
    await expect(gated.settleSale(A, saleId)).resolves.toMatchObject({
      outcome: 'transferred',
      transferAmount: 9325,
    });
    expect(await invariantViolations()).toEqual([]);
  });

  it('el permiso de transferir solo retiene por datos fiscales, no por otros motivos', async () => {
    const gated = new SettlementService(db.port(), fake, settings, {
      now: () => new Date(clock),
      transferGate: { transferBlockReason: async () => 'otra_cosa' },
    });
    const { saleId } = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    await expect(gated.settleSale(A, saleId)).resolves.toMatchObject({ outcome: 'transferred' });
  });

  it('cargo reembolsado en Stripe sin anotar → sella el reparto pero HELD sin transferir (E6 lo anota)', async () => {
    const { saleId, chargeId } = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    fake.patch(chargeId, { amount_refunded: 10000, refunded: true });
    await expect(service.settleSale(A, saleId)).resolves.toMatchObject({
      outcome: 'held',
      reason: 'charge_refunded',
    });
    // El reparto se sella (el reembolso se anota contra él); la transferencia no sale.
    expect(sale(saleId)).toMatchObject({ status: 'HELD', transferAmount: 9325 });
    expect(entries(saleId).map((e) => e.type)).toEqual([
      'SALE_GROSS',
      'STRIPE_FEE',
      'PLATFORM_FEE',
    ]);
    expect(transferPosts()).toHaveLength(0);
    expect(await invariantViolations()).toEqual([]);
  });

  it('cargo disputado → HELD charge_disputed', async () => {
    const { saleId, chargeId } = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    fake.patch(chargeId, { disputed: true });
    await expect(service.settleSale(A, saleId)).resolves.toMatchObject({
      reason: 'charge_disputed',
    });
  });

  it('sin balance_transaction: espera programada; un charge.updated la fuerza, el barrido no', async () => {
    const { saleId, chargeId } = newSale();
    await expect(service.settleSale(A, saleId)).resolves.toMatchObject({ outcome: 'awaiting_fee' });
    expect((sale(saleId)['nextAttemptAt'] as Date).getTime()).toBe(clock + 60_000);
    await expect(service.settleSale(A, saleId)).resolves.toMatchObject({ outcome: 'busy' });
    expect((await service.sweep()).due).toBe(0);
    settleChargeInStripe(fake, chargeId, { amount: 10000, fee: 175, currency: 'eur' });
    await expect(chargeUpdated(A, chargeId)).resolves.toMatchObject({
      result: { outcome: 'transferred', transferAmount: 9325 },
    });
  });
});

describe('deuda: se compensa en la MISMA divisa', () => {
  function seedDebt(currency: string, amount: number, createdOffset = 0) {
    const debtId = randomUUID();
    db.insert('modPayoutsDebt', {
      id: debtId,
      tenantId: A,
      accountId: accountA,
      reason: 'MANUAL',
      amountOriginal: amount,
      amountOutstanding: amount,
      currency,
      status: 'OPEN',
      createdAt: new Date(clock + createdOffset),
    });
    // Un grupo de deuda balanceado: el ajuste que la origina y su paso a deuda.
    db.insert(
      'modPayoutsLedgerEntry',
      {
        tenantId: A,
        accountId: accountA,
        type: 'ADJUSTMENT',
        amount: -amount,
        currency,
        idempotencyKey: `test:ajuste:${debtId}`,
        occurredAt: new Date(clock),
      },
      {
        tenantId: A,
        accountId: accountA,
        type: 'DEBT_CREATED',
        amount,
        currency,
        idempotencyKey: `test:deuda:${debtId}`,
        occurredAt: new Date(clock),
      },
    );
    return debtId;
  }

  it('deuda abierta 2340 y venta de 9325 → transferencia 6985 y DEBT_RECOVERED −2340', async () => {
    const debtId = seedDebt('eur', 2340);
    const { saleId } = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    await expect(service.settleSale(A, saleId)).resolves.toMatchObject({
      outcome: 'transferred',
      transferAmount: 6985,
      debtNetted: 2340,
    });
    expect(transfers.all.map((t) => t['amount'])).toEqual([6985]);
    expect(sale(saleId)).toMatchObject({
      creatorNet: 9325,
      debtNetted: 2340,
      transferAmount: 6985,
    });
    expect(entries(saleId)).toEqual([
      { type: 'SALE_GROSS', amount: 10000, currency: 'eur' },
      { type: 'STRIPE_FEE', amount: -175, currency: 'eur' },
      { type: 'PLATFORM_FEE', amount: -500, currency: 'eur' },
      { type: 'DEBT_RECOVERED', amount: -2340, currency: 'eur' },
      { type: 'TRANSFER', amount: -6985, currency: 'eur' },
    ]);
    expect(db.rows('modPayoutsLedgerEntry', { type: 'DEBT_RECOVERED' })[0]!['idempotencyKey']).toBe(
      `payouts:debt-recovery:${debtId}:sale:${saleId}`,
    );
    expect(db.rows('modPayoutsDebt', { id: debtId })[0]).toMatchObject({
      amountOutstanding: 0,
      status: 'RECOVERED',
    });
    expect(await invariantViolations()).toEqual([]);
  });

  it('deuda en usd NO se compensa con una venta en eur', async () => {
    const debtId = seedDebt('usd', 2340);
    const { saleId } = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    await expect(service.settleSale(A, saleId)).resolves.toMatchObject({
      transferAmount: 9325,
      debtNetted: 0,
    });
    expect(db.rows('modPayoutsDebt', { id: debtId })[0]).toMatchObject({
      amountOutstanding: 2340,
      status: 'OPEN',
    });
    expect(entries(saleId).map((e) => e.type)).not.toContain('DEBT_RECOVERED');
    expect(await invariantViolations()).toEqual([]);
  });

  it('deuda mayor que el neto → SETTLED_NETTED sin transferencia; se cobra la más antigua primero', async () => {
    const older = seedDebt('eur', 5000, -HOUR);
    const newer = seedDebt('eur', 6000);
    const { saleId } = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    await expect(service.settleSale(A, saleId)).resolves.toEqual({
      outcome: 'netted',
      saleId,
      debtNetted: 9325,
      currency: 'eur',
    });
    expect(transferPosts()).toHaveLength(0);
    expect(sale(saleId)).toMatchObject({
      status: 'SETTLED_NETTED',
      transferAmount: 0,
      debtNetted: 9325,
      nextAttemptAt: null,
    });
    expect(db.rows('modPayoutsDebt', { id: older })[0]).toMatchObject({
      amountOutstanding: 0,
      status: 'RECOVERED',
    });
    expect(db.rows('modPayoutsDebt', { id: newer })[0]).toMatchObject({
      amountOutstanding: 1675,
      status: 'OPEN',
    });
    expect(await invariantViolations()).toEqual([]);
  });

  it('dos ventas a la vez sobre la misma deuda: solo una la compensa', async () => {
    seedDebt('eur', 2340);
    const one = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    const two = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    await Promise.all([service.settleSale(A, one.saleId), service.settleSale(A, two.saleId)]);
    const netted = [sale(one.saleId)['debtNetted'], sale(two.saleId)['debtNetted']].sort();
    expect(netted).toEqual([0, 2340]);
    expect(transfers.all.map((t) => t['amount']).sort()).toEqual([6985, 9325]);
    expect(await invariantViolations()).toEqual([]);
  });
});

describe('lo que no cuadra no se transfiere', () => {
  it('cargo en nombre de OTRA cuenta → FAILED y alerta, sin transferencia', async () => {
    const { saleId } = newSale({
      onBehalfOf: ACCT_B,
      bt: { amount: 10000, fee: 175, currency: 'eur' },
    });
    await expect(service.settleSale(A, saleId)).resolves.toMatchObject({
      outcome: 'failed',
      reason: 'charge_mismatch',
    });
    expect(transferPosts()).toHaveLength(0);
    expect(alerts.map((a) => a['alert'])).toEqual(['payouts.settlement_failed']);
  });

  it('neto negativo (la comisión se come el bruto) → FAILED negative_net', async () => {
    const { saleId } = newSale({
      presentmentAmount: 50,
      bt: { amount: 50, fee: 55, currency: 'eur' },
    });
    await expect(service.settleSale(A, saleId)).resolves.toMatchObject({ reason: 'negative_net' });
    expect(sale(saleId)).toMatchObject({ status: 'FAILED', creatorNet: -8 });
    expect(transferPosts()).toHaveLength(0);
  });

  it('una venta de A no se puede liquidar desde el contexto de B', async () => {
    const { saleId } = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    await expect(service.settleSale(B, saleId)).resolves.toEqual({ outcome: 'not_found', saleId });
    expect(transferPosts()).toHaveLength(0);
  });

  it('en Stripe hay una transferencia de la venta con otro importe → FAILED transfer_mismatch', async () => {
    const { saleId, chargeId } = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    const bogus = {
      id: 'tr_ajena',
      object: 'transfer',
      amount: 100,
      currency: 'eur',
      destination: ACCT_A,
      source_transaction: chargeId,
      transfer_group: `didacta_sale_${saleId}`,
      metadata: { didacta_sale_id: saleId },
      created: Math.floor(clock / 1000),
    };
    transfers.all.push(bogus);
    fake.seed(bogus);
    await expect(service.settleSale(A, saleId)).resolves.toMatchObject({
      reason: 'transfer_mismatch',
    });
    expect(transferPosts()).toHaveLength(0);
  });

  it('el listado de transferencias no responde → retry, sin crear nada', async () => {
    const { saleId } = newSale({ bt: { amount: 10000, fee: 175, currency: 'eur' } });
    fake.failNext('/v1/transfers', { method: 'GET', status: 0, message: 'sin red' });
    await expect(service.settleSale(A, saleId)).resolves.toMatchObject({ outcome: 'retry' });
    expect(transferPosts()).toHaveLength(0);
  });
});
