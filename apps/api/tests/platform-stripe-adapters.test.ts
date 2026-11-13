/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Adaptadores de Stripe de billing/subscriptions con el modo plataforma
 * encendido (E3), la puerta de venta de los controladores de compra y el
 * cableado de `PayoutsModule`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  StripeConfigMissingError as BillingStripeConfigMissingError,
  type StripeAdapter,
  type StripeAdapterOptions,
} from '@didacta/mod-billing';
import { StripeConfigMissingError as SubscriptionsStripeConfigMissingError } from '@didacta/mod-subscriptions';
import { PayoutsNotReadyError, type RegisterObjectRefInput } from '@didacta/mod-payouts';
import { BillingPublicController } from '../src/modules/billing/billing-public.controller';
import { BillingController } from '../src/modules/billing/billing.controller';
import type { PaymentMode } from '../src/modules/payment-mode.resolver';
import { PayoutsModule } from '../src/modules/payouts/payouts.module';
import {
  PAYOUTS_NOT_READY_OFFER_REASON,
  PlatformCheckoutGate,
} from '../src/modules/payouts/platform-checkout-gate';
import { PlatformObjectGuard } from '../src/modules/payouts/platform-object-guard';
import { PAYOUTS_STATUS_BY_CODE } from '../src/modules/payouts/payouts-error.filter';
import { PlatformStripeAdapters } from '../src/modules/payouts/platform-stripe-adapters';
import { PayoutsRuntime } from '../src/modules/payouts/payouts-runtime.service';
import { fakeConsents } from './helpers/fake-purchase-consent';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWN = { secretKey: 'sk_test_propia', webhookSecret: 'whsec_propio' };
const CONFIG = {
  enabled: true,
  secretKey: 'sk_test_operador',
  livemode: false,
  webhookSecrets: ['whsec_operador'],
} as never;

/** Adaptador falso que apunta con qué clave y opciones se construyó y qué hizo. */
function fakeAdapter(
  label: string,
  log: Array<[string, string, unknown]>,
  options?: StripeAdapterOptions,
): StripeAdapter {
  return {
    createCheckoutSession: async (p) => {
      log.push([label, 'createCheckoutSession', { options, orderId: p.metadata.orderId }]);
      return { id: `cs_test_${label}`, url: `https://checkout.test/${label}` };
    },
    createOneOffPrice: async (p) => {
      log.push([label, 'createOneOffPrice', p.unitAmount]);
      return {
        id: `price_${label}`,
        productId: p.productId ?? `prod_${label}`,
        unitAmount: p.unitAmount,
        currency: p.currency,
        active: true,
      };
    },
    retrievePrice: async (id) => {
      log.push([label, 'retrievePrice', id]);
      return { id, productId: 'prod_x', unitAmount: 4900, currency: 'eur', active: true };
    },
    retrieveProduct: async (id) => {
      log.push([label, 'retrieveProduct', id]);
      return { id, name: 'Curso', active: true };
    },
    constructWebhookEvent: () => {
      throw new Error('no se usa');
    },
  };
}

function build(
  mode: PaymentMode,
  opts: { own?: boolean; registered?: string[]; registerFails?: boolean } = {},
) {
  const log: Array<[string, string, unknown]> = [];
  const registered: RegisterObjectRefInput[] = [];
  const adapters = new PlatformStripeAdapters({
    config: CONFIG,
    mode: { resolve: async () => mode },
    ownCredentials: {
      resolveTenantOnly: async () =>
        opts.own ? { credentials: OWN, source: 'tenant', verified: true } : null,
    },
    refs: {
      register: async (input) => {
        if (opts.registerFails) throw new Error('la base no contesta');
        registered.push(input);
      },
      isPlatformObject: async (id) => (opts.registered ?? []).includes(id),
    },
    buildBilling: (credentials, options) =>
      fakeAdapter(credentials.secretKey === OWN.secretKey ? 'propia' : 'plataforma', log, options),
    buildSubscriptions: (credentials) => ({ label: credentials.secretKey }) as never,
    portal: {
      forTenant: async () => {
        throw new Error('el portal no se usa en estos tests');
      },
    },
  });
  return { adapters, log, registered };
}

