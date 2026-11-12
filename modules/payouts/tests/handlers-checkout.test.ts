/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * `recordCheckoutSale`: de la sesión pagada a la venta `AWAITING_FEE`, con el
 * doble de Stripe y una base en memoria. Contra Postgres real (RLS, unicidad
 * por cargo) lo cubre `apps/api/tests/integration/platform-webhook-tenant-isolation.integration.test.ts`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { PayoutsDbPort } from '../src/accounts.service.js';
import { PayoutsSaleUnrecordableError } from '../src/errors.js';
import { recordCheckoutSale } from '../src/handlers/checkout.js';
import { InMemoryPlatformStripeClient } from '../src/stripe/platform-stripe.fake.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';

type Row = Record<string, unknown>;

class FakeDb {
  accounts: Row[] = [
    { id: 'cuenta-a', tenantId: A, stripeAccountId: 'acct_1CreadorA' },
    { id: 'cuenta-b', tenantId: B, stripeAccountId: 'acct_1CreadorB' },
  ];
  sales: Row[] = [];
  refs: Row[] = [];
  private seq = 0;

  /** Cliente visto desde un tenant (RLS simulada). */
  tx(tenantId: string) {
    const visible = <T extends Row>(rows: T[]) => rows.filter((r) => r['tenantId'] === tenantId);
    return {
      modPayoutsAccount: {
        findFirst: async ({ where }: { where: Row }) =>
          visible(this.accounts).find(
            (a) =>
              a['stripeAccountId'] === where['stripeAccountId'] &&
              a['tenantId'] === where['tenantId'],
          ) ?? null,
      },
      modPayoutsSale: {
        createMany: async ({ data }: { data: Row[] }) => {
          let count = 0;
          for (const row of data) {
            if (this.sales.some((s) => s['stripeChargeId'] === row['stripeChargeId'])) continue;
            this.sales.push({ id: `venta-${++this.seq}`, ...row });
            count += 1;
          }
          return { count };
        },
        findUnique: async ({ where }: { where: Row }) =>
          visible(this.sales).find((s) => s['stripeChargeId'] === where['stripeChargeId']) ?? null,
      },
      modPayoutsObjectRef: {
        createMany: async ({ data }: { data: Row[] }) => {
          let count = 0;
          for (const row of data) {
            if (this.refs.some((r) => r['stripeObjectId'] === row['stripeObjectId'])) continue;
            this.refs.push(row);
            count += 1;
          }
          return { count };
        },
        findUnique: async ({ where }: { where: Row }) =>
          visible(this.refs).find((r) => r['stripeObjectId'] === where['stripeObjectId']) ?? null,
      },
    };
  }

  port(): PayoutsDbPort {
    return {
      inTenant: (tenantId, fn) => fn(this.tx(tenantId) as never),
      global: () => {
        throw new Error('el manejador no usa acceso global');
      },
    };
  }
}

let db: FakeDb;
let stripe: InMemoryPlatformStripeClient;

function seedPaid(
  opts: {
    amount?: number;
    paymentStatus?: string;
    chargeStatus?: string;
    onBehalfOf?: string | null;
    mode?: string;
  } = {},
) {
  stripe.seed(
    {
      id: 'ch_3Cargo',
      object: 'charge',
      amount: opts.amount ?? 4900,
      currency: 'eur',
      status: opts.chargeStatus ?? 'succeeded',
      paid: (opts.chargeStatus ?? 'succeeded') === 'succeeded',
      created: 1_762_950_000,
      on_behalf_of: opts.onBehalfOf === undefined ? 'acct_1CreadorA' : opts.onBehalfOf,
      customer: 'cus_Alumna',
      balance_transaction: null,
    },
    {
      id: 'pi_3Intento',
      object: 'payment_intent',
      latest_charge: 'ch_3Cargo',
      on_behalf_of: opts.onBehalfOf === undefined ? 'acct_1CreadorA' : opts.onBehalfOf,
    },
    {
      id: 'cs_test_Sesion',
      object: 'checkout.session',
      mode: opts.mode ?? 'payment',
      payment_status: opts.paymentStatus ?? 'paid',
      livemode: false,
      customer: 'cus_Alumna',
      customer_details: { email: 'alumna@example.com' },
      payment_intent: 'pi_3Intento',
      // Lo que diga el EVENTO no se usa: aquí la sesión de la API.
      amount_total: opts.amount ?? 4900,
      line_items: { object: 'list', data: [{ description: 'Curso de prueba' }] },
    },
  );
}

beforeEach(() => {
  db = new FakeDb();
  stripe = new InMemoryPlatformStripeClient();
});

