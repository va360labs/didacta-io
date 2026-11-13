/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Lo que la liquidación necesita del doble de Stripe: cargos con o sin
 * `balance_transaction` y unas transferencias que se crean, se listan por
 * `transfer_group`/`destination` y se leen por id, como en Stripe.
 */

import type { InMemoryPlatformStripeClient, StripeObject } from '../../src/index.js';

export interface SeedChargeInput {
  readonly chargeId: string;
  readonly onBehalfOf: string;
  /** Importe del cargo (lo que se cobró, en la divisa del precio). */
  readonly amount: number;
  readonly currency: string;
  readonly presentment?: { amount: number; currency: string };
  /** Sin esto, el cargo nace sin `balance_transaction` (como al cobrar). */
  readonly bt?: { amount: number; fee: number; currency: string; id?: string };
  readonly transferGroup?: string;
  readonly created?: number;
}

export function seedCharge(fake: InMemoryPlatformStripeClient, input: SeedChargeInput): void {
  const btId = input.bt?.id ?? `txn_${input.chargeId.slice(3)}`;
  if (input.bt) {
    fake.seed({
      id: btId,
      object: 'balance_transaction',
      type: 'charge',
      amount: input.bt.amount,
      fee: input.bt.fee,
      net: input.bt.amount - input.bt.fee,
      currency: input.bt.currency,
      available_on: 1_763_510_400, // 2026-11-19
    });
  }
  fake.seed({
    id: input.chargeId,
    object: 'charge',
    amount: input.amount,
    currency: input.currency,
    status: 'succeeded',
    paid: true,
    amount_refunded: 0,
    refunded: false,
    disputed: false,
    livemode: false,
    created: input.created ?? 1_762_950_000,
    on_behalf_of: input.onBehalfOf,
    transfer_group: input.transferGroup ?? null,
    presentment_details: input.presentment
      ? {
          presentment_amount: input.presentment.amount,
          presentment_currency: input.presentment.currency,
        }
      : null,
    balance_transaction: input.bt ? btId : null,
  });
}

/** Stripe asienta el cargo: aparece su `balance_transaction`. */
export function settleChargeInStripe(
  fake: InMemoryPlatformStripeClient,
  chargeId: string,
  bt: { amount: number; fee: number; currency: string },
): void {
  const btId = `txn_${chargeId.slice(3)}`;
  fake.seed({
    id: btId,
    object: 'balance_transaction',
    type: 'charge',
    amount: bt.amount,
    fee: bt.fee,
    net: bt.amount - bt.fee,
    currency: bt.currency,
    available_on: 1_763_510_400,
  });
  fake.patch(chargeId, { balance_transaction: btId });
}

export interface FakeTransfers {
  readonly all: StripeObject[];
}

/** POST/GET de `/v1/transfers` como en Stripe (más nuevas primero al listar). */
export function installTransfers(
  fake: InMemoryPlatformStripeClient,
  options: { now?: () => number } = {},
): FakeTransfers {
  const all: StripeObject[] = [];
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  fake.on('POST', '/v1/transfers', (req, f) => {
    const transfer: StripeObject = {
      id: f.nextId('tr'),
      object: 'transfer',
      amount: req.params['amount'],
      amount_reversed: 0,
      currency: req.params['currency'],
      destination: req.params['destination'],
      source_transaction: req.params['source_transaction'],
      transfer_group: req.params['transfer_group'],
      metadata: req.params['metadata'] ?? {},
      balance_transaction: f.nextId('txn'),
      created: now(),
      livemode: false,
      reversed: false,
    };
    all.push(transfer);
    f.seed(transfer);
    return transfer;
  });
  fake.on('GET', '/v1/transfers', (req) => {
    const group = req.params['transfer_group'];
    const destination = req.params['destination'];
    const data = all
      .map((t) => fake.get(t['id'] as string)!)
      .filter(
        (t) =>
          (group === undefined || t['transfer_group'] === group) &&
          (destination === undefined || t['destination'] === destination),
      )
      .reverse();
    return { object: 'list', data, has_more: false };
  });
  return { all };
}