const SESSION = {
  priceId: 'price_x',
  successUrl: 'https://ok',
  cancelUrl: 'https://ko',
  allowPromotionCodes: true,
  metadata: { tenantId: TENANT, courseId: 'c', productId: 'p', orderId: 'orden-1' },
};

describe('PlatformStripeAdapters.billing', () => {
  it('modo propio → el adaptador de siempre, con las claves del tenant y sin opciones', async () => {
    const { adapters, log } = build({
      mode: 'own',
      credentials: { credentials: OWN, source: 'tenant', verified: true },
    });
    await (await adapters.billing(TENANT)).createCheckoutSession(SESSION);
    expect(log).toEqual([
      ['propia', 'createCheckoutSession', { options: undefined, orderId: 'orden-1' }],
    ]);
  });

  it('modo none → StripeConfigMissingError (503), como siempre', async () => {
    const { adapters } = build({ mode: 'none' });
    await expect(adapters.billing(TENANT)).rejects.toBeInstanceOf(BillingStripeConfigMissingError);
  });

  it('plataforma lista → clave del operador con on_behalf_of y sin códigos, y registra cs_ con la orden', async () => {
    const { adapters, log, registered } = build({
      mode: 'platform',
      ready: true,
      stripeAccountId: 'acct_1Creador',
      country: 'ES',
      feeBps: 500,
    });
    const session = await (await adapters.billing(TENANT)).createCheckoutSession(SESSION);
    expect(session.id).toBe('cs_test_plataforma');
    expect(log).toEqual([
      [
        'plataforma',
        'createCheckoutSession',
        {
          options: { connect: { onBehalfOf: 'acct_1Creador' }, promotionCodes: 'deny' },
          orderId: 'orden-1',
        },
      ],
    ]);
    expect(registered).toEqual([
      {
        tenantId: TENANT,
        stripeObjectId: 'cs_test_plataforma',
        kind: 'checkout_session',
        source: 'billing',
        localRef: 'orden-1',
        parentObjectId: null,
        livemode: false,
      },
    ]);
  });

  it('si el registro de la sesión falla, la compra falla (sin registro el webhook no daría acceso)', async () => {
    const { adapters } = build(
      { mode: 'platform', ready: true, stripeAccountId: 'acct_1C', country: 'ES', feeBps: 500 },
      { registerFails: true },
    );
    await expect((await adapters.billing(TENANT)).createCheckoutSession(SESSION)).rejects.toThrow(
      'la base no contesta',
    );
  });

  it('plataforma NO lista → no crea sesiones (409 PAYOUTS_NOT_READY) sin llamar a Stripe, pero sí deja preparar el catálogo', async () => {
    const { adapters, log, registered } = build({
      mode: 'platform',
      ready: false,
      reason: 'onboarding_incomplete',
    });
    const adapter = await adapters.billing(TENANT);
    const err = await adapter.createCheckoutSession(SESSION).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayoutsNotReadyError);
    expect(PAYOUTS_STATUS_BY_CODE[(err as PayoutsNotReadyError).code]).toBe(409);
    expect(log).toEqual([]);

    const price = await adapter.createOneOffPrice({
      name: 'Curso',
      unitAmount: 4900,
      currency: 'eur',
      metadata: {},
    });
    expect(price.id).toBe('price_plataforma');
    expect(registered.map((r) => [r.stripeObjectId, r.kind, r.parentObjectId])).toEqual([
      ['prod_plataforma', 'product', null],
      ['price_plataforma', 'price', 'prod_plataforma'],
    ]);
  });

  it('objetos existentes: registrados → plataforma; si no y hay claves propias → claves propias', async () => {
    const { adapters, log } = build(
      { mode: 'platform', ready: true, stripeAccountId: 'acct_1C', country: 'ES', feeBps: 500 },
      { own: true, registered: ['price_de_plataforma'] },
    );
    const adapter = await adapters.billing(TENANT);
    await adapter.retrievePrice('price_de_plataforma');
    await adapter.retrievePrice('price_heredado');
    await adapter.retrieveProduct('prod_heredado');
    expect(log.map(([who, what, id]) => `${who}:${what}:${id as string}`)).toEqual([
      'plataforma:retrievePrice:price_de_plataforma',
      'propia:retrievePrice:price_heredado',
      'propia:retrieveProduct:prod_heredado',
    ]);
  });
});

