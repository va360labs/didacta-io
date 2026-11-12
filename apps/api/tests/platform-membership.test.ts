/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Membresías en modo plataforma (cobros de plataforma, E5), lo que vive en el
 * host:
 *
 *  - `PlatformSubscriptionsStripeAdapter`: la sesión en la cuenta del operador
 *    en nombre del creador y registrada a nombre del aula; el enrutado por id
 *    registrado de los métodos sobre objetos que ya existen (suscripciones
 *    heredadas → claves propias; de plataforma → clave del operador); el
 *    portal del cliente con la configuración del creador.
 *  - La puerta de venta de `/unete` (cuenta no lista → sin planes y 409).
 *  - `POST /modules/subscriptions/me/portal` y la marca `billingPortal`.
 *  - Ataque: `invoice.paid` firmado por el aula B en el webhook HEREDADO que
 *    nombra una suscripción de plataforma del aula A → 403 sin procesar nada.
 *
 * De punta a punta por el webhook de plataforma, contra Postgres real como
 * `didacta_app`: `integration/payouts-membership.integration.test.ts`.
 */

import { HttpException, NotFoundException } from '@nestjs/common';
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PayoutsNotReadyError,
  RefsService,
  type PortalForAccount,
  type RegisterObjectRefInput,
} from '@didacta/mod-payouts';
import type {
  SubscriptionsStripeAdapter,
  SubscriptionsStripeAdapterOptions,
} from '@didacta/mod-subscriptions';
import type { PaymentMode } from '../src/modules/payment-mode.resolver';
import { PAYOUTS_STATUS_BY_CODE } from '../src/modules/payouts/payouts-error.filter';
import {
  PAYOUTS_NOT_READY_OFFER_REASON,
  PlatformCheckoutGate,
} from '../src/modules/payouts/platform-checkout-gate';
import { PlatformObjectGuard } from '../src/modules/payouts/platform-object-guard';
import {
  PlatformStripeAdapters,
  PlatformSubscriptionsStripeAdapter,
} from '../src/modules/payouts/platform-stripe-adapters';
import { MembershipPublicController } from '../src/modules/subscriptions/membership-public.controller';
import { SubscriptionsController } from '../src/modules/subscriptions/subscriptions.controller';
import { SubscriptionsWebhookController } from '../src/modules/subscriptions/subscriptions-webhook.controller';
import { TenantStripeResolverService } from '../src/modules/tenant-stripe-resolver.service';
import { fakeConsents } from './helpers/fake-purchase-consent';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PLAN = '33333333-3333-4333-8333-333333333333';
const OWN = { secretKey: 'sk_test_propia', webhookSecret: 'whsec_propio' };
const CONFIG = {
  enabled: true,
  secretKey: 'sk_test_operador',
  livemode: false,
  webhookSecrets: ['whsec_operador'],
} as never;
const READY: PaymentMode = {
  mode: 'platform',
  ready: true,
  stripeAccountId: 'acct_1Creadora',
  country: 'ES',
  feeBps: 500,
};

type Call = [label: string, method: string, arg: unknown];