const input = { tenantId: A, sessionId: 'cs_test_Sesion', orderId: ORDER };

describe('recordCheckoutSale', () => {
  it('sesión pagada → venta AWAITING_FEE con los importes de la API e hijos registrados', async () => {
    seedPaid();
    const out = await recordCheckoutSale({ db: db.port(), stripe }, input);
    expect(out).toEqual({ outcome: 'created', saleId: 'venta-1', chargeId: 'ch_3Cargo' });
    expect(db.sales).toEqual([
      expect.objectContaining({
        tenantId: A,
        accountId: 'cuenta-a',
        sourceKind: 'ORDER',
        sourceRef: ORDER,
        description: 'Curso de prueba',
        buyerEmail: 'alumna@example.com',
        stripeChargeId: 'ch_3Cargo',
        stripePaymentIntentId: 'pi_3Intento',
        presentmentAmount: 4900,
        presentmentCurrency: 'eur',
        status: 'AWAITING_FEE',
        chargedAt: new Date(1_762_950_000_000),
      }),
    ]);
    // Sin reparto todavía: eso es la liquidación (E4).
    expect(db.sales[0]).not.toHaveProperty('gross');
    expect(db.refs.map((r) => [r['stripeObjectId'], r['kind'], r['parentObjectId']])).toEqual([
      ['pi_3Intento', 'payment_intent', 'cs_test_Sesion'],
      ['ch_3Cargo', 'charge', 'pi_3Intento'],
      ['cus_Alumna', 'customer', 'cs_test_Sesion'],
    ]);
    // Lo leyó de la API, con el cargo expandido.
    expect(stripe.calls[0]).toMatchObject({
      method: 'GET',
      path: '/v1/checkout/sessions/cs_test_Sesion',
      params: { expand: ['payment_intent.latest_charge', 'line_items'] },
    });
  });

  it('cinco veces la misma sesión → una venta', async () => {
    seedPaid();
    const outs = await Promise.all(
      Array.from({ length: 5 }, () => recordCheckoutSale({ db: db.port(), stripe }, input)),
    );
    expect(db.sales).toHaveLength(1);
    expect(outs.filter((o) => o.outcome === 'created')).toHaveLength(1);
    expect(outs.filter((o) => o.outcome === 'exists')).toHaveLength(4);
  });

  it('pago diferido sin confirmar (unpaid) → sin venta ni registros', async () => {
    seedPaid({ paymentStatus: 'unpaid', chargeStatus: 'pending' });
    expect(await recordCheckoutSale({ db: db.port(), stripe }, input)).toEqual({
      outcome: 'not_paid',
    });
    expect(db.sales).toHaveLength(0);
    expect(db.refs).toHaveLength(0);
  });

  it('cargo que no está succeeded → sin venta', async () => {
    seedPaid({ chargeStatus: 'failed' });
    expect((await recordCheckoutSale({ db: db.port(), stripe }, input)).outcome).toBe('not_paid');
    expect(db.sales).toHaveLength(0);
  });

  it('una sesión de suscripción no es una venta de curso', async () => {
    seedPaid({ mode: 'subscription' });
    expect((await recordCheckoutSale({ db: db.port(), stripe }, input)).outcome).toBe(
      'not_a_payment',
    );
  });

  it('on_behalf_of de una cuenta de OTRO tenant → no se anota (y se dice)', async () => {
    seedPaid({ onBehalfOf: 'acct_1CreadorB' });
    await expect(recordCheckoutSale({ db: db.port(), stripe }, input)).rejects.toBeInstanceOf(
      PayoutsSaleUnrecordableError,
    );
    expect(db.sales).toHaveLength(0);
    // Los hijos sí quedan a nombre del tenant del registro: atribuyen lo que venga.
    expect(db.refs).toHaveLength(3);
  });

  it('sin on_behalf_of → no se anota', async () => {
    seedPaid({ onBehalfOf: null });
    await expect(recordCheckoutSale({ db: db.port(), stripe }, input)).rejects.toBeInstanceOf(
      PayoutsSaleUnrecordableError,
    );
  });

  it('Stripe caído → el error sale (quien llama decide que no bloquee el acceso)', async () => {
    seedPaid();
    stripe.failNext('/v1/checkout/sessions/cs_test_Sesion', {
      message: 'Stripe no responde',
      status: 503,
      type: 'api_error',
    });
    await expect(recordCheckoutSale({ db: db.port(), stripe }, input)).rejects.toThrow(
      /Stripe no responde/,
    );
    expect(db.sales).toHaveLength(0);
  });
});
