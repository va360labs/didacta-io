/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import {
  resolvePlatformEventTenant,
  routePlatformEvent,
  stripeIdsNamedByEvent,
  subscriptionIdFromInvoice,
} from '../src/event-router.js';
import type { TenantResolution } from '../src/refs.service.js';
import { InMemoryPlatformStripeClient } from '../src/stripe/platform-stripe.fake.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function event(type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id: 'evt_1', type, livemode: false, data: { object }, ...extra };
}

describe('routePlatformEvent — ids por tipo (tabla del plan)', () => {
  it('checkout.session.*: la sesión primero, luego PaymentIntent, suscripción y cliente', () => {
    for (const type of [
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'checkout.session.async_payment_failed',
      'checkout.session.expired',
    ]) {
      expect(
        routePlatformEvent(
          event(type, { id: 'cs_test_1', payment_intent: 'pi_1', customer: 'cus_1' }),
        ),
      ).toEqual({
        kind: 'objects',
        family: 'checkout_session',
        primaryId: 'cs_test_1',
        objectIds: ['cs_test_1', 'pi_1', 'cus_1'],
        paymentIntentId: 'pi_1',
        subscriptionId: null,
      });
    }
  });

  it('suscripción, factura (con su suscripción en las tres formas), cargo, reembolso, disputa, transferencia', () => {
    expect(
      routePlatformEvent(
        event('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1' }),
      ),
    ).toMatchObject({
      family: 'subscription',
      objectIds: ['sub_1', 'cus_1'],
      subscriptionId: 'sub_1',
    });
    expect(
      routePlatformEvent(
        event('invoice.paid', {
          id: 'in_1',
          customer: 'cus_1',
          parent: { subscription_details: { subscription: 'sub_1' } },
        }),
      ),
    ).toMatchObject({ family: 'invoice', objectIds: ['in_1', 'sub_1', 'cus_1'] });
    expect(
      routePlatformEvent(
        event('charge.updated', { id: 'ch_1', payment_intent: 'pi_1', customer: null }),
      ),
    ).toMatchObject({ family: 'charge', objectIds: ['ch_1', 'pi_1'], paymentIntentId: 'pi_1' });
    expect(
      routePlatformEvent(
        event('refund.created', { id: 're_1', charge: 'ch_1', payment_intent: 'pi_1' }),
      ),
    ).toMatchObject({ family: 'refund', objectIds: ['re_1', 'ch_1', 'pi_1'] });
    expect(
      routePlatformEvent(
        event('charge.dispute.created', { id: 'du_1', charge: 'ch_1', payment_intent: 'pi_1' }),
      ),
    ).toMatchObject({ family: 'dispute', objectIds: ['du_1', 'ch_1', 'pi_1'] });
    expect(
      routePlatformEvent(
        event('transfer.created', {
          id: 'tr_1',
          source_transaction: 'ch_1',
          destination: 'acct_1Abcdef',
        }),
      ),
    ).toMatchObject({ family: 'transfer', objectIds: ['tr_1', 'ch_1', 'acct_1Abcdef'] });
    expect(
      routePlatformEvent(event('payout.failed', { id: 'po_1' }, { account: 'acct_1Abcdef' })),
    ).toMatchObject({ family: 'payout', objectIds: ['acct_1Abcdef'] });
  });

  it('eventos de cuenta → account; tipos desconocidos → unknown; ids con forma rara se ignoran', () => {
    expect(
      routePlatformEvent(
        event('account.updated', { id: 'acct_1Abcdef' }, { account: 'acct_1Abcdef' }),
      ),
    ).toEqual({ kind: 'account', accountId: 'acct_1Abcdef' });
    expect(routePlatformEvent(event('payment_method.attached', { id: 'pm_1' }))).toEqual({
      kind: 'unknown',
    });
    expect(
      routePlatformEvent(event('charge.updated', { id: "ch_1'; DROP", payment_intent: 'pi_1' })),
    ).toMatchObject({ primaryId: null, objectIds: ['pi_1'] });
  });

  it('subscriptionIdFromInvoice: la forma clásica, la de parent y la de las líneas', () => {
    expect(subscriptionIdFromInvoice({ subscription: 'sub_a' })).toBe('sub_a');
    expect(
      subscriptionIdFromInvoice({ parent: { subscription_details: { subscription: 'sub_b' } } }),
    ).toBe('sub_b');
    expect(
      subscriptionIdFromInvoice({
        lines: { data: [{ parent: { subscription_item_details: { subscription: 'sub_c' } } }] },
      }),
    ).toBe('sub_c');
    expect(subscriptionIdFromInvoice({})).toBeNull();
  });

  it('stripeIdsNamedByEvent cubre también tipos que el webhook de plataforma no atiende', () => {
    expect(
      stripeIdsNamedByEvent(
        event('payment_intent.succeeded', { id: 'pi_9', customer: 'cus_9', latest_charge: 'ch_9' }),
      ).sort(),
    ).toEqual(['ch_9', 'cus_9', 'pi_9']);
  });
});