/** Adaptador de suscripciones falso: apunta quién (clave y opciones) hizo qué. */
function fakeSubscriptions(
  label: string,
  log: Call[],
  options?: SubscriptionsStripeAdapterOptions,
): SubscriptionsStripeAdapter {
  const tag = options?.connect ? `${label}@${options.connect.onBehalfOf}` : label;
  const view = (id: string) => ({
    id,
    status: 'active',
    cancelAtPeriodEnd: true,
    currentPeriodEnd: 1_800_000_000,
    canceledAt: null,
  });
  return {
    createCheckoutSession: async (p) => {
      log.push([tag, 'createCheckoutSession', { options, metadata: p.metadata }]);
      return { id: `cs_test_${label}`, url: `https://checkout.test/${label}` };
    },
    retrievePrice: async (id) => {
      log.push([tag, 'retrievePrice', id]);
      return {
        id,
        productId: 'prod_x',
        unitAmount: 2900,
        currency: 'eur',
        active: true,
        recurringInterval: 'month',
      };
    },
    cancelSubscription: async (id, atPeriodEnd) => {
      log.push([tag, 'cancelSubscription', `${id}:${atPeriodEnd}`]);
      return view(id);
    },
    endTrialNow: async (id) => {
      log.push([tag, 'endTrialNow', id]);
      return { ...view(id), latestInvoicePaid: true };
    },
    updateProduct: async (id, name) => {
      log.push([tag, 'updateProduct', `${id}:${name}`]);
    },
    createProduct: async (name) => {
      log.push([tag, 'createProduct', name]);
      return `prod_${label}`;
    },
    createRecurringPrice: async (p) => {
      log.push([tag, 'createRecurringPrice', p.amountCents]);
      return `price_${label}`;
    },
    createPortalSession: async (p) => {
      log.push([tag, 'createPortalSession', p]);
      return { url: `https://billing.test/${tag}` };
    },
    retrieveCustomerBalance: async (id) => {
      log.push([tag, 'retrieveCustomerBalance', id]);
      return { balanceCents: 0, currency: 'eur' };
    },
    creditCustomerBalance: async (p) => {
      log.push([tag, 'creditCustomerBalance', `${p.customerId}:${p.amountCents}`]);
      return { id: `cbtxn_${label}` };
    },
    constructWebhookEvent: () => {
      throw new Error('no se usa');
    },
  };
}

function build(
  mode: PaymentMode,
  opts: { own?: boolean; registered?: string[]; portal?: PortalForAccount } = {},
) {
  const log: Call[] = [];
  const registered: RegisterObjectRefInput[] = [];
  const builds: Array<{ key: string; options: SubscriptionsStripeAdapterOptions | undefined }> = [];
  const adapters = new PlatformStripeAdapters({
    config: CONFIG,
    mode: { resolve: async () => mode },
    ownCredentials: {
      resolveTenantOnly: async () =>
        opts.own ? { credentials: OWN, source: 'tenant', verified: true } : null,
    },
    refs: {
      register: async (input) => {
        registered.push(input);
      },
      isPlatformObject: async (id) =>
        (opts.registered ?? []).includes(id) || registered.some((r) => r.stripeObjectId === id),
    },
    buildBilling: () => {
      throw new Error('billing no se usa aquí');
    },
    buildSubscriptions: (credentials, options) => {
      builds.push({ key: credentials.secretKey, options });
      return fakeSubscriptions(
        credentials.secretKey === OWN.secretKey ? 'propia' : 'plataforma',
        log,
        options,
      );
    },
    portal: {
      forTenant: async (tenantId) => {
        log.push(['portal', 'forTenant', tenantId]);
        return opts.portal ?? { configurationId: 'bpc_1Creadora', onBehalfOf: 'acct_1Creadora' };
      },
    },
  });
  return { adapters, log, registered, builds };
}

const MEMBERSHIP_CHECKOUT = {
  priceId: 'price_x',
  successUrl: 'https://aula.test/unete?status=success',
  cancelUrl: 'https://aula.test/unete?status=cancel',
  trialDays: 7,
  allowPromotionCodes: true,
  clientReferenceId: PLAN,
  metadata: { tenantId: A, membership: '1', planId: PLAN },
};

