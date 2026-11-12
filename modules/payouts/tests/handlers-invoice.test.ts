/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Membresías cobradas por la plataforma (E5): de la factura pagada a la venta
 * `SUBSCRIPTION_INVOICE` y su liquidación, con el doble de Stripe y una base en
 * memoria. El alta de 29 € usa las respuestas REALES del sandbox (las tres
 * formas de la factura); renovaciones, prueba gratis, Adaptive Pricing y cuenta
 * restringida, objetos con la misma forma. Contra Postgres real como
 * `didacta_app`: `apps/api/tests/integration/payouts-membership.integration.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryPlatformStripeClient,
  PayoutsSaleUnrecordableError,
  PayoutsSettingsService,
  SettlementService,
} from '../src/index.js';
import {
  accountHoldsRenewals,
  recordInvoiceSale,
  type InvoiceSaleOutcome,
} from '../src/handlers/invoice.js';
import facturas from './fixtures/invoices-2026-11-12.json';
import { FakePayoutsDb } from './helpers/fake-payouts-db.js';
import { installTransfers, seedCharge, type FakeTransfers } from './helpers/stripe-world.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ACCT_A = 'acct_1Uatj9GgKZOTeRsE'; // la cuenta del creador ES del sandbox
const ACCT_B = 'acct_1CreadorB';
const PLAN = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-11-12T10:00:00Z');

type Obj = Record<string, unknown>;

let db: FakePayoutsDb;
let fake: InMemoryPlatformStripeClient;
let transfers: FakeTransfers;
let settlement: SettlementService;
let accountA: string;

function registerSubscription(tenantId: string, subscriptionId: string) {
  db.insert('modPayoutsObjectRef', {
    stripeObjectId: subscriptionId,
    tenantId,
    kind: 'subscription',
    source: 'membership',
    localRef: PLAN,
    parentObjectId: `cs_test_${subscriptionId.slice(4)}`,
  });
}

beforeEach(() => {
  db = new FakePayoutsDb();
  db.clock = () => new Date(NOW);
  fake = new InMemoryPlatformStripeClient({ livemode: false });
  transfers = installTransfers(fake, { now: () => Math.floor(NOW / 1000) });
  accountA = randomUUID();
  db.insert(
    'modPayoutsAccount',
    { id: accountA, tenantId: A, stripeAccountId: ACCT_A, status: 'READY', country: 'ES' },
    { id: randomUUID(), tenantId: B, stripeAccountId: ACCT_B, status: 'READY', country: 'ES' },
  );
  const port = db.port();
  settlement = new SettlementService(port, fake, new PayoutsSettingsService(port, 500), {
    now: () => new Date(NOW),
  });
});

const record = (tenantId: string, invoiceId: string) =>
  recordInvoiceSale({ db: db.port(), stripe: fake }, { tenantId, invoiceId });

function saleOf(outcome: InvoiceSaleOutcome): Obj {
  if (outcome.outcome !== 'created' && outcome.outcome !== 'exists') {
    throw new Error(`sin venta: ${outcome.outcome}`);
  }
  return db.rows('modPayoutsSale', { id: outcome.saleId })[0]!;
}

// ─────────── el alta de 29 € con las respuestas reales del sandbox ───────────

const REAL = {
  invoice: 'in_1UatoiGVFsqqzpBiAvOm3OUe',
  sub: 'sub_1UatoiGVFsqqzpBio5vcWfRW',
  pi: 'pi_3UatojGVFsqqzpBi1aY1ywxE',
  charge: 'ch_3UatojGVFsqqzpBi1wnKzuX2',
};

/** Siembra la factura real en la forma pedida, su PaymentIntent y su cargo reales. */
function seedRealInvoice(form: 'A' | 'B' | 'C') {
  const pi = structuredClone(facturas.payment_intent_de_la_factura) as Obj;
  const charge = pi['latest_charge'] as Obj;
  fake.seed(charge, { ...pi, latest_charge: REAL.charge });
  const invoice =
    form === 'A'
      ? facturas.formaA_invoice_acacia
      : form === 'B'
        ? facturas.formaB_invoice_endive_expand_payments
        : facturas.formaC_invoice_endive_sin_payments;
  fake.seed(structuredClone(invoice) as Obj);
  fake.on('GET', '/v1/invoice_payments', (req) => ({
    object: 'list',
    data: (facturas.invoice_payments_por_factura.data as Obj[]).filter(
      (item) => item['invoice'] === req.params['invoice'],
    ),
    has_more: false,
  }));
}

describe('alta de 29 € (respuestas reales del sandbox): venta 2900, comisión 69, transferencia 2686', () => {
  for (const form of ['A', 'B', 'C'] as const) {
    it(`forma ${form} de la factura → la misma venta y el mismo reparto`, async () => {
      seedRealInvoice(form);
      registerSubscription(A, REAL.sub);

      const recorded = await record(A, REAL.invoice);
      expect(recorded).toMatchObject({
        outcome: 'created',
        chargeId: REAL.charge,
        accountStatus: 'READY',
      });
      expect(saleOf(recorded)).toMatchObject({
        tenantId: A,
        accountId: accountA,
        sourceKind: 'SUBSCRIPTION_INVOICE',
        sourceRef: REAL.invoice,
        stripeInvoiceId: REAL.invoice,
        stripeChargeId: REAL.charge,
        stripePaymentIntentId: REAL.pi,
        buyerEmail: 'alumno-con_obo@example.com',
        presentmentAmount: 2900,
        presentmentCurrency: 'eur',
        gross: 2900,
        currency: 'eur',
        status: 'AWAITING_FEE',
      });

      const settled = await settlement.settleSale(A, (recorded as { saleId: string }).saleId, {
        force: true,
      });
      expect(settled).toMatchObject({
        outcome: 'transferred',
        transferAmount: 2686,
        currency: 'eur',
      });
      expect(saleOf(recorded)).toMatchObject({
        status: 'TRANSFERRED',
        gross: 2900,
        stripeFee: 69,
        feeBpsApplied: 500,
        platformFee: 145,
        creatorNet: 2686,
        transferAmount: 2686,
      });
      expect(transfers.all).toHaveLength(1);
      expect(transfers.all[0]).toMatchObject({
        amount: 2686,
        currency: 'eur',
        destination: ACCT_A,
        source_transaction: REAL.charge,
      });
      // Hijos de la factura a nombre del tenant: charge.updated, reembolsos y
      // disputas de este cargo se atribuyen por ellos.
      expect(
        db
          .rows('modPayoutsObjectRef', { tenantId: A })
          .map((r) => [r['stripeObjectId'], r['kind'], r['parentObjectId']])
          .filter(([id]) => id !== REAL.sub),
      ).toEqual(
        expect.arrayContaining([
          [REAL.invoice, 'invoice', REAL.sub],
          [REAL.pi, 'payment_intent', REAL.invoice],
          [REAL.charge, 'charge', REAL.pi],
        ]),
      );
    });
  }

  it('reentrega ×5 (en serie y en paralelo) → una venta', async () => {
    seedRealInvoice('B');
    registerSubscription(A, REAL.sub);
    const first = await record(A, REAL.invoice);
    const again = await Promise.all([1, 2, 3, 4].map(() => record(A, REAL.invoice)));
    expect(first.outcome).toBe('created');
    expect(again.map((r) => r.outcome)).toEqual(['exists', 'exists', 'exists', 'exists']);
    expect(db.rows('modPayoutsSale')).toHaveLength(1);
  });
});

// ─────────── renovaciones, prueba gratis, divisas, cuentas ───────────

let seq = 0;

/** Una factura de suscripción cobrada, con la forma de la API de la plataforma. */
function seedPaidInvoice(opts: {
  sub: string;
  amount: number;
  fee: number;
  currency?: string;
  onBehalfOf?: string;
  presentment?: { amount: number; currency: string };
  billingReason?: string;
  status?: string;
}) {
  seq += 1;
  const tag = `${seq}x${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const ids = { invoice: `in_${tag}`, pi: `pi_3${tag}`, charge: `ch_3${tag}` };
  const currency = opts.currency ?? 'eur';
  const onBehalfOf = opts.onBehalfOf ?? ACCT_A;
  if (opts.amount > 0) {
    seedCharge(fake, {
      chargeId: ids.charge,
      onBehalfOf,
      amount: opts.amount,
      currency,
      presentment: opts.presentment,
      bt: { amount: opts.amount, fee: opts.fee, currency },
    });
    fake.patch(ids.charge, { payment_intent: ids.pi });
    fake.seed({
      id: ids.pi,
      object: 'payment_intent',
      latest_charge: ids.charge,
      on_behalf_of: onBehalfOf,
    });
  }
  fake.seed({
    id: ids.invoice,
    object: 'invoice',
    status: opts.status ?? 'paid',
    amount_paid: opts.status && opts.status !== 'paid' ? 0 : opts.amount,
    currency,
    livemode: false,
    billing_reason: opts.billingReason ?? 'subscription_cycle',
    customer_email: 'alumna@example.com',
    on_behalf_of: onBehalfOf,
    parent: { type: 'subscription_details', subscription_details: { subscription: opts.sub } },
    lines: { object: 'list', data: [{ description: '1 × Membresía (at €29.00 / month)' }] },
    payments: {
      object: 'list',
      data:
        opts.amount > 0
          ? [
              {
                status: 'paid',
                is_default: true,
                payment: { type: 'payment_intent', payment_intent: ids.pi },
              },
            ]
          : [],
    },
  });
  return ids;
}

