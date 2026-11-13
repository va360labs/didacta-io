/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Parámetros EXACTOS que `SubscriptionsStripeSdkAdapter` manda a Stripe al
 * crear la sesión de checkout de una suscripción y la del portal de cliente.
 * Se captura lo que recibe el SDK con uno falso (sin red).
 *
 * El primer bloque es la instantánea de lo de siempre (el tenant cobra en su
 * cuenta): la opción de Connect no puede cambiar ni un byte de esa llamada.
 */

import { describe, expect, it } from 'vitest';
import {
  SubscriptionsStripeSdkAdapter,
  type SubscriptionsStripeAdapterOptions,
} from '../src/stripe-subscriptions.client.js';

const METADATA = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  membership: '1',
  planId: '22222222-2222-4222-8222-222222222222',
  locale: 'es',
};

const PARAMS = {
  priceId: 'price_1Abc',
  successUrl: 'https://aula.test/join?status=success',
  cancelUrl: 'https://aula.test/join?status=cancel',
  customerEmail: 'alumna@example.com',
  trialDays: 7,
  allowPromotionCodes: true,
  clientReferenceId: '22222222-2222-4222-8222-222222222222',
  metadata: METADATA,
};

function capture(options?: SubscriptionsStripeAdapterOptions) {
  const sessions: unknown[] = [];
  const portals: unknown[] = [];
  const configs: unknown[] = [];
  class FakeStripe {
    checkout = {
      sessions: {
        create: async (params: unknown) => {
          sessions.push(params);
          return { id: 'cs_test_1', url: 'https://checkout.stripe.test/cs_test_1' };
        },
      },
    };
    billingPortal = {
      sessions: {
        create: async (params: unknown) => {
          portals.push(params);
          return { id: 'bps_1', url: 'https://billing.stripe.test/p/session/x' };
        },
      },
    };
    constructor(_key: string, config: unknown) {
      configs.push(config);
    }
  }
  const adapter =
    options === undefined
      ? new SubscriptionsStripeSdkAdapter('sk_test_x', 'whsec_x', FakeStripe as never)
      : new SubscriptionsStripeSdkAdapter('sk_test_x', 'whsec_x', FakeStripe as never, options);
  return { adapter, sessions, portals, configs };
}

/**
 * Lo que el adaptador mandaba ANTES de existir la opción de Connect, literal y
 * en el mismo orden de claves (se comprobó ejecutando este bloque contra el
 * `stripe-subscriptions.client.ts` anterior al cambio).
 */
const OWN_SNAPSHOT = JSON.stringify({
  mode: 'subscription',
  line_items: [{ price: 'price_1Abc', quantity: 1 }],
  success_url: 'https://aula.test/join?status=success',
  cancel_url: 'https://aula.test/join?status=cancel',
  customer_email: 'alumna@example.com',
  client_reference_id: '22222222-2222-4222-8222-222222222222',
  allow_promotion_codes: true,
  metadata: METADATA,
  subscription_data: { metadata: METADATA, trial_period_days: 7 },
});

