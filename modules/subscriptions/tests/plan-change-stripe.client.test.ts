/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Parámetros EXACTOS que el adaptador manda a Stripe para cambiar de nivel
 * (y para su vista previa). SDK falso, sin red.
 */

import { describe, expect, it } from 'vitest';
import { SubscriptionsStripeSdkAdapter } from '../src/stripe-subscriptions.client.js';
import { MembershipPlanChangePaymentFailedError, StripeApiError } from '../src/errors.js';

interface Call {
  op: string;
  id?: string;
  params: unknown;
  opts?: unknown;
}

function fake(opts: { currentPrice?: string; updateError?: unknown } = {}) {
  const calls: Call[] = [];
  class FakeStripe {
    subscriptions = {
      retrieve: async (id: string) => {
        calls.push({ op: 'subscriptions.retrieve', id, params: null });
        return {
          id,
          customer: 'cus_1',
          status: 'active',
          current_period_end: 1_797_269_351,
          items: { data: [{ id: 'si_1', price: { id: opts.currentPrice ?? 'price_basico' } }] },
        };
      },
      update: async (id: string, params: { items: Array<{ price: string }> }, o: unknown) => {
        calls.push({ op: 'subscriptions.update', id, params, opts: o });
        if (opts.updateError) throw opts.updateError;
        return {
          id,
          status: 'active',
          current_period_end: 1_797_269_351,
          items: { data: [{ id: 'si_1', price: { id: params.items[0]!.price } }] },
          latest_invoice: {
            id: 'in_9',
            status: 'paid',
            amount_paid: 1333,
            total: 1333,
            currency: 'eur',
            billing_reason: 'subscription_update',
          },
        };
      },
    };
    invoices = {
      createPreview: async (params: unknown) => {
        calls.push({ op: 'invoices.createPreview', params });
        return { amount_due: 0, total: -667, currency: 'eur' };
      },
    };
  }
  const adapter = new SubscriptionsStripeSdkAdapter('sk_test_x', 'whsec_x', FakeStripe as never);
  return { adapter, calls };
}

const change = {
  subscriptionId: 'sub_1',
  priceId: 'price_pro',
  prorationBehavior: 'always_invoice' as const,
  metadata: { planId: 'plan_pro' },
  idempotencyKey: 'plan-change:k',
};

describe('changeSubscriptionPrice', () => {
  it('cambia el precio de la línea con error_if_incomplete, la metadata y la clave', async () => {
    const { adapter, calls } = fake();
    const res = await adapter.changeSubscriptionPrice(change);
    const update = calls.find((c) => c.op === 'subscriptions.update')!;
    expect(update.params).toEqual({
      items: [{ id: 'si_1', price: 'price_pro' }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
      metadata: { planId: 'plan_pro' },
      expand: ['latest_invoice'],
    });
    expect(update.opts).toEqual({ idempotencyKey: 'plan-change:k' });
    expect(res).toEqual({
      id: 'sub_1',
      status: 'active',
      currentPeriodEnd: 1_797_269_351,
      priceId: 'price_pro',
      latestInvoice: {
        id: 'in_9',
        status: 'paid',
        amountPaid: 1333,
        total: 1333,
        currency: 'eur',
        billingReason: 'subscription_update',
      },
    });
  });

  it('si la línea YA tiene ese precio (reintento), no vuelve a facturar', async () => {
    const { adapter, calls } = fake({ currentPrice: 'price_pro' });
    const res = await adapter.changeSubscriptionPrice(change);
    expect(calls.some((c) => c.op === 'subscriptions.update')).toBe(false);
    expect(res.priceId).toBe('price_pro');
    expect(res.latestInvoice).toBeNull();
  });

  it('tarjeta rechazada (402) → MembershipPlanChangePaymentFailedError', async () => {
    const err = Object.assign(new Error('Your card was declined.'), {
      type: 'StripeCardError',
      statusCode: 402,
      code: 'card_declined',
    });
    const { adapter } = fake({ updateError: err });
    await expect(adapter.changeSubscriptionPrice(change)).rejects.toBeInstanceOf(
      MembershipPlanChangePaymentFailedError,
    );
  });

  it('cualquier otro fallo de Stripe → StripeApiError', async () => {
    const { adapter } = fake({ updateError: new Error('No such price') });
    await expect(adapter.changeSubscriptionPrice(change)).rejects.toBeInstanceOf(StripeApiError);
  });
});

describe('previewSubscriptionPriceChange', () => {
  it('vista previa con always_invoice sobre la línea actual; total negativo = a favor', async () => {
    const { adapter, calls } = fake();
    const res = await adapter.previewSubscriptionPriceChange({
      subscriptionId: 'sub_1',
      priceId: 'price_basico_barato',
    });
    expect(calls.find((c) => c.op === 'invoices.createPreview')!.params).toEqual({
      customer: 'cus_1',
      subscription: 'sub_1',
      subscription_details: {
        items: [{ id: 'si_1', price: 'price_basico_barato' }],
        proration_behavior: 'always_invoice',
      },
    });
    expect(res).toEqual({ amountDue: 0, total: -667, currency: 'eur' });
  });
});