describe('PlatformSubscriptionsStripeAdapter · alta', () => {
  it('modo propio → el adaptador de siempre, construido SIN opciones', async () => {
    const { adapters, log, builds } = build({
      mode: 'own',
      credentials: { credentials: OWN, source: 'tenant', verified: true },
    });
    await (await adapters.subscriptions(A)).createCheckoutSession(MEMBERSHIP_CHECKOUT);
    expect(builds).toEqual([{ key: OWN.secretKey, options: undefined }]);
    expect(log[0]?.[0]).toBe('propia');
  });

  it('cuenta lista → clave del operador con on_behalf_of y sin códigos; registra cs_ con el plan', async () => {
    const { adapters, log, registered } = build(READY);
    const adapter = await adapters.subscriptions(A);
    expect(adapter).toBeInstanceOf(PlatformSubscriptionsStripeAdapter);
    const session = await adapter.createCheckoutSession(MEMBERSHIP_CHECKOUT);
    expect(session.id).toBe('cs_test_plataforma');
    expect(log).toEqual([
      [
        'plataforma@acct_1Creadora',
        'createCheckoutSession',
        {
          options: { connect: { onBehalfOf: 'acct_1Creadora' }, promotionCodes: 'deny' },
          metadata: MEMBERSHIP_CHECKOUT.metadata,
        },
      ],
    ]);
    expect(registered).toEqual([
      {
        tenantId: A,
        stripeObjectId: 'cs_test_plataforma',
        kind: 'checkout_session',
        source: 'membership',
        localRef: PLAN,
        parentObjectId: null,
        livemode: false,
      },
    ]);
  });

  it('suscripción a un curso → origen subscriptions y la suscripción local como referencia', async () => {
    const { adapters, registered } = build(READY);
    await (
      await adapters.subscriptions(A)
    ).createCheckoutSession({
      priceId: 'price_x',
      successUrl: 'https://x',
      cancelUrl: 'https://y',
      metadata: { tenantId: A, userId: 'u', courseId: 'c', subscriptionLocalId: 'sub-local-1' },
    });
    expect(registered[0]).toMatchObject({ source: 'subscriptions', localRef: 'sub-local-1' });
  });

  it('cuenta NO lista → 409 PAYOUTS_NOT_READY sin llamar a Stripe; el catálogo sí se prepara y se registra', async () => {
    const { adapters, log, registered } = build({
      mode: 'platform',
      ready: false,
      reason: 'onboarding_incomplete',
    });
    const adapter = await adapters.subscriptions(A);
    const err = await adapter.createCheckoutSession(MEMBERSHIP_CHECKOUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayoutsNotReadyError);
    expect(PAYOUTS_STATUS_BY_CODE[(err as PayoutsNotReadyError).code]).toBe(409);
    expect(log).toEqual([]);

    const productId = await adapter.createProduct('Mensual', {
      tenantId: A,
      planId: PLAN,
      didacta: 'membership',
    });
    await adapter.createRecurringPrice({
      productId,
      amountCents: 2900,
      currency: 'eur',
      intervalMonths: 1,
      metadata: { tenantId: A, planId: PLAN },
    });
    expect(registered.map((r) => [r.stripeObjectId, r.kind, r.source, r.parentObjectId])).toEqual([
      ['prod_plataforma', 'product', 'membership', null],
      ['price_plataforma', 'price', 'membership', 'prod_plataforma'],
    ]);
  });
});

describe('PlatformSubscriptionsStripeAdapter · objetos que ya existen (enrutado por id registrado)', () => {
  it('cancelar una suscripción HEREDADA usa las claves propias; una de plataforma, la clave del operador', async () => {
    const { adapters, log } = build(READY, { own: true, registered: ['sub_1DePlataforma'] });
    const adapter = await adapters.subscriptions(A);
    await adapter.cancelSubscription('sub_1Heredada', true);
    await adapter.cancelSubscription('sub_1DePlataforma', true);
    expect(log.map(([who, what, arg]) => `${who}:${what}:${String(arg)}`)).toEqual([
      'propia:cancelSubscription:sub_1Heredada:true',
      'plataforma@acct_1Creadora:cancelSubscription:sub_1DePlataforma:true',
    ]);
  });

  it('endTrialNow, updateProduct y retrievePrice siguen la misma regla', async () => {
    const { adapters, log } = build(READY, {
      own: true,
      registered: ['sub_1P', 'prod_1P', 'price_1P'],
    });
    const adapter = await adapters.subscriptions(A);
    await adapter.endTrialNow('sub_1H');
    await adapter.endTrialNow('sub_1P');
    await adapter.updateProduct('prod_1H', 'Anual');
    await adapter.updateProduct('prod_1P', 'Anual');
    await adapter.retrievePrice('price_1H');
    await adapter.retrievePrice('price_1P');
    expect(log.map(([who, what]) => `${who.split('@')[0]}:${what}`)).toEqual([
      'propia:endTrialNow',
      'plataforma:endTrialNow',
      'propia:updateProduct',
      'plataforma:updateProduct',
      'propia:retrievePrice',
      'plataforma:retrievePrice',
    ]);
  });

  it('sin claves propias todo va a la plataforma (no hay otra cuenta)', async () => {
    const { adapters, log } = build(READY);
    await (await adapters.subscriptions(A)).cancelSubscription('sub_1Cualquiera', false);
    expect(log[0]?.[0]).toBe('plataforma@acct_1Creadora');
  });

  it('la cuenta restringida no impide darse de baja: cancelar va a la plataforma igual', async () => {
    const { adapters, log } = build(
      { mode: 'platform', ready: false, reason: 'restricted' },
      { own: true, registered: ['sub_1P'] },
    );
    await (await adapters.subscriptions(A)).cancelSubscription('sub_1P', true);
    expect(log[0]?.[0]).toBe('plataforma');
  });
});

