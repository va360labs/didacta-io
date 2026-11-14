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
import {
  StripeSdkAdapter,
  toCheckoutLocale,
  type StripeAdapterOptions,
} from '../src/stripe.client.js';

const PARAMS = {
  priceId: 'price_1Abc',
  successUrl: 'https://aula.test/courses/checkout/success?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://aula.test/courses/checkout/cancel',
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
  success_url: 'https://aula.test/courses/checkout/success?session_id={CHECKOUT_SESSION_ID}',
  cancel_url: 'https://aula.test/courses/checkout/cancel',
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

function captureEmbedded(
  options?: StripeAdapterOptions,
  clientSecret: string | null = 'cs_test_1_secret_x',
) {
  const calls: Array<Record<string, unknown>> = [];
  class FakeStripe {
    checkout = {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          return {
            id: 'cs_test_1',
            url: null,
            client_secret: clientSecret,
            amount_total: 100,
            currency: 'eur',
          };
        },
        retrieve: async (id: string) => ({
          id,
          status: 'complete',
          payment_status: 'paid',
          metadata: { tenantId: 't1' },
          amount_total: 100,
          currency: 'eur',
          created: 1_794_000_000,
        }),
      },
    };
  }
  const adapter = new StripeSdkAdapter('sk_test_x', 'whsec_x', FakeStripe as never, options ?? {});
  return { adapter, calls };
}

const RETURN_URL =
  'https://aula.test/catalog/checkout/success?session_id={CHECKOUT_SESSION_ID}&checkout=embedded';

describe('StripeSdkAdapter.createCheckoutSession — pago embebido en la ficha del aula', () => {
  it('ui_mode embedded + return_url, sin success/cancel, y devuelve el secreto (no URL)', async () => {
    const { adapter, calls } = captureEmbedded();
    const result = await adapter.createCheckoutSession({
      ...PARAMS,
      uiMode: 'embedded',
      returnUrl: RETURN_URL,
      locale: 'pt-BR',
    });
    expect(result).toEqual({
      id: 'cs_test_1',
      url: null,
      clientSecret: 'cs_test_1_secret_x',
      amountTotal: 100,
      currency: 'eur',
    });
    const sent = calls[0]!;
    expect(sent['ui_mode']).toBe('embedded');
    expect(sent['return_url']).toBe(RETURN_URL);
    expect(sent['locale']).toBe('pt-BR');
    expect(sent).not.toHaveProperty('success_url');
    expect(sent).not.toHaveProperty('cancel_url');
    // Lo demás, igual que en el alojado: misma entrega por el mismo webhook.
    expect(sent['client_reference_id']).toBe(PARAMS.metadata.orderId);
    expect(sent['metadata']).toEqual(PARAMS.metadata);
    expect(sent['payment_intent_data']).toEqual({ metadata: PARAMS.metadata });
  });

  it('con Connect conserva on_behalf_of y transfer_group (cobro y transferencia separados)', async () => {
    const { adapter, calls } = captureEmbedded({
      connect: { onBehalfOf: 'acct_1Creador' },
      promotionCodes: 'deny',
    });
    await adapter.createCheckoutSession({ ...PARAMS, uiMode: 'embedded', returnUrl: RETURN_URL });
    expect(calls[0]!['payment_intent_data']).toEqual({
      metadata: PARAMS.metadata,
      on_behalf_of: 'acct_1Creador',
      transfer_group: 'didacta_44444444-4444-4444-8444-444444444444',
    });
    expect(calls[0]).not.toHaveProperty('allow_promotion_codes');
  });

  it('sin returnUrl no llama a Stripe', async () => {
    const { adapter, calls } = captureEmbedded();
    await expect(adapter.createCheckoutSession({ ...PARAMS, uiMode: 'embedded' })).rejects.toThrow(
      /returnUrl/,
    );
    expect(calls).toHaveLength(0);
  });

  it('una sesión embebida sin client_secret es un error, no un pago sin pantalla', async () => {
    const { adapter } = captureEmbedded(undefined, null);
    await expect(
      adapter.createCheckoutSession({ ...PARAMS, uiMode: 'embedded', returnUrl: RETURN_URL }),
    ).rejects.toThrow(/client_secret/);
  });

  it('retrieveCheckoutSession devuelve solo estado, cobro y metadata', async () => {
    const { adapter } = captureEmbedded();
    await expect(adapter.retrieveCheckoutSession('cs_test_1')).resolves.toEqual({
      id: 'cs_test_1',
      status: 'complete',
      paymentStatus: 'paid',
      metadata: { tenantId: 't1' },
      amountTotal: 100,
      currency: 'eur',
      created: 1_794_000_000,
    });
  });
});

describe('toCheckoutLocale', () => {
  it('traduce los idiomas del producto y deja el resto al navegador', () => {
    expect(toCheckoutLocale('es')).toBe('es');
    expect(toCheckoutLocale('es-ES')).toBe('es');
    expect(toCheckoutLocale('en')).toBe('en');
    expect(toCheckoutLocale('pt-BR')).toBe('pt-BR');
    expect(toCheckoutLocale('pt')).toBe('pt-BR');
    expect(toCheckoutLocale('fr')).toBeUndefined();
    expect(toCheckoutLocale(undefined)).toBeUndefined();
  });
});

describe('StripeSdkAdapter.createOneOffPrice — precios extra por mercado', () => {
  function capturePrices() {
    const prices: Array<Record<string, unknown>> = [];
    class FakeStripe {
      products = { create: async () => ({ id: 'prod_1' }) };
      prices = {
        create: async (params: Record<string, unknown>) => {
          prices.push(params);
          return {
            id: 'price_1',
            unit_amount: params['unit_amount'],
            currency: params['currency'],
            active: true,
          };
        },
      };
    }
    const adapter = new StripeSdkAdapter('sk_test_x', 'whsec_x', FakeStripe as never);
    return { adapter, prices };
  }

  it('sin opciones: el Price es el de siempre (sin currency_options)', async () => {
    const { adapter, prices } = capturePrices();
    await adapter.createOneOffPrice({
      name: 'Curso',
      unitAmount: 4900,
      currency: 'eur',
      metadata: {},
    });
    expect(prices[0]).toEqual({
      product: 'prod_1',
      unit_amount: 4900,
      currency: 'eur',
      metadata: {},
    });
  });

  it('con opciones: currency_options con su unit_amount en la unidad mínima de cada moneda', async () => {
    const { adapter, prices } = capturePrices();
    await adapter.createOneOffPrice({
      name: 'Curso',
      unitAmount: 4900,
      currency: 'eur',
      currencyOptions: { mxn: 99_900, jpy: 7_900, cop: 22_900_000 },
      metadata: {},
    });
    expect(prices[0]?.['currency_options']).toEqual({
      mxn: { unit_amount: 99_900 },
      jpy: { unit_amount: 7_900 },
      cop: { unit_amount: 22_900_000 },
    });
  });
});
