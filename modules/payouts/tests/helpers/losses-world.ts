/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Lo que los caminos de vuelta del dinero (E6) necesitan del doble de Stripe,
 * con el comportamiento visto en el sandbox:
 *
 *  - `POST /v1/refunds`: el reembolso sale del cargo (sube `amount_refunded`)
 *    y no puede superar lo que queda.
 *  - `POST /v1/transfers/{id}/reversals`: revierte de la cuenta del creador;
 *    sin saldo, «does not have sufficient funds…» (400), como en el sandbox.
 *  - `GET /v1/balance` con `Stripe-Account`: el saldo de esa cuenta.
 *  - Disputas con sus `balance_transactions` (importes reales: −10000 y
 *    tasa 2000 al retirar; +10000 y −2000 de tasa al devolver).
 */

import { PlatformStripeApiError } from '../../src/errors.js';
import type { InMemoryPlatformStripeClient, StripeObject } from '../../src/index.js';

export interface FakeLossesWorld {
  readonly refunds: StripeObject[];
  readonly reversals: StripeObject[];
  /** Saldo (disponible + pendiente) por `acct_` y divisa. Sin entrada: ilimitado. */
  readonly balances: Map<string, Record<string, number>>;
  setBalance(account: string, currency: string, amount: number): void;
}

export function installLosses(fake: InMemoryPlatformStripeClient): FakeLossesWorld {
  const refunds: StripeObject[] = [];
  const reversals: StripeObject[] = [];
  const balances = new Map<string, Record<string, number>>();

  fake.on('POST', '/v1/refunds', (req, f) => {
    const chargeId = req.params['charge'] as string;
    const charge = f.get(chargeId);
    if (!charge) throw new Error(`no existe el cargo ${chargeId}`);
    const remaining = (charge['amount'] as number) - ((charge['amount_refunded'] as number) ?? 0);
    const amount = (req.params['amount'] as number | undefined) ?? remaining;
    if (amount > remaining) {
      fail('Refund amount is greater than unrefunded amount on charge', 'invalid_request_error');
    }
    const refund: StripeObject = {
      id: `re_${f.nextId('x').slice(2)}`,
      object: 'refund',
      amount,
      currency: charge['currency'],
      charge: chargeId,
      status: 'succeeded',
      reason: req.params['reason'] ?? null,
      metadata: req.params['metadata'] ?? {},
      balance_transaction: null,
      livemode: false,
      created: 1_762_960_000,
    };
    refunds.push(refund);
    f.seed(refund);
    const refunded = ((charge['amount_refunded'] as number) ?? 0) + amount;
    f.patch(chargeId, {
      amount_refunded: refunded,
      refunded: refunded >= (charge['amount'] as number),
    });
    return refund;
  });
  fake.on('GET', '/v1/refunds', (req, f) => {
    const charge = req.params['charge'];
    const data = refunds
      .map((r) => f.get(r['id'] as string)!)
      .filter((r) => charge === undefined || r['charge'] === charge)
      .reverse();
    return { object: 'list', data, has_more: false };
  });

  fake.on('GET', '/v1/transfers/:id/reversals', (req) => ({
    object: 'list',
    data: reversals.filter((r) => r['transfer'] === req.pathParams['id']).reverse(),
    has_more: false,
  }));
  fake.on('POST', '/v1/transfers/:id/reversals', (req, f) => {
    const transferId = req.pathParams['id']!;
    const transfer = f.get(transferId);
    if (!transfer) throw new Error(`no existe la transferencia ${transferId}`);
    const amount = req.params['amount'] as number;
    const left = (transfer['amount'] as number) - ((transfer['amount_reversed'] as number) ?? 0);
    const account = transfer['destination'] as string;
    const currency = transfer['currency'] as string;
    if (amount > left) {
      fail(
        'Transfer reversal amount exceeds the remaining transferable amount.',
        'invalid_request_error',
      );
    }
    const balance = balances.get(account);
    if (balance && (balance[currency] ?? 0) < amount) {
      fail(
        `The account ${account} does not have sufficient funds to reverse this transfer.`,
        'invalid_request_error',
        'balance_insufficient',
      );
    }
    if (balance) balance[currency] = (balance[currency] ?? 0) - amount;
    const reversal: StripeObject = {
      id: `trr_${f.nextId('x').slice(2)}`,
      object: 'transfer_reversal',
      amount,
      currency,
      transfer: transferId,
      metadata: req.params['metadata'] ?? {},
    };
    reversals.push(reversal);
    f.patch(transferId, {
      amount_reversed: ((transfer['amount_reversed'] as number) ?? 0) + amount,
      reversed: amount === left,
    });
    return reversal;
  });

  fake.on('GET', '/v1/balance', (req) => {
    const account = req.options.account ?? '';
    const balance = balances.get(account);
    const rows = balance
      ? Object.entries(balance).map(([currency, amount]) => ({ amount, currency }))
      : [{ amount: 1_000_000_000, currency: 'eur' }];
    return { object: 'balance', available: rows, pending: [] };
  });

  return {
    refunds,
    reversals,
    balances,
    setBalance(account, currency, amount) {
      const entry = balances.get(account) ?? {};
      entry[currency] = amount;
      balances.set(account, entry);
    },
  };
}

/** Error de Stripe desde un handler del doble (como un 400 de la API). */
function fail(message: string, type: string, code?: string): never {
  throw new PlatformStripeApiError(message, {
    status: 400,
    type,
    stripeCode: code,
    operation: 'POST (doble)',
  });
}

/** Una disputa como la devuelve `GET /v1/disputes/{id}` (con sus movimientos). */
export function seedDispute(
  fake: InMemoryPlatformStripeClient,
  input: {
    readonly id: string;
    readonly chargeId: string;
    readonly amount: number;
    readonly currency: string;
    readonly status: string;
    readonly dueBy?: number;
    readonly withdrawn?: { amount: number; fee: number; currency: string };
    readonly reinstated?: { amount: number; fee: number; currency: string };
  },
): void {
  const bts: StripeObject[] = [];
  if (input.withdrawn) {
    bts.push({
      id: `txn_w_${input.id}`,
      object: 'balance_transaction',
      amount: -input.withdrawn.amount,
      fee: input.withdrawn.fee,
      net: -input.withdrawn.amount - input.withdrawn.fee,
      currency: input.withdrawn.currency,
      type: 'adjustment',
      reporting_category: 'dispute',
    });
  }
  if (input.reinstated) {
    bts.push({
      id: `txn_r_${input.id}`,
      object: 'balance_transaction',
      amount: input.reinstated.amount,
      fee: -input.reinstated.fee,
      net: input.reinstated.amount + input.reinstated.fee,
      currency: input.reinstated.currency,
      type: 'adjustment',
      reporting_category: 'dispute_reversal',
    });
  }
  fake.seed({
    id: input.id,
    object: 'dispute',
    amount: input.amount,
    currency: input.currency,
    charge: input.chargeId,
    status: input.status,
    reason: 'fraudulent',
    livemode: false,
    evidence_details: { due_by: input.dueBy ?? 1_763_769_600 },
    balance_transactions: bts,
  });
}