describe('PlatformSubscriptionsStripeAdapter · portal del cliente', () => {
  it('cliente de plataforma → configuración del creador y on_behalf_of de su cuenta', async () => {
    const { adapters, log } = build(
      { mode: 'platform', ready: false, reason: 'restricted' },
      { own: true, registered: ['cus_1Plataforma'] },
    );
    const result = await (
      await adapters.subscriptions(A)
    ).createPortalSession({ customerId: 'cus_1Plataforma', returnUrl: 'https://aula.test/cuenta' });
    expect(result.url).toBe('https://billing.test/plataforma@acct_1Creadora');
    expect(log).toEqual([
      ['portal', 'forTenant', A],
      [
        'plataforma@acct_1Creadora',
        'createPortalSession',
        {
          customerId: 'cus_1Plataforma',
          returnUrl: 'https://aula.test/cuenta',
          configurationId: 'bpc_1Creadora',
        },
      ],
    ]);
  });

  it('cliente de las claves propias → el portal de esa cuenta, sin configuración del operador', async () => {
    const { adapters, log } = build(READY, { own: true });
    await (
      await adapters.subscriptions(A)
    ).createPortalSession({ customerId: 'cus_1Heredado', returnUrl: 'https://aula.test/cuenta' });
    expect(log).toEqual([
      [
        'propia',
        'createPortalSession',
        { customerId: 'cus_1Heredado', returnUrl: 'https://aula.test/cuenta' },
      ],
    ]);
  });
});

describe('PlatformSubscriptionsStripeAdapter · saldo de cliente (descuento por referidos)', () => {
  const CREDIT = {
    amountCents: 600,
    currency: 'eur',
    description: 'Descuento por invitar',
    metadata: {},
    idempotencyKey: 'referrals-credit:p1',
  };

  it('cliente de plataforma → el abono va a la cuenta del operador (el reparto lo descuenta al creador)', async () => {
    const { adapters, log } = build(READY, { own: true, registered: ['cus_1Plataforma'] });
    const adapter = await adapters.subscriptions(A);
    expect(await adapter.retrieveCustomerBalance('cus_1Plataforma')).toEqual({
      balanceCents: 0,
      currency: 'eur',
    });
    expect(
      await adapter.creditCustomerBalance({ customerId: 'cus_1Plataforma', ...CREDIT }),
    ).toEqual({ id: 'cbtxn_plataforma' });
    expect(log.map((l) => [l[0], l[1]])).toEqual([
      ['plataforma@acct_1Creadora', 'retrieveCustomerBalance'],
      ['plataforma@acct_1Creadora', 'creditCustomerBalance'],
    ]);
  });

  it('cliente de las claves propias → el abono va a la cuenta del creador', async () => {
    const { adapters, log } = build(READY, { own: true });
    await (
      await adapters.subscriptions(A)
    ).creditCustomerBalance({ customerId: 'cus_1Heredado', ...CREDIT });
    expect(log).toEqual([['propia', 'creditCustomerBalance', 'cus_1Heredado:600']]);
  });
});

// ───────────────────────── /unete ─────────────────────────

