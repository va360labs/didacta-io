/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Parámetros EXACTOS que `StripeSdkAdapter` manda a Stripe al crear la sesión
 * de checkout. Se captura lo que recibe `checkout.sessions.create` con un SDK
 * falso (sin red).
 *
 * El primer bloque es la instantánea de lo de siempre (el tenant cobra en su
 * cuenta): la opción de Connect no puede cambiar ni un byte de esa llamada.
 */

import { describe, expect, it } from 'vitest';
import { StripeSdkAdapter, type StripeAdapterOptions } from '../src/stripe.client.js';

const PARAMS = {
  priceId: 'price_1Abc',
  successUrl: 'https://aula.test/cursos/checkout/success?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://aula.test/cursos/checkout/cancel',
  customerEmail: 'alumna@example.com',
  allowPromotionCodes: true,
  metadata: {
    tenantId: '11111111-1111-4111-8111-111111111111',
    courseId: '22222222-2222-4222-8222-222222222222',
    productId: '33333333-3333-4333-8333-333333333333',
    orderId: '44444444-4444-4444-8444-444444444444',
    userId: '55555555-5555-4555-8555-555555555555',
  },
};

function captureCreate(options?: StripeAdapterOptions) {
  const calls: unknown[] = [];
  const configs: unknown[] = [];
  class FakeStripe {
    checkout = {
      sessions: {
        create: async (params: unknown) => {
          calls.push(params);
          return { id: 'cs_test_1', url: 'https://checkout.stripe.test/cs_test_1' };
        },
      },
    };
    constructor(_key: string, config: unknown) {
      configs.push(config);
    }
  }
  const adapter =
    options === undefined
      ? new StripeSdkAdapter('sk_test_x', 'whsec_x', FakeStripe as never)
      : new StripeSdkAdapter('sk_test_x', 'whsec_x', FakeStripe as never, options);
  return { adapter, calls, configs };
}

/**
 * Lo que el adaptador mandaba ANTES de existir la opción de Connect, literal y
 * en el mismo orden de claves (se comprobó ejecutando este fichero contra el
 * `stripe.client.ts` anterior al cambio).
 */
const OWN_SNAPSHOT = JSON.stringify({
  mode: 'payment',
  line_items: [{ price: 'price_1Abc', quantity: 1 }],
  success_url: 'https://aula.test/cursos/checkout/success?session_id={CHECKOUT_SESSION_ID}',
  cancel_url: 'https://aula.test/cursos/checkout/cancel',
  customer_email: 'alumna@example.com',
  allow_promotion_codes: true,
  client_reference_id: '44444444-4444-4444-8444-444444444444',
  metadata: PARAMS.metadata,
  payment_intent_data: { metadata: PARAMS.metadata },
});

describe('StripeSdkAdapter.createCheckoutSession — modo propio (instantánea)', () => {
  it('sin opciones: los parámetros son byte a byte los de siempre', async () => {
    const { adapter, calls, configs } = captureCreate();
    await adapter.createCheckoutSession(PARAMS);
    expect(JSON.stringify(calls[0])).toBe(OWN_SNAPSHOT);
    expect(configs[0]).toEqual({
      apiVersion: '2024-12-18.acacia',
      timeout: 10_000,
      maxNetworkRetries: 1,
    });
  });

  it('con opciones vacías o con promociones permitidas: idéntico', async () => {
    const variants: StripeAdapterOptions[] = [{}, { promotionCodes: 'allow' }];
    for (const options of variants) {
      const { adapter, calls } = captureCreate(options);
      await adapter.createCheckoutSession(PARAMS);
      expect(JSON.stringify(calls[0])).toBe(OWN_SNAPSHOT);
    }
  });

  it('sin allowPromotionCodes el servicio no pide códigos y no se mandan', async () => {
    const { adapter, calls } = captureCreate();
    await adapter.createCheckoutSession({ ...PARAMS, allowPromotionCodes: false });
    expect(calls[0]).not.toHaveProperty('allow_promotion_codes');
  });
});

describe('StripeSdkAdapter.createCheckoutSession — cuenta compartida (Connect)', () => {
  it('lleva on_behalf_of y transfer_group en el PaymentIntent y no allow_promotion_codes', async () => {
    const { adapter, calls } = captureCreate({
      connect: { onBehalfOf: 'acct_1Creador' },
      promotionCodes: 'deny',
    });
    await adapter.createCheckoutSession(PARAMS);
    const sent = calls[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('allow_promotion_codes');
    expect(sent['payment_intent_data']).toEqual({
      metadata: PARAMS.metadata,
      on_behalf_of: 'acct_1Creador',
      transfer_group: 'didacta_44444444-4444-4444-8444-444444444444',
    });
    // Todo lo demás, igual que en modo propio.
    const own = JSON.parse(OWN_SNAPSHOT) as Record<string, unknown>;
    delete own['allow_promotion_codes'];
    delete own['payment_intent_data'];
    const rest = { ...sent };
    delete rest['payment_intent_data'];
    expect(rest).toEqual(own);
  });

  it('`deny` sin Connect solo quita los códigos', async () => {
    const { adapter, calls } = captureCreate({ promotionCodes: 'deny' });
    await adapter.createCheckoutSession(PARAMS);
    const sent = calls[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('allow_promotion_codes');
    expect(sent['payment_intent_data']).toEqual({ metadata: PARAMS.metadata });
  });
});