describe('ciclo de vida de la membresía', () => {
  it('renovación → segunda venta con el mismo reparto (2900 → 2686) y su propia transferencia', async () => {
    registerSubscription(A, 'sub_1Renueva');
    const alta = seedPaidInvoice({
      sub: 'sub_1Renueva',
      amount: 2900,
      fee: 69,
      billingReason: 'subscription_create',
    });
    const renovacion = seedPaidInvoice({ sub: 'sub_1Renueva', amount: 2900, fee: 69 });
    for (const invoice of [alta.invoice, renovacion.invoice]) {
      const recorded = await record(A, invoice);
      expect(recorded.outcome).toBe('created');
      await settlement.settleSale(A, (recorded as { saleId: string }).saleId, { force: true });
    }
    const sales = db.rows('modPayoutsSale', { tenantId: A });
    expect(
      sales.map((s) => [
        s['sourceRef'],
        s['stripeFee'],
        s['platformFee'],
        s['transferAmount'],
        s['status'],
      ]),
    ).toEqual(
      expect.arrayContaining([
        [alta.invoice, 69, 145, 2686, 'TRANSFERRED'],
        [renovacion.invoice, 69, 145, 2686, 'TRANSFERRED'],
      ]),
    );
    expect(transfers.all.map((t) => [t['amount'], t['source_transaction']])).toEqual([
      [2686, alta.charge],
      [2686, renovacion.charge],
    ]);
  });

  it('prueba de 7 días: la factura de 0 € no crea venta; la primera con importe, sí', async () => {
    registerSubscription(A, 'sub_1Prueba');
    const alta = seedPaidInvoice({
      sub: 'sub_1Prueba',
      amount: 0,
      fee: 0,
      billingReason: 'subscription_create',
    });
    expect(await record(A, alta.invoice)).toEqual({ outcome: 'no_charge' });
    expect(db.rows('modPayoutsSale')).toEqual([]);
    expect(fake.callsTo('POST', '/v1/transfers')).toEqual([]);

    const finDePrueba = seedPaidInvoice({ sub: 'sub_1Prueba', amount: 2900, fee: 69 });
    const recorded = await record(A, finDePrueba.invoice);
    expect(recorded.outcome).toBe('created');
    const settled = await settlement.settleSale(A, (recorded as { saleId: string }).saleId, {
      force: true,
    });
    expect(settled).toMatchObject({ outcome: 'transferred', transferAmount: 2686 });
  });

  it('factura abierta o impagada → sin venta (el impago no mueve dinero)', async () => {
    registerSubscription(A, 'sub_1Impago');
    const abierta = seedPaidInvoice({ sub: 'sub_1Impago', amount: 2900, fee: 69, status: 'open' });
    expect(await record(A, abierta.invoice)).toEqual({ outcome: 'not_paid' });
    expect(db.rows('modPayoutsSale')).toEqual([]);
  });

  it('Adaptive Pricing: factura en EUR y el alumno paga en MXN → presentment en MXN, bruto en EUR', async () => {
    registerSubscription(A, 'sub_1Mexico');
    const ids = seedPaidInvoice({
      sub: 'sub_1Mexico',
      amount: 2900,
      fee: 69,
      presentment: { amount: 62_383, currency: 'mxn' },
    });
    const recorded = await record(A, ids.invoice);
    expect(saleOf(recorded)).toMatchObject({
      presentmentAmount: 62_383,
      presentmentCurrency: 'mxn',
      gross: 2900,
      currency: 'eur',
    });
    await settlement.settleSale(A, (recorded as { saleId: string }).saleId, { force: true });
    expect(saleOf(recorded)).toMatchObject({
      platformFee: 145,
      transferAmount: 2686,
      currency: 'eur',
    });
  });

  it('cuenta restringida con renovaciones vivas → la venta se anota y se retiene (HELD), sin transferir', async () => {
    registerSubscription(A, 'sub_1Restringida');
    db.tables['modPayoutsAccount']!.find((a) => a['id'] === accountA)!['status'] = 'RESTRICTED';
    const ids = seedPaidInvoice({ sub: 'sub_1Restringida', amount: 2900, fee: 69 });
    const recorded = await record(A, ids.invoice);
    expect(recorded).toMatchObject({ outcome: 'created', accountStatus: 'RESTRICTED' });
    expect(accountHoldsRenewals('RESTRICTED')).toBe(true);
    expect(accountHoldsRenewals('READY')).toBe(false);
    const settled = await settlement.settleSale(A, (recorded as { saleId: string }).saleId, {
      force: true,
    });
    expect(settled).toMatchObject({ outcome: 'held', reason: 'account_not_ready' });
    expect(saleOf(recorded)).toMatchObject({ status: 'HELD', transferAmount: 2686 });
    expect(transfers.all).toEqual([]);
  });
});