describe('resolvePlatformEventTenant — solo desde el registro', () => {
  function refs(direct: Record<string, string>, byParent: Record<string, string> = {}) {
    const resolve =
      (map: Record<string, string>) =>
      async (ids: ReadonlyArray<string | null | undefined>): Promise<TenantResolution> => {
        const tenants = [
          ...new Set(ids.filter((id): id is string => !!id && !!map[id]).map((id) => map[id]!)),
        ].sort();
        if (tenants.length === 0) return { status: 'unknown' };
        if (tenants.length > 1) return { status: 'ambiguous', tenantIds: tenants, refs: [] };
        return { status: 'resolved', tenantId: tenants[0]!, refs: [] };
      };
    return { resolveTenant: resolve(direct), resolveTenantByParents: resolve(byParent) };
  }

  const charge = routePlatformEvent(
    event('charge.updated', { id: 'ch_1', payment_intent: 'pi_1' }),
  );
  if (charge.kind !== 'objects') throw new Error('ruta inesperada');

  it('directo', async () => {
    const stripe = new InMemoryPlatformStripeClient();
    expect(
      await resolvePlatformEventTenant(charge, { refs: refs({ pi_1: A }), stripe }),
    ).toMatchObject({ status: 'resolved', tenantId: A, via: 'direct' });
    expect(stripe.calls).toHaveLength(0);
  });

  it('por los padres', async () => {
    const stripe = new InMemoryPlatformStripeClient();
    expect(
      await resolvePlatformEventTenant(charge, { refs: refs({}, { pi_1: A }), stripe }),
    ).toMatchObject({ status: 'resolved', tenantId: A, via: 'parent' });
    expect(stripe.calls).toHaveLength(0);
  });

  it('preguntando a Stripe por la sesión de origen y mirando el registro de ESA sesión', async () => {
    const stripe = new InMemoryPlatformStripeClient().on('GET', '/v1/checkout/sessions', (req) => {
      expect(req.params).toEqual({ payment_intent: 'pi_1', limit: 1 });
      return { object: 'list', data: [{ id: 'cs_test_origen' }] };
    });
    expect(
      await resolvePlatformEventTenant(charge, { refs: refs({ cs_test_origen: B }), stripe }),
    ).toMatchObject({ status: 'resolved', tenantId: B, via: 'origin_session' });
  });

  it('sesión de origen que tampoco está registrada → unknown; ids de dos tenants → ambiguous', async () => {
    const stripe = new InMemoryPlatformStripeClient().on('GET', '/v1/checkout/sessions', () => ({
      object: 'list',
      data: [{ id: 'cs_test_ajena' }],
    }));
    expect(await resolvePlatformEventTenant(charge, { refs: refs({}), stripe })).toEqual({
      status: 'unknown',
    });
    expect(
      await resolvePlatformEventTenant(charge, { refs: refs({ ch_1: A, pi_1: B }), stripe }),
    ).toEqual({ status: 'ambiguous', tenantIds: [A, B].sort() });
  });

  it('un evento de sesión no consulta a Stripe: la sesión ES el origen', async () => {
    const session = routePlatformEvent(
      event('checkout.session.completed', { id: 'cs_test_x', payment_intent: 'pi_x' }),
    );
    if (session.kind !== 'objects') throw new Error('ruta inesperada');
    const stripe = new InMemoryPlatformStripeClient();
    expect(await resolvePlatformEventTenant(session, { refs: refs({}), stripe })).toEqual({
      status: 'unknown',
    });
    expect(stripe.calls).toHaveLength(0);
  });
});
