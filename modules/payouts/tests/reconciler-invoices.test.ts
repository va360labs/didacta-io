/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * E5 — el conciliador y las facturas de suscripción: un cargo cobrado en
 * nombre de un creador cuya venta no existe (el `invoice.paid` se perdió) es de
 * una factura → crea la venta `SUBSCRIPTION_INVOICE`, con el tenant del
 * registro de su suscripción. Antes (E4) solo alertaba `payouts.charge_unhandled`.
 *
 * Los cargos tienen la forma de la API de la plataforma: sin `invoice` (el
 * conciliador lo pregunta a `GET /v1/invoice_payments`).
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryPlatformStripeClient,
  PayoutsReconcilerService,
  PayoutsSettingsService,
  SettlementService,
  type StripeObject,
} from '../src/index.js';
import { FakePayoutsDb } from './helpers/fake-payouts-db.js';
import { installTransfers, seedCharge, type FakeTransfers } from './helpers/stripe-world.js';

const A = '11111111-1111-4111-8111-111111111111';
const ACCT_A = 'acct_1CreadorA';
const PLAN = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-11-12T12:00:00Z');

let db: FakePayoutsDb;
let fake: InMemoryPlatformStripeClient;
let transfers: FakeTransfers;
let reconciler: PayoutsReconcilerService;
let alerts: Array<Record<string, unknown>>;
let charges: StripeObject[];
let invoicePayments: Array<{ invoice: string; pi: string }>;
let sessionsBySub: Record<string, string>;

beforeEach(() => {
  alerts = [];
  charges = [];
  invoicePayments = [];
  sessionsBySub = {};
  db = new FakePayoutsDb();
  db.clock = () => new Date(NOW);
  fake = new InMemoryPlatformStripeClient();
  transfers = installTransfers(fake, { now: () => Math.floor(NOW / 1000) });
  db.insert('modPayoutsAccount', {
    id: randomUUID(),
    tenantId: A,
    stripeAccountId: ACCT_A,
    status: 'READY',
  });
  fake.on('GET', '/v1/charges', () => ({ object: 'list', data: [...charges], has_more: false }));
  fake.on('GET', '/v1/events', () => ({ object: 'list', data: [], has_more: false }));
  fake.on('GET', '/v1/transfers', () => ({ object: 'list', data: [], has_more: false }));
  // La sesión de una suscripción no tiene PaymentIntent: por él no hay sesión.
  fake.on('GET', '/v1/checkout/sessions', (req) => {
    const sub = req.params['subscription'];
    const id = typeof sub === 'string' ? sessionsBySub[sub] : undefined;
    return { object: 'list', data: id ? [{ id }] : [], has_more: false };
  });
  fake.on('GET', '/v1/invoice_payments', (req) => {
    const payment = req.params['payment'] as Record<string, unknown> | undefined;
    const data = invoicePayments
      .filter((p) =>
        req.params['invoice'] !== undefined
          ? p.invoice === req.params['invoice']
          : p.pi === payment?.['payment_intent'],
      )
      .map((p) => ({
        object: 'invoice_payment',
        invoice: p.invoice,
        status: 'paid',
        is_default: true,
        payment: { type: 'payment_intent', payment_intent: p.pi },
      }));
    return { object: 'list', data, has_more: false };
  });
  const logger = {
    warn: () => undefined,
    log: () => undefined,
    error: (obj: Record<string, unknown>) => alerts.push(obj),
  };
  const port = db.port();
  const settlement = new SettlementService(port, fake, new PayoutsSettingsService(port, 500), {
    now: () => new Date(NOW),
    logger,
  });
  reconciler = new PayoutsReconcilerService({
    db: port,
    stripe: fake,
    settlement,
    logger,
    now: () => new Date(NOW),
    replayEvent: async () => ({ outcome: 'processed' }),
  });
});

