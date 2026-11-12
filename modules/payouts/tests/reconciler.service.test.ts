/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Conciliador con el doble de Stripe y una base en memoria. La reproducción
 * de un evento por el camino REAL del webhook (acceso concedido) se prueba
 * contra Postgres en `apps/api/tests/integration/payouts-settlement.integration.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryPlatformStripeClient,
  PayoutsReconcilerService,
  PayoutsSettingsService,
  SettlementService,
  type PlatformStripeEvent,
  type StripeObject,
} from '../src/index.js';
import { FakePayoutsDb } from './helpers/fake-payouts-db.js';
import { installTransfers, seedCharge, type FakeTransfers } from './helpers/stripe-world.js';

const A = '11111111-1111-4111-8111-111111111111';
const ACCT_A = 'acct_1CreadorA';
const NOW = Date.parse('2026-11-12T12:00:00Z');
const nowSec = Math.floor(NOW / 1000);

let db: FakePayoutsDb;
let fake: InMemoryPlatformStripeClient;
let transfers: FakeTransfers;
let settlement: SettlementService;
let reconciler: PayoutsReconcilerService;
let alerts: Array<Record<string, unknown>>;
let replayed: PlatformStripeEvent[];
let accountId: string;
let charges: StripeObject[];
let events: StripeObject[];

beforeEach(() => {
  alerts = [];
  replayed = [];
  charges = [];
  events = [];
  db = new FakePayoutsDb();
  db.clock = () => new Date(NOW);
  fake = new InMemoryPlatformStripeClient();
  transfers = installTransfers(fake, { now: () => nowSec });
  accountId = randomUUID();
  db.insert('modPayoutsAccount', {
    id: accountId,
    tenantId: A,
    stripeAccountId: ACCT_A,
    status: 'READY',
    country: 'ES',
    entityType: 'individual',
  });
  fake.on('GET', '/v1/charges', () => ({
    object: 'list',
    data: [...charges].reverse(),
    has_more: false,
  }));
  fake.on('GET', '/v1/events', () => ({
    object: 'list',
    data: [...events].reverse(),
    has_more: false,
  }));
  fake.on('GET', '/v1/checkout/sessions', (req) => ({
    object: 'list',
    data: charges
      .filter((c) => c['payment_intent'] === req.params['payment_intent'])
      .map((c) => ({ id: `cs_test_${String(c['payment_intent']).slice(3)}` })),
    has_more: false,
  }));
  const logger = {
    warn: () => undefined,
    log: () => undefined,
    error: (obj: Record<string, unknown>) => alerts.push(obj),
  };
  const port = db.port();
  settlement = new SettlementService(port, fake, new PayoutsSettingsService(port, 500), {
    now: () => new Date(NOW),
    logger,
  });
  reconciler = new PayoutsReconcilerService({
    db: port,
    stripe: fake,
    settlement,
    logger,
    now: () => new Date(NOW),
    replayEvent: async (event) => {
      replayed.push(event);
      db.insert('modPayoutsWebhookEvent', {
        stripeEventId: event.id,
        tenantId: A,
        type: event.type,
        livemode: false,
        processedAt: new Date(NOW),
      });
      return { outcome: 'processed' };
    },
  });
});

/** Un cobro de curso completo en Stripe: sesión, PaymentIntent y cargo asentado. */
function paidCheckout(opts: { registered: boolean; onBehalfOf?: string | null }) {
  const tag = randomUUID().replace(/-/g, '').slice(0, 20);
  const chargeId = `ch_3${tag}`;
  const piId = `pi_3${tag}`;
  const sessionId = `cs_test_3${tag}`;
  const orderId = randomUUID();
  seedCharge(fake, {
    chargeId,
    onBehalfOf: opts.onBehalfOf === undefined ? ACCT_A : (opts.onBehalfOf as string),
    amount: 10000,
    currency: 'eur',
    bt: { amount: 10000, fee: 175, currency: 'eur' },
  });
  if (opts.onBehalfOf === null) fake.patch(chargeId, { on_behalf_of: null });
  fake.patch(chargeId, { payment_intent: piId, customer: `cus_${tag}` });
  fake.seed(
    { id: piId, object: 'payment_intent', latest_charge: chargeId, on_behalf_of: ACCT_A },
    {
      id: sessionId,
      object: 'checkout.session',
      mode: 'payment',
      payment_status: 'paid',
      livemode: false,
      customer: `cus_${tag}`,
      customer_details: { email: 'alumna@example.test' },
      payment_intent: piId,
      line_items: { object: 'list', data: [{ description: 'Curso' }] },
    },
  );
  charges.push(fake.get(chargeId)!);
  if (opts.registered) {
    db.insert('modPayoutsObjectRef', {
      stripeObjectId: sessionId,
      tenantId: A,
      kind: 'checkout_session',
      source: 'billing',
      localRef: orderId,
    });
  }
  return { chargeId, piId, sessionId, orderId };
}

const run = () => reconciler.run({ deep: true });

describe('conciliador', () => {
  it('cargo cobrado en Stripe SIN venta y con su sesión registrada → crea la venta y la liquida', async () => {
    const { chargeId, orderId } = paidCheckout({ registered: true });
    const report = await run();
    expect(report.charges).toMatchObject({
      listed: 1,
      withoutSale: 1,
      created: 1,
      unattributed: 0,
    });
    const [sale] = db.rows('modPayoutsSale', { stripeChargeId: chargeId });
    expect(sale).toMatchObject({ tenantId: A, sourceRef: orderId, presentmentAmount: 10000 });
    // La siguiente pasada la liquida (el barrido va antes que la búsqueda de cobros).
    const second = await run();
    expect(second.charges.withoutSale).toBe(0);
    expect(second.sales.outcomes).toEqual({ transferred: 1 });
    expect(transfers.all.map((t) => t['amount'])).toEqual([9325]);
    expect(second.invariants.violations).toEqual([]);
  });

  it('cargo en nombre de una cuenta conectada que el registro NO conoce → alerta, sin venta', async () => {
    const { chargeId } = paidCheckout({ registered: false });
    const report = await run();
    expect(report.charges).toMatchObject({ withoutSale: 1, created: 0, unattributed: 1 });
    expect(db.rows('modPayoutsSale', { stripeChargeId: chargeId })).toEqual([]);
    expect(alerts.map((a) => a['alert'])).toContain('payouts.charge_unattributed');
  });

  it('cargo sin on_behalf_of (no es de un creador) → se ignora en silencio', async () => {
    paidCheckout({ registered: false, onBehalfOf: null });
    const report = await run();
    expect(report.charges).toMatchObject({ listed: 1, withoutSale: 0, unattributed: 0 });
    expect(alerts).toEqual([]);
  });

  it('transferencia en Stripe sin venta ni asiento → SOLO alerta: ni base ni Stripe se tocan', async () => {
    const stray = {
      id: 'tr_hecha_a_mano',
      object: 'transfer',
      amount: 4200,
      currency: 'eur',
      destination: ACCT_A,
      created: nowSec - 3600,
      metadata: {},
    };
    transfers.all.push(stray);
    fake.seed(stray);
    const before = JSON.stringify(db.tables);
    const callsBefore = fake.calls.filter((c) => c.method === 'POST').length;
    const report = await run();
    expect(report.transfers).toEqual({ listed: 1, unrecorded: 1, inFlight: 0, mismatched: 0 });
    expect(alerts).toEqual([
      expect.objectContaining({
        alert: 'payouts.transfer_unrecorded',
        transferId: 'tr_hecha_a_mano',
        amount: 4200,
      }),
    ]);
    expect(JSON.stringify(db.tables)).toBe(before);
    expect(fake.calls.filter((c) => c.method === 'POST').length).toBe(callsBefore);
  });

  it('evento de las últimas horas no procesado → se reproduce; uno ya procesado, no', async () => {
    const lost = {
      id: 'evt_perdido',
      object: 'event',
      type: 'checkout.session.completed',
      livemode: false,
      created: nowSec - 600,
      data: { object: { id: 'cs_test_x' } },
    };
    const done = {
      id: 'evt_hecho',
      object: 'event',
      type: 'charge.updated',
      livemode: false,
      created: nowSec - 300,
      data: { object: { id: 'ch_x' } },
    };
    const other = {
      id: 'evt_balance',
      object: 'event',
      type: 'balance.available',
      livemode: false,
      created: nowSec - 200,
      data: { object: {} },
    };
    events.push(lost, done, other);
    db.insert('modPayoutsWebhookEvent', {
      stripeEventId: 'evt_hecho',
      tenantId: A,
      type: 'charge.updated',
      processedAt: new Date(NOW - 300_000),
    });
    const report = await run();
    expect(replayed.map((e) => e.id)).toEqual(['evt_perdido']);
    expect(report.events).toMatchObject({ listed: 3, replayed: 1, failed: 0 });
    expect((await run()).events.replayed).toBe(0);
  });

  it('se reproducen en el orden en que ocurrieron (Stripe lista del más nuevo al más viejo)', async () => {
    events.push(
      {
        id: 'evt_1',
        type: 'checkout.session.completed',
        livemode: false,
        created: nowSec - 30,
        data: { object: { id: 'cs_test_a' } },
      },
      {
        id: 'evt_2',
        type: 'charge.updated',
        livemode: false,
        created: nowSec - 20,
        data: { object: { id: 'ch_a' } },
      },
    );
    await run();
    expect(replayed.map((e) => e.id)).toEqual(['evt_1', 'evt_2']);
  });

  it('venta que lleva más de 90 minutos sin balance_transaction → alerta', async () => {
    const chargeId = 'ch_3Lento';
    seedCharge(fake, { chargeId, onBehalfOf: ACCT_A, amount: 10000, currency: 'eur' });
    db.insert('modPayoutsSale', {
      tenantId: A,
      accountId,
      sourceKind: 'ORDER',
      sourceRef: randomUUID(),
      stripeChargeId: chargeId,
      presentmentAmount: 10000,
      presentmentCurrency: 'eur',
      chargedAt: new Date(NOW - 91 * 60_000),
      nextAttemptAt: new Date(NOW + 60_000),
    });
    const report = await run();
    expect(report.lateBalanceTransactions).toBe(1);
    expect(alerts.map((a) => a['alert'])).toEqual(['payouts.balance_transaction_late']);
  });

  it('una venta manipulada (el libro no casa con sus columnas) → alerta de invariante', async () => {
    const { chargeId } = paidCheckout({ registered: true });
    await run();
    await run();
    const sale = db.tables['modPayoutsSale']!.find((s) => s['stripeChargeId'] === chargeId)!;
    expect(sale['status']).toBe('TRANSFERRED');
    sale['platformFee'] = 400; // alguien «corrige» la venta a mano
    const report = await reconciler.checkInvariants(null);
    expect(report.violations.map((v) => v.kind)).toEqual(['sale']);
    expect(report.violations[0]!.detail).toMatch(/bruto − comisiones ≠ neto/);
    expect(alerts.some((a) => a['alert'] === 'payouts.ledger_invariant')).toBe(true);
  });

  it('un asiento suelto descuadra el saldo de la cuenta → alerta account_balance', async () => {
    db.insert('modPayoutsLedgerEntry', {
      tenantId: A,
      accountId,
      type: 'ADJUSTMENT',
      amount: -100,
      currency: 'gbp',
      idempotencyKey: 'test:suelto',
      occurredAt: new Date(NOW),
    });
    const { violations } = await reconciler.checkInvariants(null);
    expect(violations).toEqual([
      expect.objectContaining({
        kind: 'account_balance',
        currency: 'gbp',
        detail: 'libro -100 ≠ pendiente de transferir 0',
      }),
    ]);
  });
});
