/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Parámetros EXACTOS que el adaptador manda a Stripe para la oferta al darse
 * de baja (pausa y cupón de retención). SDK falso, sin red.
 */

import { describe, expect, it } from 'vitest';
import { SubscriptionsStripeSdkAdapter } from '../src/stripe-subscriptions.client.js';
import { StripeApiError } from '../src/errors.js';

interface Call {
  op: string;
  id?: string;
  params: unknown;
  opts?: unknown;
}

function fake(subAfterUpdate: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  class FakeStripe {
    subscriptions = {
      retrieve: async (id: string) => {
        calls.push({ op: 'subscriptions.retrieve', id, params: null });
        return {
          id,
          status: 'active',
          cancel_at_period_end: false,
          current_period_start: 1_794_677_351,
          current_period_end: 1_797_269_351,
          items: { data: [{ price: { recurring: { interval: 'month', interval_count: 1 } } }] },
          pause_collection: null,
          discount: null,
          discounts: [],
        };
      },
      update: async (id: string, params: unknown, opts: unknown) => {
        calls.push({ op: 'subscriptions.update', id, params, opts });
        return {
          id,
          status: 'active',
          cancel_at_period_end: false,
          current_period_end: 1_797_269_351,
          ...subAfterUpdate,
        };
      },
    };
    coupons = {
      create: async (params: unknown, opts: unknown) => {
        calls.push({ op: 'coupons.create', params, opts });
        return { id: 'coupon_ret_1' };
      },
    };
  }
  const adapter = new SubscriptionsStripeSdkAdapter('sk_test_x', 'whsec_x', FakeStripe as never);
  return { adapter, calls };
}

describe('retrieveSubscription', () => {
  it('lee periodo, meses por cobro, pausa y descuento', async () => {
    const { adapter } = fake();
    const d = await adapter.retrieveSubscription('sub_1');
    expect(d).toEqual({
      id: 'sub_1',
      status: 'active',
      cancelAtPeriodEnd: false,
      currentPeriodStart: 1_794_677_351,
      currentPeriodEnd: 1_797_269_351,
      intervalMonths: 1,
      pauseCollection: null,
      hasDiscount: false,
    });
  });
});

describe('pauseCollection', () => {
  it('anula las facturas hasta resumes_at, con clave de idempotencia', async () => {
    const { adapter, calls } = fake({
      pause_collection: { behavior: 'void', resumes_at: 1_802_539_751 },
    });
    const d = await adapter.pauseCollection({
      subscriptionId: 'sub_1',
      resumesAt: 1_802_539_751,
      idempotencyKey: 'retention-pause:abc:1',
    });
    expect(calls).toEqual([
      {
        op: 'subscriptions.update',
        id: 'sub_1',
        params: { pause_collection: { behavior: 'void', resumes_at: 1_802_539_751 } },
        opts: { idempotencyKey: 'retention-pause:abc:1' },
      },
    ]);
    expect(d.pauseCollection).toEqual({ behavior: 'void', resumesAt: 1_802_539_751 });
  });

  it('una fecha no válida no llega a Stripe', async () => {
    const { adapter, calls } = fake();
    await expect(
      adapter.pauseCollection({ subscriptionId: 'sub_1', resumesAt: 0, idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(StripeApiError);
    expect(calls).toHaveLength(0);
  });
});

describe('applyRetentionDiscount', () => {
  it('cupón de UN SOLO USO por aceptación y aplicado sin prorrateo', async () => {
    const { adapter, calls } = fake({
      discount: { coupon: { id: 'coupon_ret_1' }, end: 1_802_539_751 },
      discounts: ['di_1'],
    });
    const r = await adapter.applyRetentionDiscount({
      subscriptionId: 'sub_1',
      percentOff: 30,
      duration: 'repeating',
      durationInMonths: 3,
      name: '-30% · 3m',
      metadata: { didacta: 'retention', exitId: 'e1' },
      idempotencyKey: 'retention-discount:e1',
    });
    expect(calls).toEqual([
      {
        op: 'coupons.create',
        params: {
          percent_off: 30,
          duration: 'repeating',
          duration_in_months: 3,
          max_redemptions: 1,
          name: '-30% · 3m',
          metadata: { didacta: 'retention', exitId: 'e1' },
        },
        opts: { idempotencyKey: 'retention-discount:e1:coupon' },
      },
      {
        op: 'subscriptions.update',
        id: 'sub_1',
        params: { discounts: [{ coupon: 'coupon_ret_1' }], proration_behavior: 'none' },
        opts: { idempotencyKey: 'retention-discount:e1:subscription' },
      },
    ]);
    expect(r).toEqual({ couponId: 'coupon_ret_1', discountEnd: 1_802_539_751 });
  });

  it('`once` no manda meses; sin fecha de fin legible devuelve null', async () => {
    const { adapter, calls } = fake();
    const r = await adapter.applyRetentionDiscount({
      subscriptionId: 'sub_2',
      percentOff: 50,
      duration: 'once',
      name: '-50%',
      metadata: {},
      idempotencyKey: 'k',
    });
    expect((calls[0]!.params as Record<string, unknown>)['duration_in_months']).toBeUndefined();
    expect((calls[0]!.params as Record<string, unknown>)['duration']).toBe('once');
    expect(r.discountEnd).toBeNull();
  });

  it('nunca un 100 % ni un repeating sin meses', async () => {
    const { adapter, calls } = fake();
    await expect(
      adapter.applyRetentionDiscount({
        subscriptionId: 's',
        percentOff: 100,
        duration: 'once',
        name: 'x',
        metadata: {},
        idempotencyKey: 'k',
      }),
    ).rejects.toBeInstanceOf(StripeApiError);
    await expect(
      adapter.applyRetentionDiscount({
        subscriptionId: 's',
        percentOff: 30,
        duration: 'repeating',
        name: 'x',
        metadata: {},
        idempotencyKey: 'k',
      }),
    ).rejects.toBeInstanceOf(StripeApiError);
    expect(calls).toHaveLength(0);
  });
});