describe('PlatformStripeAdapters.subscriptions (lo de E5 está en platform-membership.test.ts)', () => {
  it('modo propio → claves propias, el adaptador de siempre', async () => {
    const own = build({
      mode: 'own',
      credentials: { credentials: OWN, source: 'tenant', verified: true },
    });
    expect(await own.adapters.subscriptions(TENANT)).toEqual({ label: OWN.secretKey });
  });

  it('plataforma sin claves propias → ya no es 503: el decorador de plataforma (E5)', async () => {
    const { adapters } = build({ mode: 'platform', ready: false, reason: 'not_connected' });
    const adapter = await adapters.subscriptions(TENANT);
    expect(adapter).not.toEqual({ label: OWN.secretKey });
    expect(adapter.constructor.name).toBe('PlatformSubscriptionsStripeAdapter');
  });

  it('modo none → StripeConfigMissingError (503), como siempre', async () => {
    const { adapters } = build({ mode: 'none' });
    await expect(adapters.subscriptions(TENANT)).rejects.toBeInstanceOf(
      SubscriptionsStripeConfigMissingError,
    );
  });
});

describe('PlatformCheckoutGate en el controlador público de compra', () => {
  function controller(mode: PaymentMode) {
    const resync = vi.fn(async () => ({ resynced: 1, skipped: 0 }));
    const billing = {
      getCatalog: vi.fn(async () => [{ courseId: 'c1', options: [] }]),
      getCourseOffer: vi.fn(async () => ({ forSale: true, options: [] })),
      startCheckout: vi.fn(async () => ({ orderId: 'o', sessionId: 'cs_1', url: 'https://x' })),
      resyncStripeCatalog: resync,
    };
    const runtime = {
      mode: { resolve: vi.fn(async () => mode) },
      accounts: { getAccount: vi.fn(async () => ({ country: 'ES', defaultCurrency: 'eur' })) },
      refs: { isPlatformObject: vi.fn(async () => false) },
    };
    const gate = new PlatformCheckoutGate(runtime as never);
    const prisma = {
      tenant: { findUnique: vi.fn(async () => ({ signupsFrozenAt: null })) },
      modCoursesCourse: {
        findFirst: vi.fn(async () => ({ id: 'c1', status: 'PUBLISHED' })),
        findMany: vi.fn(async () => []),
      },
    };
    const ctrl = new BillingPublicController(
      { getBillingService: () => billing } as never,
      {
        resolveByHost: async () => ({ id: TENANT }),
        resolveTenantWebBaseUrl: async () => 'https://aula.test',
      } as never,
      prisma as never,
      fakeConsents() as never,
      gate,
    );
    return { ctrl, billing, resync };
  }
  const COURSE = '22222222-2222-4222-8222-222222222222';
  const req = { headers: { host: 'aula.test' } } as never;

  it('cuenta no lista → la oferta dice forSale:false con motivo y el checkout 409 sin crear orden', async () => {
    const { ctrl, billing } = controller({
      mode: 'platform',
      ready: false,
      reason: 'onboarding_incomplete',
    });
    expect(await ctrl.offer(req, COURSE)).toEqual({
      forSale: false,
      options: [],
      reason: PAYOUTS_NOT_READY_OFFER_REASON,
    });
    expect(billing.getCourseOffer).not.toHaveBeenCalled();
    expect(await ctrl.catalog(req)).toEqual({ courses: [] });

    const err = await ctrl.checkout(req, COURSE, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayoutsNotReadyError);
    expect(PAYOUTS_STATUS_BY_CODE['PAYOUTS_NOT_READY']).toBe(409);
    expect(billing.startCheckout).not.toHaveBeenCalled();
  });

  it('cuenta lista → oferta normal y, antes del checkout, precios del curso en la cuenta del operador', async () => {
    const { ctrl, billing, resync } = controller({
      mode: 'platform',
      ready: true,
      stripeAccountId: 'acct_1C',
      country: 'ES',
      feeBps: 500,
    });
    expect(await ctrl.offer(req, COURSE)).toEqual({ forSale: true, options: [] });
    await ctrl.checkout(req, COURSE, {});
    expect(resync).toHaveBeenCalledWith(TENANT, {
      courseId: COURSE,
      isCurrent: expect.any(Function),
    });
    expect(billing.startCheckout).toHaveBeenCalledTimes(1);
  });

  it('tenant en modo propio con el modo plataforma encendido → la puerta no hace nada', async () => {
    const { ctrl, billing, resync } = controller({
      mode: 'own',
      credentials: { credentials: OWN, source: 'tenant', verified: true },
    });
    expect(await ctrl.offer(req, COURSE)).toEqual({ forSale: true, options: [] });
    await ctrl.checkout(req, COURSE, {});
    expect(resync).not.toHaveBeenCalled();
    expect(billing.startCheckout).toHaveBeenCalledTimes(1);
  });
});