describe('PlatformCheckoutGate en /unete (MembershipPublicController)', () => {
  const PLAN_USD = '44444444-4444-4444-8444-444444444444';
  const PAGE = {
    headline: 'Hazte miembro',
    plans: [
      { id: PLAN, name: 'Mensual', amountCents: 2900, currency: 'eur' },
      { id: PLAN_USD, name: 'Anual', amountCents: 29900, currency: 'usd' },
    ],
    courses: [],
  };
  function controller(
    mode: PaymentMode,
    account: { country: string; defaultCurrency: string | null } | null = {
      country: 'ES',
      defaultCurrency: 'eur',
    },
    withGate = true,
  ) {
    const membership = {
      getPublicPage: vi.fn(async () => PAGE),
      startMembershipCheckout: vi.fn(async () => ({ url: 'https://x', sessionId: 'cs_1' })),
      resyncStripeCatalog: vi.fn(async () => ({ resynced: 1, skipped: 0 })),
    };
    const isPlatformObject = vi.fn(async () => true);
    const gate = new PlatformCheckoutGate({
      mode: { resolve: async () => mode },
      accounts: { getAccount: async () => account },
      refs: { isPlatformObject },
    } as never);
    const ctrl = new MembershipPublicController(
      { getMembershipService: () => membership } as never,
      {
        resolveByHost: async () => ({ id: A }),
        resolveTenantWebBaseUrl: async () => 'https://aula.test',
      } as never,
      fakeConsents() as never,
      withGate ? gate : undefined,
    );
    return { ctrl, membership, isPlatformObject };
  }
  const req = { headers: { host: 'aula.test' } } as never;

  it('cuenta no lista → la página se ve SIN planes (con motivo) y el checkout da 409 sin crear nada', async () => {
    const { ctrl, membership } = controller({
      mode: 'platform',
      ready: false,
      reason: 'onboarding_incomplete',
    });
    expect(await ctrl.page(req)).toMatchObject({
      headline: 'Hazte miembro',
      plans: [],
      reason: PAYOUTS_NOT_READY_OFFER_REASON,
    });
    const err = await ctrl.checkout(req, { planId: PLAN } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayoutsNotReadyError);
    expect(membership.resyncStripeCatalog).not.toHaveBeenCalled();
    expect(membership.startMembershipCheckout).not.toHaveBeenCalled();
  });

  it('cuenta lista → página con sus planes y, antes del checkout, el precio del plan en la cuenta del operador', async () => {
    const { ctrl, membership, isPlatformObject } = controller(READY);
    expect((await ctrl.page(req)) as { plans: unknown[] }).toMatchObject({
      plans: [{ id: PLAN }, { id: PLAN_USD }],
    });
    await ctrl.checkout(req, { planId: PLAN } as never);
    expect(membership.resyncStripeCatalog).toHaveBeenCalledWith(A, {
      planId: PLAN,
      isCurrent: expect.any(Function),
    });
    const isCurrent = (
      membership.resyncStripeCatalog.mock.calls[0] as unknown as [
        string,
        { isCurrent: (id: string) => Promise<boolean> },
      ]
    )[1].isCurrent;
    expect(await isCurrent('price_1X')).toBe(true);
    expect(isPlatformObject).toHaveBeenCalledWith(['price_1X']);
    expect(membership.startMembershipCheckout).toHaveBeenCalledTimes(1);
  });

  it('aula en modo propio con el modo plataforma encendido → la puerta no hace nada', async () => {
    const { ctrl, membership } = controller({
      mode: 'own',
      credentials: { credentials: OWN, source: 'tenant', verified: true },
    });
    expect((await ctrl.page(req)) as object).not.toHaveProperty('reason');
    await ctrl.checkout(req, { planId: PLAN } as never);
    expect(membership.resyncStripeCatalog).not.toHaveBeenCalled();
    expect(membership.startMembershipCheckout).toHaveBeenCalledTimes(1);
  });

  it('cuenta lista → cada plan dice si se verá en la moneda del alumno, y sin cupones', async () => {
    const { ctrl } = controller(READY);
    expect(await ctrl.page(req)).toEqual({
      ...PAGE,
      plans: [
        { ...PAGE.plans[0], localCurrencyAtCheckout: true },
        // Precio en otra moneda que la de liquidación: Stripe no lo convierte.
        { ...PAGE.plans[1], localCurrencyAtCheckout: false },
      ],
      couponsAtCheckout: false,
    });
  });

  it('cuenta sin moneda dicha por Stripe → la del país del creador', async () => {
    const { ctrl } = controller(READY, { country: 'US', defaultCurrency: null });
    const page = (await ctrl.page(req)) as { plans: Array<{ localCurrencyAtCheckout: boolean }> };
    expect(page.plans.map((p) => p.localCurrencyAtCheckout)).toEqual([false, true]);
  });

  it('claves propias con el modo encendido → cupones sí, sin conversión automática', async () => {
    const { ctrl } = controller({
      mode: 'own',
      credentials: { credentials: OWN, source: 'tenant', verified: true },
    });
    const page = (await ctrl.page(req)) as {
      plans: Array<{ localCurrencyAtCheckout: boolean }>;
      couponsAtCheckout: boolean;
    };
    expect(page.couponsAtCheckout).toBe(true);
    expect(page.plans.map((p) => p.localCurrencyAtCheckout)).toEqual([false, false]);
  });

  it('sin modo plataforma (Community) → la página es idéntica a la del módulo', async () => {
    const { ctrl } = controller(READY, null, false);
    expect(await ctrl.page(req)).toBe(PAGE);
  });
});