describe('SubscriptionsStripeSdkAdapter.createCheckoutSession — modo propio (instantánea)', () => {
  it('sin opciones: los parámetros son byte a byte los de siempre', async () => {
    const { adapter, sessions, configs } = capture();
    await adapter.createCheckoutSession(PARAMS);
    expect(JSON.stringify(sessions[0])).toBe(OWN_SNAPSHOT);
    expect(configs[0]).toEqual({
      apiVersion: '2024-12-18.acacia',
      timeout: 10_000,
      maxNetworkRetries: 1,
    });
  });

  it('con opciones vacías o con promociones permitidas: idéntico', async () => {
    for (const options of [{}, { promotionCodes: 'allow' }] as const) {
      const { adapter, sessions } = capture(options);
      await adapter.createCheckoutSession(PARAMS);
      expect(JSON.stringify(sessions[0])).toBe(OWN_SNAPSHOT);
    }
  });

  it('sin prueba ni códigos: ni trial_period_days ni allow_promotion_codes', async () => {
    const { adapter, sessions } = capture();
    await adapter.createCheckoutSession({ ...PARAMS, trialDays: 0, allowPromotionCodes: false });
    const sent = sessions[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('allow_promotion_codes');
    expect(sent['subscription_data']).toEqual({ metadata: METADATA });
  });
});

describe('SubscriptionsStripeSdkAdapter.createCheckoutSession — cuenta compartida (Connect)', () => {
  it('lleva subscription_data.on_behalf_of y no allow_promotion_codes; lo demás, igual', async () => {
    const { adapter, sessions } = capture({
      connect: { onBehalfOf: 'acct_1Creador' },
      promotionCodes: 'deny',
    });
    await adapter.createCheckoutSession(PARAMS);
    const sent = sessions[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('allow_promotion_codes');
    expect(sent['subscription_data']).toEqual({
      metadata: METADATA,
      trial_period_days: 7,
      on_behalf_of: 'acct_1Creador',
    });
    // Nunca comisión de aplicación ni transfer_data: el reparto se hace factura
    // a factura con una transferencia aparte (y con ellos Adaptive Pricing y
    // `currency_options` dejarían de funcionar).
    expect(JSON.stringify(sent)).not.toMatch(/application_fee|transfer_data/);
    const own = JSON.parse(OWN_SNAPSHOT) as Record<string, unknown>;
    delete own['allow_promotion_codes'];
    delete own['subscription_data'];
    const rest = { ...sent };
    delete rest['subscription_data'];
    expect(rest).toEqual(own);
  });

  it('`deny` sin Connect solo quita los códigos', async () => {
    const { adapter, sessions } = capture({ promotionCodes: 'deny' });
    await adapter.createCheckoutSession(PARAMS);
    const sent = sessions[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('allow_promotion_codes');
    expect(sent['subscription_data']).toEqual({ metadata: METADATA, trial_period_days: 7 });
  });
});

describe('SubscriptionsStripeSdkAdapter.createPortalSession', () => {
  it('modo propio: el cliente y la vuelta, con la configuración por defecto de la cuenta', async () => {
    const { adapter, portals } = capture();
    const result = await adapter.createPortalSession({
      customerId: 'cus_Alumna',
      returnUrl: 'https://aula.test/account?tab=subscription',
    });
    expect(result).toEqual({ url: 'https://billing.stripe.test/p/session/x' });
    expect(portals[0]).toEqual({
      customer: 'cus_Alumna',
      return_url: 'https://aula.test/account?tab=subscription',
    });
  });

  it('cuenta compartida: con la configuración del creador y on_behalf_of', async () => {
    const { adapter, portals } = capture({
      connect: { onBehalfOf: 'acct_1Creador' },
      promotionCodes: 'deny',
    });
    await adapter.createPortalSession({
      customerId: 'cus_Alumna',
      returnUrl: 'https://aula.test/account',
      configurationId: 'bpc_1Creador',
    });
    expect(portals[0]).toEqual({
      customer: 'cus_Alumna',
      return_url: 'https://aula.test/account',
      configuration: 'bpc_1Creador',
      on_behalf_of: 'acct_1Creador',
    });
  });
});

describe('SubscriptionsStripeSdkAdapter.createRecurringPrice — precios extra por mercado', () => {
  function capturePrices() {
    const prices: Array<Record<string, unknown>> = [];
    class FakeStripe {
      prices = {
        create: async (params: Record<string, unknown>) => {
          prices.push(params);
          return { id: 'price_1' };
        },
      };
    }
    const adapter = new SubscriptionsStripeSdkAdapter('sk_test_x', 'whsec_x', FakeStripe as never);
    return { adapter, prices };
  }
  const base = {
    productId: 'prod_1',
    amountCents: 2_900,
    currency: 'eur',
    intervalMonths: 1,
    metadata: {},
  };

  it('sin opciones: el Price de siempre, sin currency_options', async () => {
    const { adapter, prices } = capturePrices();
    await adapter.createRecurringPrice(base);
    expect(prices[0]).not.toHaveProperty('currency_options');
    expect(prices[0]).toMatchObject({ unit_amount: 2_900, currency: 'eur' });
  });

  it('con opciones: currency_options con el importe en la unidad mínima de cada moneda', async () => {
    const { adapter, prices } = capturePrices();
    await adapter.createRecurringPrice({ ...base, currencyOptions: { mxn: 59_900, jpy: 4_900 } });
    expect(prices[0]?.['currency_options']).toEqual({
      mxn: { unit_amount: 59_900 },
      jpy: { unit_amount: 4_900 },
    });
  });
});

describe('saldo de cliente (descuento por referidos)', () => {
  function balanceWorld(customer: Record<string, unknown>) {
    const created: Array<{ id: string; params: unknown; options: unknown }> = [];
    class FakeStripe {
      customers = {
        retrieve: async () => customer,
        createBalanceTransaction: async (id: string, params: unknown, options: unknown) => {
          created.push({ id, params, options });
          return { id: 'cbtxn_1', object: 'customer_balance_transaction' };
        },
      };
    }
    const adapter = new SubscriptionsStripeSdkAdapter('sk_test_x', 'whsec_x', FakeStripe as never);
    return { adapter, created };
  }

  it('abona con importe NEGATIVO, la divisa en minúsculas y la clave de idempotencia', async () => {
    const { adapter, created } = balanceWorld({ id: 'cus_1', balance: 0, currency: 'eur' });
    const result = await adapter.creditCustomerBalance({
      customerId: 'cus_1',
      amountCents: 600,
      currency: 'EUR',
      description: 'Descuento por invitar',
      metadata: { didacta_referral_payout: 'p1' },
      idempotencyKey: 'referrals-credit:p1',
    });
    expect(result).toEqual({ id: 'cbtxn_1' });
    expect(created).toEqual([
      {
        id: 'cus_1',
        params: {
          amount: -600,
          currency: 'eur',
          description: 'Descuento por invitar',
          metadata: { didacta_referral_payout: 'p1' },
        },
        options: { idempotencyKey: 'referrals-credit:p1' },
      },
    ]);
  });

  it('el descuento es SALDO del cliente, no un cupón: Stripe factura la cuota entera y lo aplica como línea aparte', async () => {
    // Si el adaptador tocara la suscripción, los cupones o el precio para
    // hacer el descuento, la factura saldría por menos de la cuota. Aquí solo
    // existe el saldo del cliente: cualquier otro recurso se registra.
    const touched: string[] = [];
    const created: unknown[] = [];
    const fake = new Proxy(
      {
        customers: {
          retrieve: async () => ({ id: 'cus_1', balance: 0, currency: 'eur' }),
          createBalanceTransaction: async (_id: string, params: unknown) => {
            created.push(params);
            return { id: 'cbtxn_1', object: 'customer_balance_transaction' };
          },
        },
      },
      {
        get(target, prop: string) {
          if (prop !== 'customers' && prop !== 'then') touched.push(prop);
          return (target as Record<string, unknown>)[prop];
        },
      },
    );
    const adapter = new SubscriptionsStripeSdkAdapter(
      'sk_test_x',
      'whsec_x',
      function FakeStripe() {
        return fake;
      } as never,
    );
    await adapter.creditCustomerBalance({
      customerId: 'cus_1',
      amountCents: 600,
      currency: 'eur',
      description: 'Pago con saldo de referidos (2 comisiones)',
      metadata: {},
      idempotencyKey: 'referrals-credit:p1',
    });
    expect(created).toEqual([
      {
        amount: -600,
        currency: 'eur',
        description: 'Pago con saldo de referidos (2 comisiones)',
        metadata: {},
      },
    ]);
    expect(touched).toEqual([]);
  });

  it('nunca abona 0 ni negativos', async () => {
    const { adapter, created } = balanceWorld({ id: 'cus_1', balance: 0, currency: 'eur' });
    for (const amountCents of [0, -5, 1.5]) {
      await expect(
        adapter.creditCustomerBalance({
          customerId: 'cus_1',
          amountCents,
          currency: 'eur',
          description: 'x',
          metadata: {},
          idempotencyKey: 'k',
        }),
      ).rejects.toThrow(/abono no válido/);
    }
    expect(created).toEqual([]);
  });

  it('lee el saldo y la divisa del cliente; un cliente borrado es un error', async () => {
    expect(
      await balanceWorld({
        id: 'cus_1',
        balance: -250,
        currency: 'eur',
      }).adapter.retrieveCustomerBalance('cus_1'),
    ).toEqual({ balanceCents: -250, currency: 'eur' });
    await expect(
      balanceWorld({ id: 'cus_1', deleted: true }).adapter.retrieveCustomerBalance('cus_1'),
    ).rejects.toThrow(/borrado/);
  });
});
