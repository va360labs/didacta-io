/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Aviso de cada venta a quien administra el aula (ensayo general de Cloud: la
 * creadora no se enteraba de que había vendido). Una vez por venta, pase lo
 * que pase: reentregas del webhook, barrido, conciliador.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PayoutsSaleNoticesService,
  TAX_PROFILE_HOLD_REASON,
  type PayoutsNotifier,
  type SaleMadeNotice,
} from '../src/index.js';
import { FakePayoutsDb } from './helpers/fake-payouts-db.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-14T12:00:00Z');

let db: FakePayoutsDb;
let sent: SaleMadeNotice[];
let clock: number;
let taxBlocked: boolean;
let notifier: PayoutsNotifier;
let notices: PayoutsSaleNoticesService;
const account: Record<string, string> = {};

beforeEach(() => {
  db = new FakePayoutsDb();
  clock = NOW;
  db.clock = () => new Date(clock);
  sent = [];
  taxBlocked = false;
  notifier = {
    disputeOpened: async () => undefined,
    debtCharged: async () => undefined,
    operatorAlert: async () => undefined,
    saleMade: async (input) => void sent.push(input),
  };
  notices = new PayoutsSaleNoticesService(db.port(), {
    notifier,
    taxGate: {
      transferBlockReason: async () => (taxBlocked ? TAX_PROFILE_HOLD_REASON : null),
    },
    now: () => new Date(clock),
  });
  for (const tenantId of [A, B]) {
    account[tenantId] = randomUUID();
    db.insert('modPayoutsAccount', {
      id: account[tenantId],
      tenantId,
      stripeAccountId: `acct_${tenantId.slice(0, 4)}`,
      status: 'READY',
      country: 'ES',
      entityType: 'individual',
    });
  }
});

function sale(tenantId: string, row: Record<string, unknown> = {}) {
  return db.insert('modPayoutsSale', {
    tenantId,
    accountId: account[tenantId],
    sourceKind: 'ORDER',
    sourceRef: randomUUID(),
    description: 'Torno para principiantes',
    buyerEmail: 'marta@example.test',
    stripeChargeId: `ch_${randomUUID().slice(0, 8)}`,
    presentmentAmount: 4900,
    presentmentCurrency: 'eur',
    chargedAt: new Date(clock),
    ...row,
  })[0]!;
}

/** Factura de una suscripción, colgada de su `sub_…` en el registro. */
function invoiceSale(tenantId: string, subscriptionId: string, at: number) {
  const invoiceId = `in_${randomUUID().slice(0, 8)}`;
  db.insert('modPayoutsObjectRef', {
    stripeObjectId: invoiceId,
    tenantId,
    kind: 'invoice',
    source: 'membership',
    parentObjectId: subscriptionId,
  });
  return sale(tenantId, {
    sourceKind: 'SUBSCRIPTION_INVOICE',
    sourceRef: invoiceId,
    stripeInvoiceId: invoiceId,
    description: 'Membresía mensual',
    presentmentAmount: 2900,
    chargedAt: new Date(at),
  });
}