// ───────────────────── portal del alumno ─────────────────────

describe('POST /modules/subscriptions/me/portal y la marca billingPortal', () => {
  function controller(gate: PlatformCheckoutGate | undefined) {
    const subs = {
      listMine: vi.fn(async () => [
        { id: 's1', planId: PLAN, courseId: null, stripeCustomerId: 'cus_1Plataforma' },
        { id: 's2', planId: null, courseId: 'c', stripeCustomerId: 'cus_1Heredado' },
      ]),
      createBillingPortalSession: vi.fn(async () => ({
        url: 'https://billing.test/x',
        subscriptionId: 's1',
      })),
    };
    const prisma = {
      modSubscriptionsPlan: { findMany: async () => [{ id: PLAN, name: 'Mensual' }] },
      modCoursesCourse: { findMany: async () => [{ id: 'c', title: 'Curso' }] },
    };
    const ctrl = new SubscriptionsController(
      {
        getSubscriptionsService: () => subs,
        getSubscriptionsServiceOrNull: () => subs,
      } as never,
      prisma as never,
      {} as never,
      { resolveTenantWebBaseUrl: async () => 'https://aula.test' } as never,
      fakeConsents() as never,
      gate,
    );
    return { ctrl, subs };
  }
  const user = { sub: 'alumna', tenantId: A, roles: ['student'] } as never;

  const anyGate = new PlatformCheckoutGate({
    refs: { isPlatformObject: async () => true },
  } as never);

  it('el portal vuelve a la pestaña de suscripción del aula', async () => {
    const { ctrl, subs } = controller(anyGate);
    expect(await ctrl.portal(user, { headers: {} } as never, { subscriptionId: 's1' })).toEqual({
      url: 'https://billing.test/x',
      subscriptionId: 's1',
    });
    expect(subs.createBillingPortalSession).toHaveBeenCalledWith(A, 'alumna', {
      subscriptionId: 's1',
      returnUrl: 'https://aula.test/cuenta?tab=suscripcion',
    });
    await ctrl.portal(user, { headers: {} } as never, undefined);
    expect(subs.createBillingPortalSession).toHaveBeenLastCalledWith(A, 'alumna', {
      subscriptionId: undefined,
      returnUrl: 'https://aula.test/cuenta?tab=suscripcion',
    });
  });

  it('sin cobros de plataforma (Community) la ruta responde 404 y no toca Stripe, como en beta.12', async () => {
    const { ctrl, subs } = controller(undefined);
    await expect(
      ctrl.portal(user, { headers: {} } as never, { subscriptionId: 's1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(subs.createBillingPortalSession).not.toHaveBeenCalled();
  });

  it('billingPortal solo en las suscripciones cobradas por la plataforma; sin modo plataforma, en ninguna', async () => {
    const gate = new PlatformCheckoutGate({
      refs: { isPlatformObject: async ([id]: string[]) => id === 'cus_1Plataforma' },
    } as never);
    const conPlataforma = (await controller(gate).ctrl.listMine(user)) as {
      subscriptions: Array<{ id: string; billingPortal: boolean }>;
    };
    expect(conPlataforma.subscriptions.map((s) => [s.id, s.billingPortal])).toEqual([
      ['s1', true],
      ['s2', false],
    ]);
    const community = (await controller(undefined).ctrl.listMine(user)) as {
      subscriptions: Array<{ billingPortal: boolean }>;
    };
    expect(community.subscriptions.map((s) => s.billingPortal)).toEqual([false, false]);
  });
});

// ───────────── ataque por el webhook heredado ─────────────

describe('ataque: invoice.paid firmado por B en el webhook HEREDADO nombrando una suscripción de plataforma de A', () => {
  const ENV = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SUBSCRIPTIONS_WEBHOOK_SECRET'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function harness() {
    // Registro de objetos: la suscripción de A cobrada por la plataforma.
    const refs: Array<Record<string, unknown>> = [
      {
        stripeObjectId: 'sub_1PlataformaDeA',
        tenantId: A,
        kind: 'subscription',
        source: 'membership',
        localRef: PLAN,
        parentObjectId: 'cs_test_DeA',
        livemode: false,
      },
    ];
    const prisma = {
      modPayoutsObjectRef: {
        findFirst: async ({ where }: { where: { OR: Array<Record<string, unknown>> } }) => {
          const ids = where.OR.flatMap(
            (c) => (c['stripeObjectId'] as { in?: string[] } | undefined)?.in ?? [],
          );
          return refs.find((r) => ids.includes(r['stripeObjectId'] as string)) ?? null;
        },
      },
    };
    const guard = new PlatformObjectGuard({ refs: new RefsService(prisma as never) } as never);
    const subs = {
      resolveWebhookTenantClaims: vi.fn(async () => []),
      handleWebhookEvent: vi.fn(async () => undefined),
    };
    const membership = {
      resolveWebhookTenantClaims: vi.fn(async () => []),
      fulfillMembershipCheckout: vi.fn(async () => null),
    };
    const billing = {
      resolveWebhookTenantClaims: vi.fn(async () => []),
      handleWebhookEvent: vi.fn(async () => undefined),
    };
    const registry = {
      getSubscriptionsService: () => subs,
      getMembershipService: () => membership,
      getBillingService: () => billing,
    };
    const stripeResolver = new TenantStripeResolverService(
      {
        get: async (tenantId: string, scope: string, key: string) =>
          tenantId === B && scope === 'billing' && key === 'stripe'
            ? { secretKey: 'sk_test_cuenta_de_B', webhookSecret: 'whsec_de_B' }
            : undefined,
      } as never,
      async () => false,
    );
    const audited: unknown[] = [];
    const ctrl = new SubscriptionsWebhookController(
      registry as never,
      { provision: vi.fn() } as never,
      { provision: vi.fn() } as never,
      { warn: vi.fn(), error: vi.fn(), log: vi.fn() } as never,
      {
        resolveByHost: async (host: string) => (host === 'aula-b.test' ? { id: B } : null),
        resolveTenantWebBaseUrl: async () => 'https://aula-b.test',
      } as never,
      stripeResolver,
      { record: async (entry: unknown) => audited.push(entry) } as never,
      guard,
    );
    return { ctrl, subs, membership, billing, audited };
  }

  function invoicePaidSignedByB(subscriptionId: string) {
    const payload = JSON.stringify({
      id: 'evt_ataque_1',
      object: 'event',
      type: 'invoice.paid',
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'in_1Inventada',
          object: 'invoice',
          status: 'paid',
          amount_paid: 2900,
          currency: 'eur',
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: subscriptionId },
          },
        },
      },
    });
    return {
      headers: {
        host: 'aula-b.test',
        'stripe-signature': Stripe.webhooks.generateTestHeaderString({
          payload,
          secret: 'whsec_de_B',
        }),
      },
      ip: '203.0.113.7',
      rawBody: Buffer.from(payload, 'utf8'),
    } as never;
  }

  it('→ 403 y ningún módulo procesa nada', async () => {
    const { ctrl, subs, membership, billing } = harness();
    const err = await ctrl
      .handle(invoicePaidSignedByB('sub_1PlataformaDeA'))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(403);
    expect(subs.handleWebhookEvent).not.toHaveBeenCalled();
    expect(membership.fulfillMembershipCheckout).not.toHaveBeenCalled();
    expect(billing.handleWebhookEvent).not.toHaveBeenCalled();
  });

  it('control: el mismo evento sobre una suscripción que NO es de plataforma pasa la guarda', async () => {
    const { ctrl, subs } = harness();
    const result = await ctrl.handle(invoicePaidSignedByB('sub_1PropiaDeB'));
    expect(result).toMatchObject({ received: true, type: 'invoice.paid' });
    expect(subs.handleWebhookEvent).toHaveBeenCalledTimes(1);
  });
});