/** Una renovación cobrada en Stripe cuyo `invoice.paid` no llegó nunca. */
function lostRenewal(sub: string) {
  const tag = randomUUID().replace(/-/g, '').slice(0, 16);
  const ids = { invoice: `in_${tag}`, pi: `pi_3${tag}`, charge: `ch_3${tag}` };
  seedCharge(fake, {
    chargeId: ids.charge,
    onBehalfOf: ACCT_A,
    amount: 2900,
    currency: 'eur',
    bt: { amount: 2900, fee: 69, currency: 'eur' },
  });
  fake.patch(ids.charge, { payment_intent: ids.pi });
  fake.seed(
    { id: ids.pi, object: 'payment_intent', latest_charge: ids.charge, on_behalf_of: ACCT_A },
    {
      id: ids.invoice,
      object: 'invoice',
      status: 'paid',
      amount_paid: 2900,
      currency: 'eur',
      livemode: false,
      on_behalf_of: ACCT_A,
      parent: { type: 'subscription_details', subscription_details: { subscription: sub } },
      lines: { object: 'list', data: [{ description: '1 × Membresía' }] },
    },
  );
  invoicePayments.push({ invoice: ids.invoice, pi: ids.pi });
  charges.push(fake.get(ids.charge)!);
  return ids;
}

describe('conciliador · cargos de facturas de suscripción', () => {
  it('suscripción registrada → crea la venta y la siguiente pasada la liquida (2686)', async () => {
    db.insert('modPayoutsObjectRef', {
      stripeObjectId: 'sub_1Registrada',
      tenantId: A,
      kind: 'subscription',
      source: 'membership',
      localRef: PLAN,
    });
    const ids = lostRenewal('sub_1Registrada');
    const report = await reconciler.run({ deep: true });
    expect(report.charges).toMatchObject({
      withoutSale: 1,
      created: 1,
      unattributed: 0,
      unhandled: 0,
    });
    expect(db.rows('modPayoutsSale', { stripeChargeId: ids.charge })[0]).toMatchObject({
      tenantId: A,
      sourceKind: 'SUBSCRIPTION_INVOICE',
      sourceRef: ids.invoice,
    });
    expect(alerts.map((a) => a['alert'])).not.toContain('payouts.charge_unhandled');

    const second = await reconciler.run({ deep: true });
    expect(second.sales.outcomes).toEqual({ transferred: 1 });
    expect(transfers.all.map((t) => t['amount'])).toEqual([2686]);
    expect(second.invariants.violations).toEqual([]);
  });

  it('suscripción sin registrar pero con su sesión de origen registrada → ata los hijos y crea la venta', async () => {
    const sessionId = 'cs_test_Origen';
    sessionsBySub['sub_1SoloSesion'] = sessionId;
    fake.seed({
      id: sessionId,
      object: 'checkout.session',
      mode: 'subscription',
      subscription: 'sub_1SoloSesion',
      customer: 'cus_Alumna',
      livemode: false,
    });
    db.insert('modPayoutsObjectRef', {
      stripeObjectId: sessionId,
      tenantId: A,
      kind: 'checkout_session',
      source: 'membership',
      localRef: PLAN,
    });
    const ids = lostRenewal('sub_1SoloSesion');
    const report = await reconciler.run({ deep: true });
    expect(report.charges).toMatchObject({ created: 1, unattributed: 0 });
    expect(db.rows('modPayoutsObjectRef', { stripeObjectId: 'sub_1SoloSesion' })[0]).toMatchObject({
      tenantId: A,
      parentObjectId: sessionId,
    });
    expect(db.rows('modPayoutsSale', { stripeChargeId: ids.charge })).toHaveLength(1);
  });

  it('nadie la atribuye → alerta charge_unattributed, sin venta ni registro', async () => {
    const ids = lostRenewal('sub_1Huerfana');
    const report = await reconciler.run({ deep: true });
    expect(report.charges).toMatchObject({ withoutSale: 1, created: 0, unattributed: 1 });
    expect(db.rows('modPayoutsSale', { stripeChargeId: ids.charge })).toEqual([]);
    expect(db.rows('modPayoutsObjectRef')).toEqual([]);
    expect(alerts.map((a) => a['alert'])).toContain('payouts.charge_unattributed');
  });
});
