/**
 * Membresías cobradas por la plataforma (cobros de plataforma, E5) de punta a
 * punta por el webhook único, contra un Postgres REAL conectando como el
 * runtime de producción: rol `didacta_app` (NOSUPERUSER, NOBYPASSRLS) y RLS
 * forzada.
 *
 * De verdad: el webhook de plataforma, el `PayoutsRuntime`, la liquidación,
 * los servicios de suscripciones y membresía (el alta del miembro, el estado
 * de la suscripción, sus facturas) y la extensión RLS de Prisma. Simulado:
 * Stripe (el doble en memoria de `mod.payouts`), con objetos de la forma de la
 * API de la plataforma (factura sin `charge`, cobros en `payments`).
 *
 * REQUISITOS: los de `rls-isolation-didacta-app.integration.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { BillingService } from '@didacta/mod-billing';
import { MembershipService, SubscriptionsService } from '@didacta/mod-subscriptions';
import {
  InMemoryPlatformStripeClient,
  signStripePayload,
  type StripeObject,
} from '@didacta/mod-payouts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BillingProvisioningService } from '../../src/modules/billing/billing-provisioning.service';
import { ModuleRegistryService } from '../../src/modules/module-registry.service';
import { PayoutsRuntime } from '../../src/modules/payouts/payouts-runtime.service';
import { ModulesPlatformEventDispatcher } from '../../src/modules/payouts/platform-event-dispatcher';
import {
  loadPlatformPaymentsConfig,
  type PlatformPaymentsEnabled,
} from '../../src/modules/payouts/platform-payments.config';
import { PlatformWebhookController } from '../../src/modules/payouts/platform-webhook.controller';
import { MembershipProvisioningService } from '../../src/modules/subscriptions/membership-provisioning.service';
import { TenantStripeResolverService } from '../../src/modules/tenant-stripe-resolver.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runAsTenant } from '../../src/tenancy/tenant-context.storage';
import { TenantResolverService } from '../../src/tenancy/tenant-resolver.service';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

type Row = Record<string, unknown>;

const OPERATOR_SECRET = 'whsec_operador_e5_integracion';
const CONFIG = loadPlatformPaymentsConfig({
  PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: 'sk_test_inventadaE5',
  PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: OPERATOR_SECRET,
}) as PlatformPaymentsEnabled;

describeWithDb('Membresías por la plataforma — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let platform: PlatformWebhookController;

  const A = randomUUID();
  const B = randomUUID();
  const stamp = Date.now();
  const ACCT: Record<string, string> = { [A]: `acct_1E5A${stamp}`, [B]: `acct_1E5B${stamp}` };
  const ACCOUNT_ID: Record<string, string> = { [A]: randomUUID(), [B]: randomUUID() };

  const fake = new InMemoryPlatformStripeClient({ livemode: false });
  const transfers: StripeObject[] = [];
  const sessionBySubscription = new Map<string, string>();
  const published: Array<{ tenantId: string; name: string }> = [];
  const logger = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };

  beforeAll(async () => {
    const prepared = await prepareDidactaAppRole();
    admin = prepared.admin;
    const previous = {
      url: process.env['DATABASE_URL'],
      mode: process.env['RLS_ENFORCEMENT'],
      redis: process.env['REDIS_URL'],
    };
    process.env['DATABASE_URL'] = prepared.appUrl;
    process.env['RLS_ENFORCEMENT'] = 'on';
    delete process.env['REDIS_URL']; // sin Redis: el webhook liquida en línea
    try {
      const moduleRef = await Test.createTestingModule({ imports: [PrismaModule] }).compile();
      await moduleRef.init();
      prisma = moduleRef.get(PrismaService);
      closeModule = () => moduleRef.close();

      for (const [id, slug] of [
        [A, 'a'],
        [B, 'b'],
      ] as const) {
        await admin.tenant.create({
          data: { id, slug: `e5-${slug}-${stamp}`, name: `Aula E5 ${slug}` },
        });
        await admin.modPayoutsAccount.create({
          data: {
            id: ACCOUNT_ID[id]!,
            tenantId: id,
            stripeAccountId: ACCT[id]!,
            country: 'ES',
            entityType: 'individual',
            status: 'READY',
            readyAt: new Date(),
          },
        });
        await admin.modPayoutsObjectRef.create({
          data: {
            stripeObjectId: ACCT[id]!,
            tenantId: id,
            kind: 'account',
            source: 'payouts',
            localRef: ACCOUNT_ID[id]!,
          },
        });
      }

      // ── Stripe ──
      fake.on('POST', '/v1/transfers', (req, f) => {
        const transfer = {
          id: `${f.nextId('tr')}_${stamp}`,
          object: 'transfer',
          amount: req.params['amount'],
          currency: req.params['currency'],
          destination: req.params['destination'],
          source_transaction: req.params['source_transaction'],
          transfer_group: req.params['transfer_group'],
          metadata: req.params['metadata'],
          balance_transaction: `${f.nextId('txn')}_${stamp}`,
          created: Math.floor(Date.now() / 1000),
          livemode: false,
        };
        transfers.push(transfer);
        f.seed(transfer);
        return transfer;
      });
      fake.on('GET', '/v1/transfers', (req) => ({
        object: 'list',
        has_more: false,
        data: transfers.filter(
          (t) =>
            t['transfer_group'] === req.params['transfer_group'] &&
            t['destination'] === req.params['destination'],
        ),
      }));
      // La sesión de una suscripción se encuentra por la suscripción (no tiene PaymentIntent).
      fake.on('GET', '/v1/checkout/sessions', (req) => {
        const id = sessionBySubscription.get(String(req.params['subscription']));
        return { object: 'list', has_more: false, data: id ? [{ id }] : [] };
      });

      // ── servicios y controlador de verdad ──
      const publisher = {
        publish: async (tenantId: string, _actor: string | null, name: string) => {
          published.push({ tenantId, name });
        },
      };
      const noStripe = async () => {
        throw new Error('los módulos no deben llamar a Stripe al procesar el webhook');
      };
      const urls = { successUrl: () => 'https://x/ok', cancelUrl: () => 'https://x/ko' };
      const billing = new BillingService(prisma as never, noStripe as never, publisher, urls);
      const subs = new SubscriptionsService(prisma as never, noStripe as never, publisher, urls);
      const membership = new MembershipService(prisma as never, noStripe as never, publisher);
      const registry = {
        getBillingService: () => billing,
        getSubscriptionsService: () => subs,
        getMembershipService: () => membership,
      };
      const stripeResolver = new TenantStripeResolverService(
        { get: async () => undefined } as never,
        async () => false,
      );
      const tenantResolver = {
        resolveTenantWebBaseUrl: async () => 'https://aula.test',
        resolveTenantWebBaseUrlForBackground: async () => 'https://aula.test',
      };
      const provisioning = {
        provision: async () => ({ userId: randomUUID(), created: true }),
      };
      const runtime = new PayoutsRuntime(CONFIG, fake, prisma, stripeResolver, logger as never);
      const services = new Map<unknown, unknown>([
        [ModuleRegistryService, registry],
        [TenantResolverService, tenantResolver],
        [BillingProvisioningService, provisioning],
        [MembershipProvisioningService, provisioning],
      ]);
      const dispatcher = new ModulesPlatformEventDispatcher({
        get: (token: unknown) => services.get(token),
      } as never);
      platform = new PlatformWebhookController(runtime, logger as never, dispatcher);
    } finally {
      process.env['DATABASE_URL'] = previous.url;
      if (previous.mode === undefined) delete process.env['RLS_ENFORCEMENT'];
      else process.env['RLS_ENFORCEMENT'] = previous.mode;
      if (previous.redis !== undefined) process.env['REDIS_URL'] = previous.redis;
    }
  }, 90_000);

  afterAll(async () => {
    // El libro es de solo inserción: sus filas y las ventas que apunta se
    // quedan en la base desechable. Las cuentas se cierran para que los
    // barridos de otros ficheros no las vean.
    await admin?.modPayoutsAccount.updateMany({
      where: { tenantId: { in: [A, B] } },
      data: { closedAt: new Date(), status: 'DISCONNECTED' },
    });
    await closeModule?.();
    await admin?.$disconnect();
  });

  // ── utilidades ──

  let seq = 0;
  const evtId = (label: string) => `evt_e5_${label}_${stamp}_${++seq}`;

  function signed(type: string, object: Row, id: string) {
    const body = JSON.stringify({
      id,
      object: 'event',
      type,
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: { object },
    });
    return {
      headers: {
        host: 'api.didacta.test',
        'stripe-signature': signStripePayload(body, OPERATOR_SECRET),
      },
      ip: '203.0.113.9',
      rawBody: Buffer.from(body, 'utf8'),
    } as never;
  }

  interface Membership {
    tenantId: string;
    planId: string;
    sessionId: string;
    subId: string;
    cusId: string;
    email: string;
  }

  /**
   * Un plan de 29 €/mes y su checkout tal y como lo deja `/unete` con el
   * adaptador de plataforma: `cs_…` registrado a nombre del aula con el plan.
   * Y lo que Stripe tiene de la sesión.
   */
  async function membershipCheckout(
    tenantId: string,
    opts: { trialDays?: number } = {},
  ): Promise<Membership> {
    const planId = randomUUID();
    const tag = planId.replace(/-/g, '').slice(0, 20);
    const m: Membership = {
      tenantId,
      planId,
      sessionId: `cs_test_e5${tag}`,
      subId: `sub_1e5${tag}`,
      cusId: `cus_e5${tag}`,
      email: `alumna-${tag}@example.test`,
    };
    await admin.modSubscriptionsPlan.create({
      data: {
        id: planId,
        tenantId,
        // El nombre es único por aula.
        name: `Mensual ${tag.slice(0, 8)}`,
        intervalMonths: 1,
        amountCents: 2900,
        currency: 'eur',
        trialDays: opts.trialDays ?? 0,
        stripeProductId: `prod_e5${tag}`,
        stripePriceId: `price_e5${tag}`,
      },
    });
    await admin.modPayoutsObjectRef.create({
      data: {
        stripeObjectId: m.sessionId,
        tenantId,
        kind: 'checkout_session',
        source: 'membership',
        localRef: planId,
      },
    });
    fake.seed({
      id: m.sessionId,
      object: 'checkout.session',
      mode: 'subscription',
      livemode: false,
      subscription: m.subId,
      customer: m.cusId,
      payment_status: opts.trialDays ? 'no_payment_required' : 'paid',
    });
    sessionBySubscription.set(m.subId, m.sessionId);
    return m;
  }

  const completedObject = (m: Membership, paymentStatus = 'paid') => ({
    id: m.sessionId,
    object: 'checkout.session',
    mode: 'subscription',
    status: 'complete',
    payment_status: paymentStatus,
    subscription: m.subId,
    customer: m.cusId,
    client_reference_id: m.planId,
    customer_details: { email: m.email, name: 'Alumna' },
    metadata: { tenantId: m.tenantId, membership: '1', planId: m.planId },
  });

  const subscriptionObject = (m: Membership, status: string) => ({
    id: m.subId,
    object: 'subscription',
    status,
    customer: m.cusId,
    cancel_at_period_end: false,
    metadata: { tenantId: m.tenantId, membership: '1', planId: m.planId },
  });

  /**
   * Una factura cobrada (o de 0 €) con la forma de la API de la plataforma:
   * sin `charge`, el cobro en `payments`. El cargo ya trae su comisión real.
   */
  function paidInvoice(
    m: Membership,
    opts: {
      amount: number;
      fee?: number;
      reason?: string;
      presentment?: { amount: number; currency: string };
    },
  ) {
    const tag = randomUUID().replace(/-/g, '').slice(0, 20);
    const ids = { invoiceId: `in_e5${tag}`, piId: `pi_e5${tag}`, chId: `ch_e5${tag}` };
    if (opts.amount > 0) {
      const btId = `txn_e5${tag}`;
      fake.seed(
        {
          id: btId,
          object: 'balance_transaction',
          type: 'charge',
          amount: opts.amount,
          fee: opts.fee ?? 0,
          net: opts.amount - (opts.fee ?? 0),
          currency: 'eur',
          available_on: 1_763_510_400,
        },
        {
          id: ids.chId,
          object: 'charge',
          amount: opts.amount,
          currency: 'eur',
          status: 'succeeded',
          paid: true,
          amount_refunded: 0,
          disputed: false,
          created: Math.floor(Date.now() / 1000),
          on_behalf_of: ACCT[m.tenantId],
          customer: m.cusId,
          payment_intent: ids.piId,
          transfer_group: null,
          presentment_details: opts.presentment
            ? {
                presentment_amount: opts.presentment.amount,
                presentment_currency: opts.presentment.currency,
              }
            : null,
          balance_transaction: btId,
        },
        {
          id: ids.piId,
          object: 'payment_intent',
          latest_charge: ids.chId,
          on_behalf_of: ACCT[m.tenantId],
        },
      );
    }
    const now = Math.floor(Date.now() / 1000);
    const invoice = {
      id: ids.invoiceId,
      object: 'invoice',
      status: 'paid',
      amount_paid: opts.amount,
      amount_due: opts.amount,
      currency: 'eur',
      livemode: false,
      customer: m.cusId,
      customer_email: m.email,
      on_behalf_of: ACCT[m.tenantId],
      billing_reason: opts.reason ?? 'subscription_cycle',
      created: now,
      period_start: now,
      period_end: now + 30 * 86400,
      parent: { type: 'subscription_details', subscription_details: { subscription: m.subId } },
      lines: { object: 'list', data: [{ description: '1 × Mensual (at €29.00 / month)' }] },
    };
    fake.seed({
      ...invoice,
      payments: {
        object: 'list',
        data:
          opts.amount > 0
            ? [
                {
                  status: 'paid',
                  is_default: true,
                  payment: { type: 'payment_intent', payment_intent: ids.piId },
                },
              ]
            : [],
      },
    });
    // El evento NO trae `payments` (hay que expandirlo): la venta los lee de la API.
    return { ...ids, invoice };
  }

  const saleOf = (chId: string) =>
    admin.modPayoutsSale.findUniqueOrThrow({ where: { stripeChargeId: chId } });
  const localSub = (subId: string) =>
    admin.modSubscriptionsSubscription.findUniqueOrThrow({
      where: { stripeSubscriptionId: subId },
    });
  const ledgerOf = async (saleId: string) =>
    (
      await admin.modPayoutsLedgerEntry.findMany({
        where: { saleId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((e) => [e.type, e.amount] as const);

  // ══════════════════════════════ casos ══════════════════════════════

  it('alta de 29 € con invoice.paid ANTES que checkout.session.completed: venta 2900, comisión 69, transferencia 2686', async () => {
    const m = await membershipCheckout(A);
    const first = paidInvoice(m, { amount: 2900, fee: 69, reason: 'subscription_create' });

    // 1) invoice.paid llega primero: ni la suscripción ni el cliente están en el
    //    registro → se pregunta a Stripe por la sesión de origen. El dinero se
    //    anota y se liquida; el módulo de suscripciones aún no tiene la fila y
    //    pide reintento (5xx).
    const paidEvent = evtId('paid1');
    await expect(
      platform.handle(signed('invoice.paid', first.invoice, paidEvent)),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTIONS_WEBHOOK_OUT_OF_ORDER' });
    const sale = await saleOf(first.chId);
    expect(sale).toMatchObject({
      tenantId: A,
      accountId: ACCOUNT_ID[A],
      sourceKind: 'SUBSCRIPTION_INVOICE',
      sourceRef: first.invoiceId,
      stripeInvoiceId: first.invoiceId,
      stripePaymentIntentId: first.piId,
      buyerEmail: m.email,
      presentmentAmount: 2900,
      presentmentCurrency: 'eur',
      gross: 2900,
      stripeFee: 69,
      feeBpsApplied: 500,
      platformFee: 145,
      creatorNet: 2686,
      transferAmount: 2686,
      currency: 'eur',
      status: 'TRANSFERRED',
    });
    expect(await ledgerOf(sale.id)).toEqual([
      ['SALE_GROSS', 2900],
      ['STRIPE_FEE', -69],
      ['PLATFORM_FEE', -145],
      ['TRANSFER', -2686],
    ]);
    const refs = await admin.modPayoutsObjectRef.findMany({
      where: {
        stripeObjectId: { in: [m.subId, m.cusId, first.invoiceId, first.piId, first.chId] },
      },
      orderBy: { stripeObjectId: 'asc' },
    });
    expect(refs.map((r) => [r.kind, r.tenantId])).toEqual(
      expect.arrayContaining([
        ['subscription', A],
        ['customer', A],
        ['invoice', A],
        ['payment_intent', A],
        ['charge', A],
      ]),
    );
    expect(refs).toHaveLength(5);

    // 2) checkout.session.completed: alta del miembro (suscripción ACTIVE).
    const completed = await platform.handle(
      signed('checkout.session.completed', completedObject(m), evtId('completed')),
    );
    expect(completed).toEqual({ received: true, outcome: 'processed' });
    expect(await localSub(m.subId)).toMatchObject({
      tenantId: A,
      planId: m.planId,
      status: 'ACTIVE',
    });

    // 3) Stripe reintenta invoice.paid: ahora el módulo la registra; la venta no se duplica.
    const retried = await platform.handle(signed('invoice.paid', first.invoice, paidEvent));
    expect(retried).toEqual({
      received: true,
      outcome: 'processed',
      sale: 'exists',
      settlement: 'already_settled',
    });
    expect(
      await admin.modSubscriptionsInvoice.count({ where: { stripeInvoiceId: first.invoiceId } }),
    ).toBe(1);
    expect(await admin.modPayoutsSale.count({ where: { stripeChargeId: first.chId } })).toBe(1);
    expect(
      fake
        .callsTo('POST', '/v1/transfers')
        .filter((c) => c.params['source_transaction'] === first.chId),
    ).toHaveLength(1);
    expect(transfers.find((t) => t['source_transaction'] === first.chId)).toMatchObject({
      amount: 2686,
      currency: 'eur',
      destination: ACCT[A],
    });

    // 4) Renovación (reloj de pruebas en el sandbox): segunda venta, mismo reparto.
    const renewal = paidInvoice(m, { amount: 2900, fee: 69 });
    const renewed = await platform.handle(signed('invoice.paid', renewal.invoice, evtId('renew')));
    expect(renewed).toEqual({
      received: true,
      outcome: 'processed',
      sale: 'created',
      settlement: 'transferred',
    });
    expect(await saleOf(renewal.chId)).toMatchObject({
      sourceRef: renewal.invoiceId,
      stripeFee: 69,
      platformFee: 145,
      transferAmount: 2686,
      status: 'TRANSFERRED',
    });
    expect(
      await admin.modPayoutsSale.count({
        where: { tenantId: A, stripeInvoiceId: { in: [first.invoiceId, renewal.invoiceId] } },
      }),
    ).toBe(2);
  });

  it('prueba de 7 días: la factura de 0 € no crea venta; la primera con importe, sí', async () => {
    const m = await membershipCheckout(A, { trialDays: 7 });
    const created = await platform.handle(
      signed(
        'customer.subscription.created',
        subscriptionObject(m, 'trialing'),
        evtId('subcreated'),
      ),
    );
    expect(created).toEqual({ received: true, outcome: 'processed' });
    // Atribuido por la sesión de origen y atado: lo que venga después va por el registro.
    expect(
      await admin.modPayoutsObjectRef.findUniqueOrThrow({ where: { stripeObjectId: m.subId } }),
    ).toMatchObject({ tenantId: A, kind: 'subscription', parentObjectId: m.sessionId });

    await platform.handle(
      signed('checkout.session.completed', completedObject(m, 'no_payment_required'), evtId('c')),
    );
    expect((await localSub(m.subId)).status).toBe('TRIALING');

    const trial = paidInvoice(m, { amount: 0, reason: 'subscription_create' });
    const zero = await platform.handle(signed('invoice.paid', trial.invoice, evtId('zero')));
    expect(zero).toEqual({ received: true, outcome: 'processed', sale: 'no_charge' });
    expect(await admin.modPayoutsSale.count({ where: { stripeInvoiceId: trial.invoiceId } })).toBe(
      0,
    );
    expect((await localSub(m.subId)).status).toBe('TRIALING');

    const firstCharge = paidInvoice(m, { amount: 2900, fee: 69 });
    const charged = await platform.handle(
      signed('invoice.paid', firstCharge.invoice, evtId('fin')),
    );
    expect(charged).toMatchObject({ sale: 'created', settlement: 'transferred' });
    expect((await saleOf(firstCharge.chId)).transferAmount).toBe(2686);
    expect((await localSub(m.subId)).status).toBe('ACTIVE');
  });

  it('Adaptive Pricing: factura en EUR, el alumno paga en MXN → presentment en MXN y bruto en EUR', async () => {
    const m = await membershipCheckout(A);
    await platform.handle(signed('checkout.session.completed', completedObject(m), evtId('cmx')));
    const mx = paidInvoice(m, {
      amount: 2900,
      fee: 69,
      reason: 'subscription_create',
      presentment: { amount: 62_383, currency: 'mxn' },
    });
    await platform.handle(signed('invoice.paid', mx.invoice, evtId('mx')));
    expect(await saleOf(mx.chId)).toMatchObject({
      presentmentAmount: 62_383,
      presentmentCurrency: 'mxn',
      gross: 2900,
      currency: 'eur',
      platformFee: 145,
      transferAmount: 2686,
    });
  });

  it('impago: invoice.payment_failed no mueve dinero (el acceso lo gobierna el módulo)', async () => {
    const m = await membershipCheckout(A);
    await platform.handle(signed('checkout.session.completed', completedObject(m), evtId('cf')));
    const failedInvoice = {
      ...paidInvoice(m, { amount: 0 }).invoice,
      status: 'open',
      amount_paid: 0,
      amount_due: 2900,
      attempt_count: 1,
      next_payment_attempt: null,
    };
    const before = await admin.modPayoutsSale.count({ where: { tenantId: A } });
    const result = await platform.handle(
      signed('invoice.payment_failed', failedInvoice, evtId('failed')),
    );
    expect(result).toEqual({ received: true, outcome: 'processed' });
    expect(await admin.modPayoutsSale.count({ where: { tenantId: A } })).toBe(before);
    expect((await localSub(m.subId)).status).toBe('PAST_DUE');
  });

  it('RLS como didacta_app: el aula B no ve las ventas ni el registro de las membresías de A', async () => {
    const m = await membershipCheckout(A);
    await platform.handle(signed('checkout.session.completed', completedObject(m), evtId('crls')));
    const inv = paidInvoice(m, { amount: 2900, fee: 69, reason: 'subscription_create' });
    await platform.handle(signed('invoice.paid', inv.invoice, evtId('rls')));

    const seenByA = await runAsTenant(A, () =>
      prisma.modPayoutsSale.count({ where: { stripeChargeId: inv.chId } }),
    );
    const seenByB = await runAsTenant(B, () =>
      prisma.modPayoutsSale.count({ where: { stripeChargeId: inv.chId } }),
    );
    const refsSeenByB = await runAsTenant(B, () =>
      prisma.modPayoutsObjectRef.count({
        where: { stripeObjectId: { in: [m.subId, inv.invoiceId, inv.chId] } },
      }),
    );
    expect([seenByA, seenByB, refsSeenByB]).toEqual([1, 0, 0]);
  });

  it('cuenta restringida con renovaciones vivas → la venta se anota HELD, sin transferencia, y alerta', async () => {
    const m = await membershipCheckout(B);
    await platform.handle(signed('checkout.session.completed', completedObject(m), evtId('cb')));
    await admin.modPayoutsAccount.update({
      where: { id: ACCOUNT_ID[B] },
      data: { status: 'RESTRICTED' },
    });
    try {
      const inv = paidInvoice(m, { amount: 2900, fee: 69 });
      const result = await platform.handle(signed('invoice.paid', inv.invoice, evtId('held')));
      expect(result).toMatchObject({ sale: 'created', settlement: 'held' });
      expect(await saleOf(inv.chId)).toMatchObject({
        status: 'HELD',
        transferAmount: 2686,
        stripeTransferId: null,
      });
      expect(transfers.some((t) => t['source_transaction'] === inv.chId)).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ alert: 'payouts.renewal_on_blocked_account', tenantId: B }),
        expect.any(String),
      );
    } finally {
      await admin.modPayoutsAccount.update({
        where: { id: ACCOUNT_ID[B] },
        data: { status: 'READY' },
      });
    }
  });
});