describe('aviso de una venta', () => {
  it('curso: avisa con lo que pagó el alumno, su correo y el producto', async () => {
    const s = sale(A);
    expect(await notices.notify(A, s['id'] as string)).toBe('sent');
    expect(sent).toEqual([
      {
        tenantId: A,
        saleId: s['id'],
        kind: 'course',
        description: 'Torno para principiantes',
        amount: 4900,
        currency: 'eur',
        buyerEmail: 'marta@example.test',
        heldForTaxData: false,
        // El pedido (para la referencia corta del correo) y cuándo se cobró.
        sourceRef: s['sourceRef'],
        chargedAt: new Date(clock),
        // Aún sin `balance_transaction`: el reparto va vacío, nada inventado.
        split: {
          currency: null,
          gross: null,
          stripeFee: null,
          platformFee: null,
          feeBpsApplied: null,
          debtNetted: 0,
          creatorNet: null,
          transferAmount: null,
          status: 'AWAITING_FEE',
          estimatedArrival: null,
        },
      },
    ]);
    expect(db.rows('modPayoutsSale', { id: s['id'] })[0]!['creatorNotifiedAt']).toEqual(
      new Date(NOW),
    );
  });

  it('con el reparto hecho: comisiones, lo que llega y el día estimado según su calendario', async () => {
    db.update(
      'modPayoutsAccount',
      { id: account[A] },
      { payoutSchedule: { interval: 'weekly', weeklyDay: 'friday', monthlyDay: null } },
    );
    const s = sale(A, {
      currency: 'eur',
      gross: 4900,
      stripeFee: 99,
      platformFee: 245,
      feeBpsApplied: 500,
      creatorNet: 4556,
      transferAmount: 4556,
      status: 'READY',
      // Disponible el miércoles 18-nov-2026: el viernes siguiente es el 20.
      availableOn: new Date('2026-11-18T00:00:00Z'),
    });
    expect(await notices.notify(A, s['id'] as string)).toBe('sent');
    expect(sent[0]!.split).toEqual({
      currency: 'eur',
      gross: 4900,
      stripeFee: 99,
      platformFee: 245,
      feeBpsApplied: 500,
      debtNetted: 0,
      creatorNet: 4556,
      transferAmount: 4556,
      status: 'READY',
      estimatedArrival: new Date('2026-11-20T00:00:00Z'),
    });
  });

  it('UNA vez por venta: reentregas y llamadas a la vez no repiten el aviso', async () => {
    const s = sale(A);
    const id = s['id'] as string;
    const outcomes = await Promise.all([
      notices.notify(A, id),
      notices.notify(A, id),
      notices.notify(A, id),
    ]);
    expect(outcomes.filter((o) => o === 'sent')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'already')).toHaveLength(2);
    expect(await notices.notify(A, id)).toBe('already');
    expect(await notices.sweep()).toMatchObject({ checked: 0, sent: 0 });
    expect(sent).toHaveLength(1);
  });

  it('venta de otra academia: no la ve (RLS) ni la sella', async () => {
    const s = sale(B);
    expect(await notices.notify(A, s['id'] as string)).toBe('not_found');
    expect(db.rows('modPayoutsSale', { id: s['id'] })[0]!['creatorNotifiedAt']).toBeNull();
    expect(sent).toEqual([]);
  });

  it('membresía: el primer cobro es un alta y el siguiente de la misma suscripción, una renovación', async () => {
    const first = invoiceSale(A, 'sub_1', NOW - 30 * 86_400_000);
    const renewal = invoiceSale(A, 'sub_1', NOW);
    const other = invoiceSale(A, 'sub_2', NOW);
    await notices.notify(A, renewal['id'] as string);
    await notices.notify(A, first['id'] as string);
    await notices.notify(A, other['id'] as string);
    expect(sent.map((n) => [n.saleId, n.kind])).toEqual([
      [renewal['id'], 'renewal'],
      [first['id'], 'membership'],
      [other['id'], 'membership'],
    ]);
  });

  it('con los datos fiscales sin completar, el aviso lo dice (la venta queda retenida)', async () => {
    taxBlocked = true;
    const s = sale(A);
    await notices.notify(A, s['id'] as string);
    expect(sent[0]).toMatchObject({ heldForTaxData: true });
  });

  it('si el correo falla, la venta queda sellada igual: nunca dos avisos', async () => {
    notices = new PayoutsSaleNoticesService(db.port(), {
      notifier: {
        ...notifier,
        saleMade: async () => {
          throw new Error('SMTP caído');
        },
      },
      now: () => new Date(clock),
    });
    const s = sale(A);
    expect(await notices.notify(A, s['id'] as string)).toBe('sent');
    expect(await notices.sweep()).toMatchObject({ checked: 0 });
  });
});

describe('barrido', () => {
  it('avisa de las ventas del último día sin sello, de todas las aulas; las viejas no', async () => {
    const recentA = sale(A);
    const recentB = sale(B);
    sale(A, { creatorNotifiedAt: new Date(NOW - 1000) }); // ya avisada
    clock = NOW - 2 * 86_400_000;
    sale(A); // de antes de que existiera el aviso: no se avisa días después
    clock = NOW;

    expect(await notices.sweep()).toEqual({ checked: 2, sent: 2, errors: 0 });
    expect(sent.map((n) => n.saleId).sort()).toEqual(
      [recentA['id'] as string, recentB['id'] as string].sort(),
    );
    expect(await notices.sweep()).toEqual({ checked: 0, sent: 0, errors: 0 });
  });
});