describe('el dinero nunca se atribuye sin registro', () => {
  it('suscripción sin registrar → no se anota (y no se registra nada de la factura)', async () => {
    const ids = seedPaidInvoice({ sub: 'sub_1SinRegistro', amount: 2900, fee: 69 });
    await expect(record(A, ids.invoice)).rejects.toBeInstanceOf(PayoutsSaleUnrecordableError);
    expect(db.rows('modPayoutsSale')).toEqual([]);
    expect(db.rows('modPayoutsObjectRef')).toEqual([]);
  });

  it('suscripción registrada a OTRO tenant → no se anota para éste', async () => {
    registerSubscription(B, 'sub_1DeB');
    const ids = seedPaidInvoice({ sub: 'sub_1DeB', amount: 2900, fee: 69, onBehalfOf: ACCT_B });
    await expect(record(A, ids.invoice)).rejects.toBeInstanceOf(PayoutsSaleUnrecordableError);
    expect(db.rows('modPayoutsSale')).toEqual([]);
  });

  it('cargo en nombre de la cuenta de OTRO tenant → no se anota', async () => {
    registerSubscription(A, 'sub_1Cruzada');
    const ids = seedPaidInvoice({ sub: 'sub_1Cruzada', amount: 2900, fee: 69, onBehalfOf: ACCT_B });
    await expect(record(A, ids.invoice)).rejects.toThrow(/no es una cuenta de este tenant/);
    expect(db.rows('modPayoutsSale')).toEqual([]);
  });

  it('factura suelta (sin suscripción) → no es de este flujo', async () => {
    fake.seed({
      id: 'in_1Suelta',
      object: 'invoice',
      status: 'paid',
      amount_paid: 1000,
      currency: 'eur',
    });
    expect(await record(A, 'in_1Suelta')).toEqual({ outcome: 'not_a_subscription' });
  });
});