describe('PlatformCheckoutGate en el controlador del alumno', () => {
  it('cuenta no lista → forSale:false con motivo y checkout 409 sin crear orden; lista → compra', async () => {
    let mode: PaymentMode = { mode: 'platform', ready: false, reason: 'restricted' };
    const billing = {
      getCourseOffer: vi.fn(async () => ({ forSale: true, options: [] })),
      startCheckout: vi.fn(async () => ({ orderId: 'o', sessionId: 'cs_1', url: 'https://x' })),
      resyncStripeCatalog: vi.fn(async () => ({ resynced: 0, skipped: 1 })),
    };
    const gate = new PlatformCheckoutGate({
      mode: { resolve: async () => mode },
      refs: { isPlatformObject: async () => true },
    } as never);
    const ctrl = new BillingController(
      { getBillingService: () => billing } as never,
      {
        modCoursesCourse: { findFirst: async () => ({ status: 'PUBLISHED' }) },
        modLearningEnrollment: { findFirst: async () => null },
        user: { findUnique: async () => ({ email: 'a@example.test' }) },
      } as never,
      { resolveTenantWebBaseUrl: async () => 'https://aula.test' } as never,
      fakeConsents() as never,
      gate,
    );
    const user = { sub: 'u1', tenantId: TENANT } as never;
    const req = { headers: {} } as never;

    expect(await ctrl.getOffer('curso', user)).toEqual({
      forSale: false,
      options: [],
      reason: PAYOUTS_NOT_READY_OFFER_REASON,
    });
    await expect(ctrl.startCheckout('curso', user, req, {})).rejects.toBeInstanceOf(
      PayoutsNotReadyError,
    );
    expect(billing.startCheckout).not.toHaveBeenCalled();

    mode = {
      mode: 'platform',
      ready: true,
      stripeAccountId: 'acct_1C',
      country: 'ES',
      feeBps: 500,
    };
    expect(await ctrl.getOffer('curso', user)).toEqual({ forSale: true, options: [] });
    await ctrl.startCheckout('curso', user, req, {});
    expect(billing.startCheckout).toHaveBeenCalledTimes(1);
  });
});

describe('PayoutsModule: apagado no provee nada; encendido es global y exporta las piezas opcionales', () => {
  it('apagado → módulo vacío (los controladores reciben undefined y son los de siempre)', () => {
    expect(PayoutsModule.register({ enabled: false })).toEqual({ module: PayoutsModule });
  });

  it('encendido → global, con la guarda de objetos y la puerta de venta exportadas', () => {
    const mod = PayoutsModule.register({
      enabled: true,
      secretKey: 'sk_test_x',
      webhookSecrets: ['whsec_x'],
    } as never);
    expect(mod.global).toBe(true);
    expect(mod.exports).toEqual([PayoutsRuntime, PlatformObjectGuard, PlatformCheckoutGate]);
  });
});
