/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * `transfer.*`: solo comprobación y alerta. Nunca mueve dinero ni cambia una venta.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryPlatformStripeClient,
  checkTransferEvent,
  handleChargeEvent,
} from '../src/index.js';
import { FakePayoutsDb } from './helpers/fake-payouts-db.js';

const A = '11111111-1111-4111-8111-111111111111';
const ACCT = 'acct_1CreadorA';

let db: FakePayoutsDb;
let fake: InMemoryPlatformStripeClient;
let alerts: Array<Record<string, unknown>>;
let saleId: string;

beforeEach(() => {
  db = new FakePayoutsDb();
  fake = new InMemoryPlatformStripeClient();
  alerts = [];
  const accountId = randomUUID();
  db.insert('modPayoutsAccount', {
    id: accountId,
    tenantId: A,
    stripeAccountId: ACCT,
    status: 'READY',
    country: 'ES',
    entityType: 'individual',
  });
  saleId = db.insert('modPayoutsSale', {
    tenantId: A,
    accountId,
    sourceKind: 'ORDER',
    sourceRef: randomUUID(),
    stripeChargeId: 'ch_3Venta',
    presentmentAmount: 10000,
    presentmentCurrency: 'eur',
    status: 'TRANSFERRED',
    currency: 'eur',
    transferAmount: 9325,
    stripeTransferId: 'tr_bueno',
  })[0]!['id'] as string;
  fake.seed(
    {
      id: 'tr_bueno',
      object: 'transfer',
      amount: 9325,
      amount_reversed: 0,
      currency: 'eur',
      destination: ACCT,
      metadata: { didacta_sale_id: saleId },
    },
    {
      id: 'tr_ajena',
      object: 'transfer',
      amount: 100,
      currency: 'eur',
      destination: ACCT,
      metadata: {},
    },
  );
});

const logger = { warn: () => undefined, error: (o: Record<string, unknown>) => alerts.push(o) };
const check = (transferId: string, eventType = 'transfer.created') =>
  checkTransferEvent(
    { db: db.port(), stripe: fake, logger },
    { tenantId: A, eventType, transferId },
  );

describe('checkTransferEvent', () => {
  it('la transferencia casa con su venta → ok, sin alertas ni escrituras', async () => {
    const before = JSON.stringify(db.tables);
    await expect(check('tr_bueno')).resolves.toEqual({ outcome: 'ok', saleId });
    expect(alerts).toEqual([]);
    expect(JSON.stringify(db.tables)).toBe(before);
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/transfers/tr_bueno']);
  });

  it('se coteja con la API, no con el evento: revertida a mano en Stripe → alerta, sin tocar la venta', async () => {
    fake.patch('tr_bueno', { amount_reversed: 3730 });
    const before = JSON.stringify(db.tables);
    const result = await check('tr_bueno', 'transfer.reversed');
    expect(result).toMatchObject({
      outcome: 'mismatch',
      problems: ['revertido en Stripe 3730 ≠ anotado 0'],
    });
    expect(alerts[0]).toMatchObject({ alert: 'payouts.transfer_mismatch', transferId: 'tr_bueno' });
    expect(JSON.stringify(db.tables)).toBe(before);
  });

  it('transferencia que ninguna venta respalda → alerta transfer_unrecorded', async () => {
    await expect(check('tr_ajena')).resolves.toEqual({ outcome: 'unknown' });
    expect(alerts[0]).toMatchObject({ alert: 'payouts.transfer_unrecorded' });
  });

  it('en vuelo (la venta aún no la anotó) → in_flight, sin alerta', async () => {
    const row = db.tables['modPayoutsSale']![0]!;
    row['status'] = 'READY';
    row['stripeTransferId'] = null;
    await expect(check('tr_bueno')).resolves.toEqual({ outcome: 'in_flight', saleId });
    expect(alerts).toEqual([]);
  });

  it('otros tipos se ignoran', async () => {
    await expect(check('tr_bueno', 'transfer.paid')).resolves.toEqual({ outcome: 'ignored' });
  });
});

describe('handleChargeEvent', () => {
  it('sin venta del cargo → no_sale; tipos que no liquidan → ignored', async () => {
    const deps = {
      db: db.port(),
      settlement: {
        settleSale: async () => {
          throw new Error('no debe liquidar');
        },
      } as never,
    };
    await expect(
      handleChargeEvent(deps, { tenantId: A, eventType: 'charge.updated', chargeId: 'ch_otro' }),
    ).resolves.toEqual({ outcome: 'no_sale' });
    await expect(
      handleChargeEvent(deps, { tenantId: A, eventType: 'charge.refunded', chargeId: 'ch_3Venta' }),
    ).resolves.toEqual({ outcome: 'ignored' });
  });
});
