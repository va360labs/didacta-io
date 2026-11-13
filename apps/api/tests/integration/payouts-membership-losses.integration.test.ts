/**
 * Membresías (E5) × reembolsos, disputas y desconexión (E6), contra un
 * Postgres REAL conectando como el runtime de producción: rol `didacta_app`
 * (NOSUPERUSER, NOBYPASSRLS) y RLS forzada.
 *
 * Lo que se comprueba aquí es la UNIÓN de las dos etapas:
 *
 *  - La venta de una FACTURA de membresía sigue el MISMO camino que la de un
 *    curso al reembolsarla (desde el botón o a mano en Stripe) o al
 *    disputarla: mismos asientos, mismas cifras, el libro cuadra.
 *  - Una disputa que llega antes que la factura se pone al día en cuanto la
 *    factura anota su venta, como en la compra de un curso.
 *  - «Desconectar cobros» deja las suscripciones vivas en
 *    `cancel_at_period_end` leyéndolas de `mod_payouts_object_ref`, donde las
 *    registra el webhook de E5 al dar de alta la membresía; y el módulo de
 *    suscripciones lo refleja con su `customer.subscription.updated`.
 *
 * De verdad: el webhook de plataforma, el `PayoutsRuntime`, la liquidación,
 * reembolsos, disputas, desconexión, el conciliador (invariantes), los
 * servicios de billing, suscripciones y membresía, y la extensión RLS de
 * Prisma. Simulado: Stripe (el doble en memoria de `mod.payouts`).
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
  PayoutsReconcilerService,
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

const OPERATOR_SECRET = 'whsec_operador_e5e6_integracion';
const CONFIG = loadPlatformPaymentsConfig({
  PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: 'sk_test_inventadaE5E6',
  PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: OPERATOR_SECRET,
}) as PlatformPaymentsEnabled;

describeWithDb('Membresías × reembolsos, disputas y desconexión — Postgres real', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let runtime: PayoutsRuntime;
  let platform: PlatformWebhookController;
  let reconciler: PayoutsReconcilerService;

  // A: casos sueltos. B: desconexión. C y D: comparaciones factura/curso, cada
  // una en su aula para que la deuda de un caso no se compense en otro.
  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();
  const D = randomUUID();
  const TENANTS: string[] = [A, B, C, D];
  const stamp = Date.now();
  const ACCT: Record<string, string> = Object.fromEntries(
    TENANTS.map((id, i) => [id, `acct_1E56${'ABCD'[i]}${stamp}`]),
  );
  const ACCOUNT_ID: Record<string, string> = Object.fromEntries(
    TENANTS.map((id) => [id, randomUUID()]),
  );

  const fake = new InMemoryPlatformStripeClient({ livemode: false });
  const transfers: StripeObject[] = [];
  const refundsInStripe: StripeObject[] = [];
  const reversals: StripeObject[] = [];
  const disputesInStripe: StripeObject[] = [];
  const sessionBySubscription = new Map<string, string>();
  const sessionByPaymentIntent = new Map<string, string>();
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

      for (const [id, slug] of TENANTS.map((id, i) => [id, 'abcd'[i]!] as const)) {
        await admin.tenant.create({
          data: { id, slug: `e56-${slug}-${stamp}`, name: `Aula E5E6 ${slug}` },
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
          amount_reversed: 0,
          currency: req.params['currency'],
          destination: req.params['destination'],
          source_transaction: req.params['source_transaction'] ?? null,
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
        data: transfers
          .map((t) => fake.get(t['id'] as string)!)
          .filter(
            (t) =>
              (req.params['transfer_group'] === undefined ||
                t['transfer_group'] === req.params['transfer_group']) &&
              (req.params['destination'] === undefined ||
                t['destination'] === req.params['destination']),
          )
          .reverse(),
      }));
      fake.on('POST', '/v1/refunds', (req, f) => {
        const chargeId = req.params['charge'] as string;
        const charge = f.get(chargeId)!;
        const amount =
          (req.params['amount'] as number | undefined) ??
          (charge['amount'] as number) - (charge['amount_refunded'] as number);
        const refund = {
          id: `re_${f.nextId('x').slice(2)}_${stamp}`,
          object: 'refund',
          amount,
          currency: charge['currency'],
          charge: chargeId,
          status: 'succeeded',
          metadata: req.params['metadata'] ?? {},
          livemode: false,
        };
        refundsInStripe.push(refund);
        f.seed(refund);
        f.patch(chargeId, {
          amount_refunded: (charge['amount_refunded'] as number) + amount,
          refunded: (charge['amount_refunded'] as number) + amount >= (charge['amount'] as number),
        });
        return refund;
      });
      fake.on('GET', '/v1/refunds', (req) => ({
        object: 'list',
        has_more: false,
        data: refundsInStripe
          .map((r) => fake.get(r['id'] as string)!)
          .filter((r) => req.params['charge'] === undefined || r['charge'] === req.params['charge'])
          .reverse(),
      }));
      fake.on('GET', '/v1/transfers/:id/reversals', (req) => ({
        object: 'list',
        has_more: false,
        data: reversals.filter((r) => r['transfer'] === req.pathParams['id']).reverse(),
      }));
      fake.on('POST', '/v1/transfers/:id/reversals', (req, f) => {
        const transfer = f.get(req.pathParams['id']!)!;
        const amount = req.params['amount'] as number;
        const reversal = {
          id: `trr_${f.nextId('x').slice(2)}_${stamp}`,
          object: 'transfer_reversal',
          amount,
          transfer: transfer['id'],
          metadata: req.params['metadata'] ?? {},
        };
        reversals.push(reversal);
        f.patch(transfer['id'] as string, {
          amount_reversed: (transfer['amount_reversed'] as number) + amount,
        });
        return reversal;
      });
      fake.on('GET', '/v1/balance', () => ({
        object: 'balance',
        available: [{ currency: 'eur', amount: 100_000_000 }],
        pending: [],
      }));
      fake.on('GET', '/v1/disputes', (req) => ({
        object: 'list',
        has_more: false,
        data: disputesInStripe
          .map((d) => fake.get(d['id'] as string)!)
          .filter(
            (d) => req.params['charge'] === undefined || d['charge'] === req.params['charge'],
          ),
      }));
      for (const path of ['/v1/events', '/v1/charges']) {
        fake.on('GET', path, () => ({ object: 'list', has_more: false, data: [] }));
      }
      fake.on('GET', '/v1/checkout/sessions', (req) => {
        const id =
          req.params['subscription'] !== undefined
            ? sessionBySubscription.get(String(req.params['subscription']))
            : sessionByPaymentIntent.get(String(req.params['payment_intent']));
        return { object: 'list', has_more: false, data: id ? [{ id }] : [] };
      });
      // Desconexión: Stripe deja la suscripción para cancelar a final de periodo.
      fake.on('POST', '/v1/subscriptions/:id', (req, f) => {
        const id = req.pathParams['id']!;
        f.patch(id, {
          cancel_at_period_end: req.params['cancel_at_period_end'],
          metadata: req.params['metadata'],
        });
        return f.get(id)!;
      });

      // ── servicios de verdad ──
      const publisher = { publish: async () => undefined };
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
      const provisioning = { provision: async () => ({ userId: randomUUID(), created: true }) };
      runtime = new PayoutsRuntime(CONFIG, fake, prisma, stripeResolver, logger as never);
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
      reconciler = new PayoutsReconcilerService({
        db: runtime.db,
        stripe: fake,
        settlement: runtime.settlement,
        replayEvent: (event) => platform.process(event),
        losses: { refunds: runtime.refunds, disputes: runtime.disputes, debts: runtime.debts },
        logger: logger as never,
      });
    } finally {
      process.env['DATABASE_URL'] = previous.url;
      if (previous.mode === undefined) delete process.env['RLS_ENFORCEMENT'];
      else process.env['RLS_ENFORCEMENT'] = previous.mode;
      if (previous.redis !== undefined) process.env['REDIS_URL'] = previous.redis;
    }
  }, 90_000);

  afterAll(async () => {
    // El libro es de solo inserción: sus filas se quedan en la base desechable.
    // Las cuentas se cierran para que los barridos de otros ficheros no las vean.
    await admin?.modPayoutsAccount.updateMany({
      where: { tenantId: { in: TENANTS } },
      data: { closedAt: new Date(), status: 'DISCONNECTED' },
    });
    await admin?.modPayoutsDebt.updateMany({
      where: { tenantId: { in: TENANTS }, status: 'OPEN' },
      data: { status: 'WRITTEN_OFF' },
    });
    await closeModule?.();
    await admin?.$disconnect();
  });

  // ── utilidades ──

  let seq = 0;
  const evtId = (label: string) => `evt_e56_${label}_${stamp}_${++seq}`;

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

  function seedCharge(
    tenantId: string,
    ids: { chId: string; piId: string; cusId: string },
    opts: { amount: number; fee: number; disputed?: boolean; transferGroup?: string | null },
  ) {
    const btId = `txn_${ids.chId}`;
    fake.seed(
      {
        id: btId,
        object: 'balance_transaction',
        type: 'charge',
        amount: opts.amount,
        fee: opts.fee,
        net: opts.amount - opts.fee,
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
        disputed: opts.disputed ?? false,
        created: Math.floor(Date.now() / 1000),
        on_behalf_of: ACCT[tenantId],
        customer: ids.cusId,
        payment_intent: ids.piId,
        transfer_group: opts.transferGroup ?? null,
        balance_transaction: btId,
      },
      {
        id: ids.piId,
        object: 'payment_intent',
        latest_charge: ids.chId,
        on_behalf_of: ACCT[tenantId],
      },
    );
  }

  /** Compra de un curso cobrada por la plataforma y TRANSFERIDA, por el webhook. */
  async function courseSold(tenantId: string, opts: { amount: number; fee: number }) {
    const orderId = randomUUID();
    const tag = orderId.replace(/-/g, '');
    const ids = {
      orderId,
      sessionId: `cs_test_c${tag}`,
      piId: `pi_c${tag}`,
      chId: `ch_c${tag}`,
      cusId: `cus_c${tag}`,
    };
    await admin.modBillingOrder.create({
      data: {
        id: orderId,
        tenantId,
        userId: null,
        productId: randomUUID(),
        courseId: randomUUID(),
        stripeSessionId: ids.sessionId,
        currency: 'eur',
      },
    });
    await admin.modPayoutsObjectRef.create({
      data: {
        stripeObjectId: ids.sessionId,
        tenantId,
        kind: 'checkout_session',
        source: 'billing',
        localRef: orderId,
      },
    });
    seedCharge(tenantId, ids, { ...opts, transferGroup: `didacta_${orderId}` });
    fake.seed({
      id: ids.sessionId,
      object: 'checkout.session',
      mode: 'payment',
      payment_status: 'paid',
      livemode: false,
      customer: ids.cusId,
      customer_details: { email: `alumna-${tag}@example.test` },
      payment_intent: ids.piId,
      line_items: { object: 'list', data: [{ description: 'Curso' }] },
    });
    const completed = await platform.handle(
      signed(
        'checkout.session.completed',
        {
          id: ids.sessionId,
          object: 'checkout.session',
          mode: 'payment',
          payment_status: 'paid',
          status: 'complete',
          payment_intent: ids.piId,
          client_reference_id: orderId,
          customer_details: { email: `alumna-${tag}@example.test` },
          metadata: { orderId, productId: randomUUID(), tenantId, courseId: randomUUID() },
        },
        evtId('course'),
      ),
    );
    expect(completed).toMatchObject({ outcome: 'processed', settlement: 'transferred' });
    const sale = await admin.modPayoutsSale.findUniqueOrThrow({
      where: { stripeChargeId: ids.chId },
    });
    return { ...ids, saleId: sale.id };
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
   * Alta de una membresía de 29 €/mes por el webhook (`completed`): el
   * checkout lo deja `/join` con el adaptador de plataforma (`cs_…`
   * registrado a nombre del aula) y el webhook ata `sub_…` y `cus_…`.
   */
  async function membershipSubscribed(tenantId: string): Promise<Membership> {
    const planId = randomUUID();
    const tag = planId.replace(/-/g, '').slice(0, 20);
    const m: Membership = {
      tenantId,
      planId,
      sessionId: `cs_test_m${tag}`,
      subId: `sub_1m${tag}`,
      cusId: `cus_m${tag}`,
      email: `miembro-${tag}@example.test`,
    };
    await admin.modSubscriptionsPlan.create({
      data: {
        id: planId,
        tenantId,
        name: `Mensual ${tag.slice(0, 8)}`,
        intervalMonths: 1,
        amountCents: 2900,
        currency: 'eur',
        trialDays: 0,
        stripeProductId: `prod_m${tag}`,
        stripePriceId: `price_m${tag}`,
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
    fake.seed(
      {
        id: m.sessionId,
        object: 'checkout.session',
        mode: 'subscription',
        livemode: false,
        subscription: m.subId,
        customer: m.cusId,
        payment_status: 'paid',
      },
      {
        id: m.subId,
        object: 'subscription',
        status: 'active',
        customer: m.cusId,
        cancel_at_period_end: false,
        metadata: { tenantId, membership: '1', planId },
      },
    );
    sessionBySubscription.set(m.subId, m.sessionId);
    const completed = await platform.handle(
      signed(
        'checkout.session.completed',
        {
          id: m.sessionId,
          object: 'checkout.session',
          mode: 'subscription',
          status: 'complete',
          payment_status: 'paid',
          subscription: m.subId,
          customer: m.cusId,
          client_reference_id: planId,
          customer_details: { email: m.email, name: 'Miembro' },
          metadata: { tenantId, membership: '1', planId },
        },
        evtId('mcompleted'),
      ),
    );
    expect(completed).toEqual({ received: true, outcome: 'processed' });
    return m;
  }

  /** Una factura de la membresía, cobrada, con la forma de la API de la plataforma. */
  function invoiceOf(
    m: Membership,
    opts: { amount: number; fee: number; disputed?: boolean; reason?: string },
  ) {
    const tag = randomUUID().replace(/-/g, '').slice(0, 20);
    const ids = {
      invoiceId: `in_m${tag}`,
      piId: `pi_m${tag}`,
      chId: `ch_m${tag}`,
      cusId: m.cusId,
    };
    seedCharge(m.tenantId, ids, opts);
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
        data: [
          {
            status: 'paid',
            is_default: true,
            payment: { type: 'payment_intent', payment_intent: ids.piId },
          },
        ],
      },
    });
    return { ...ids, invoice };
  }

  /** Factura de la membresía cobrada y TRANSFERIDA por el webhook. */
  async function invoiceSold(m: Membership, opts: { amount: number; fee: number }) {
    const inv = invoiceOf(m, opts);
    const paid = await platform.handle(signed('invoice.paid', inv.invoice, evtId('paid')));
    expect(paid).toMatchObject({
      outcome: 'processed',
      sale: 'created',
      settlement: 'transferred',
    });
    const sale = await admin.modPayoutsSale.findUniqueOrThrow({
      where: { stripeChargeId: inv.chId },
    });
    expect(sale.sourceKind).toBe('SUBSCRIPTION_INVOICE');
    return { ...inv, saleId: sale.id };
  }

  /** Asientos de la venta que no son del reparto, sumados por tipo. */
  async function lossEntries(saleId: string): Promise<Record<string, number>> {
    const rows = await admin.modPayoutsLedgerEntry.findMany({ where: { saleId } });
    const out: Record<string, number> = {};
    for (const row of rows) {
      const key = row.idempotencyKey;
      if (key.startsWith('payouts:sale:') || key.startsWith('payouts:transfer:')) continue;
      if (/^payouts:debt-recovery:[^:]+:sale:/.test(key)) continue;
      out[row.type] = (out[row.type] ?? 0) + row.amount;
    }
    return out;
  }

  async function violationsOfOurTenants() {
    const { violations } = await reconciler.checkInvariants(null);
    return violations.filter((v) => TENANTS.includes(v.tenantId));
  }

  function seedDispute(
    id: string,
    chargeId: string,
    status: string,
    amount: number,
    bts: Array<{ amount: number; fee: number }>,
  ) {
    const dispute = {
      id,
      object: 'dispute',
      amount,
      currency: 'eur',
      charge: chargeId,
      status,
      reason: 'fraudulent',
      livemode: false,
      evidence_details: { due_by: 1_763_769_600 },
      balance_transactions: bts.map((bt, i) => ({
        id: `txn_${id}_${i}`,
        object: 'balance_transaction',
        amount: bt.amount,
        fee: bt.fee,
        currency: 'eur',
      })),
    };
    fake.seed(dispute);
    if (!disputesInStripe.some((d) => d['id'] === id)) disputesInStripe.push(dispute);
  }

  // ══════════════════ reembolsos: factura = curso ══════════════════

  it('reembolso parcial desde el botón: la factura de una membresía anota lo mismo que un curso del mismo importe', async () => {
    const m = await membershipSubscribed(C);
    const invoice = await invoiceSold(m, { amount: 2900, fee: 69 });
    const course = await courseSold(C, { amount: 2900, fee: 69 });

    for (const saleId of [invoice.saleId, course.saleId]) {
      const result = await runtime.refunds.refund({
        tenantId: C,
        saleId,
        amount: 1000,
        initiatedBy: 'admin-a',
      });
      expect(result).toMatchObject({ status: 'succeeded', accounting: 'accounted', amount: 1000 });
    }
    const ofInvoice = await lossEntries(invoice.saleId);
    expect(ofInvoice).toEqual(await lossEntries(course.saleId));
    expect(ofInvoice).toMatchObject({ REFUND: -1000 });
    expect(ofInvoice['TRANSFER_REVERSAL']).toBeGreaterThan(0);
    const saleInvoice = await admin.modPayoutsSale.findUniqueOrThrow({
      where: { id: invoice.saleId },
    });
    const saleCourse = await admin.modPayoutsSale.findUniqueOrThrow({
      where: { id: course.saleId },
    });
    expect([saleInvoice.refundedAmount, saleInvoice.reversedAmount]).toEqual([
      saleCourse.refundedAmount,
      saleCourse.reversedAmount,
    ]);
    // La membresía sigue viva: un reembolso parcial no da de baja a nadie.
    expect(
      (
        await admin.modSubscriptionsSubscription.findUniqueOrThrow({
          where: { stripeSubscriptionId: m.subId },
        })
      ).status,
    ).toBe('ACTIVE');
    expect(await violationsOfOurTenants()).toEqual([]);
  });

  it('reembolso hecho a mano en Stripe sobre una factura: charge.refunded se atribuye por el registro y se anota', async () => {
    const m = await membershipSubscribed(A);
    const invoice = await invoiceSold(m, { amount: 2900, fee: 69 });
    await fake.v1('POST', '/v1/refunds', { charge: invoice.chId, amount: 900 });
    const event = await platform.handle(
      signed(
        'charge.refunded',
        {
          id: invoice.chId,
          object: 'charge',
          payment_intent: invoice.piId,
          invoice: invoice.invoiceId,
          amount: 2900,
          amount_refunded: 900,
        },
        evtId('manual'),
      ),
    );
    expect(event).toMatchObject({ outcome: 'processed', refund: 'synced' });
    const rows = await admin.modPayoutsRefund.findMany({ where: { saleId: invoice.saleId } });
    expect(rows.map((r) => [r.initiatedBy, r.amount, r.reversalStatus])).toEqual([
      ['stripe_dashboard', 900, 'DONE'],
    ]);
    expect(await violationsOfOurTenants()).toEqual([]);
  });

  // ══════════════════ disputas: factura = curso ══════════════════

  it('disputa perdida de una factura: mismos asientos y la misma deuda que la de un curso', async () => {
    const m = await membershipSubscribed(D);
    const invoice = await invoiceSold(m, { amount: 2900, fee: 69 });
    const course = await courseSold(D, { amount: 2900, fee: 69 });
    const withdrawn = [{ amount: -2900, fee: 2000 }];

    for (const [label, sale] of [
      ['inv', invoice],
      ['cur', course],
    ] as const) {
      const dp = `dp_${label}_${stamp}`;
      const obj = { id: dp, object: 'dispute', charge: sale.chId, payment_intent: sale.piId };
      seedDispute(dp, sale.chId, 'needs_response', 2900, withdrawn);
      expect(
        await platform.handle(signed('charge.dispute.funds_withdrawn', obj, evtId(`${label}w`))),
      ).toMatchObject({ outcome: 'processed', dispute: 'synced' });
      seedDispute(dp, sale.chId, 'lost', 2900, withdrawn);
      expect(
        await platform.handle(signed('charge.dispute.closed', obj, evtId(`${label}c`))),
      ).toMatchObject({ outcome: 'processed', dispute: 'synced' });
    }

    const ofInvoice = await lossEntries(invoice.saleId);
    expect(ofInvoice).toEqual(await lossEntries(course.saleId));
    expect(ofInvoice).toMatchObject({ DISPUTE_WITHDRAWN: -2900, DISPUTE_FEE: -2000 });
    const debtsOf = async (saleId: string) =>
      (await admin.modPayoutsDebt.findMany({ where: { originSaleId: saleId } }))
        .map((d) => [d.reason, d.amountOriginal, d.status])
        .sort();
    expect(await debtsOf(invoice.saleId)).toEqual(await debtsOf(course.saleId));
    expect(
      await admin.modPayoutsDispute.findFirstOrThrow({
        where: { stripeDisputeId: `dp_inv_${stamp}` },
      }),
    ).toMatchObject({ tenantId: D, saleId: invoice.saleId, outcome: 'lost', amount: 2900 });
    expect(await violationsOfOurTenants()).toEqual([]);
  });

  it('disputa de una renovación que llega ANTES que su invoice.paid: la venta de la factura la pone al día al anotarse', async () => {
    const m = await membershipSubscribed(A);
    const inv = invoiceOf(m, { amount: 2900, fee: 69, disputed: true });
    const dp = `dp_early_inv_${stamp}`;
    seedDispute(dp, inv.chId, 'needs_response', 2900, [{ amount: -2900, fee: 2000 }]);

    // Ni el cargo ni la factura están aún en el registro: Stripe no da sesión
    // por el PaymentIntent de una renovación → sin atribuir.
    const early = await platform.handle(
      signed(
        'charge.dispute.created',
        { id: dp, object: 'dispute', charge: inv.chId, payment_intent: inv.piId },
        evtId('early'),
      ),
    );
    expect(early).toMatchObject({ outcome: 'unattributed' });

    const paid = await platform.handle(signed('invoice.paid', inv.invoice, evtId('latepaid')));
    expect(paid).toMatchObject({ outcome: 'processed', sale: 'created', settlement: 'held' });
    const sale = await admin.modPayoutsSale.findUniqueOrThrow({
      where: { stripeChargeId: inv.chId },
    });
    // La disputa ya consta y se ha descontado de lo que había que transferir.
    expect(
      await admin.modPayoutsDispute.findFirstOrThrow({ where: { stripeDisputeId: dp } }),
    ).toMatchObject({ tenantId: A, saleId: sale.id });
    expect(sale).toMatchObject({ status: 'SETTLED_NETTED', stripeTransferId: null });
    expect(await lossEntries(sale.id)).toMatchObject({
      DISPUTE_WITHDRAWN: -2900,
      DISPUTE_FEE: -2000,
    });
    expect(transfers.some((t) => t['source_transaction'] === inv.chId)).toBe(false);
    expect(await violationsOfOurTenants()).toEqual([]);
  });

  // ══════════════════ desconexión (punto de unión E5 × E6) ══════════════════

  it('desconectar: las membresías vivas registradas por el webhook de E5 pasan a cancel_at_period_end y el aula lo refleja', async () => {
    const live = await membershipSubscribed(B);
    await invoiceSold(live, { amount: 2900, fee: 69 });
    const alreadyLeaving = await membershipSubscribed(B);
    fake.patch(alreadyLeaving.subId, { cancel_at_period_end: true });
    const ended = await membershipSubscribed(B);
    fake.patch(ended.subId, { status: 'canceled' });

    // Las tres están en el registro, como `subscription` del aula B, por el webhook.
    const registered = await admin.modPayoutsObjectRef.findMany({
      where: {
        tenantId: B,
        kind: 'subscription',
        stripeObjectId: { in: [live.subId, alreadyLeaving.subId, ended.subId] },
      },
    });
    expect(registered).toHaveLength(3);

    const result = await runtime.offboarding.disconnect(B, { reason: 'creator' });
    expect(result).toMatchObject({
      changed: true,
      account: { status: 'DISCONNECTED' },
      subscriptionsScheduled: 1,
      subscriptionsFailed: 0,
    });
    const posts = fake.callsTo('POST', /^\/v1\/subscriptions\//);
    expect(posts.map((c) => [c.path, c.params['cancel_at_period_end']])).toEqual([
      [`/v1/subscriptions/${live.subId}`, true],
    ]);
    expect(posts[0]!.params['metadata']).toEqual({ didacta_cancel_reason: 'payouts_creator' });

    // Stripe avisa del cambio: el módulo lo refleja y el miembro conserva el acceso.
    const updated = await platform.handle(
      signed(
        'customer.subscription.updated',
        {
          ...fake.get(live.subId)!,
          metadata: { tenantId: B, membership: '1', planId: live.planId },
        },
        evtId('subupd'),
      ),
    );
    expect(updated).toMatchObject({ outcome: 'processed' });
    expect(
      await admin.modSubscriptionsSubscription.findUniqueOrThrow({
        where: { stripeSubscriptionId: live.subId },
      }),
    ).toMatchObject({ tenantId: B, status: 'ACTIVE', cancelAtPeriodEnd: true });

    // Sin cobros listos, el checkout se cierra; el aula A sigue vendiendo.
    expect(await runAsTenant(B, () => runtime.mode.resolve(B))).toEqual({
      mode: 'platform',
      ready: false,
      reason: 'disconnected',
    });
    expect(await runAsTenant(A, () => runtime.mode.resolve(A))).toMatchObject({ ready: true });

    // Repetir la desconexión no vuelve a tocar Stripe (idempotente).
    const again = await runtime.offboarding.disconnect(B, { reason: 'creator' });
    expect(again).toMatchObject({ subscriptionsScheduled: 0 });
    expect(fake.callsTo('POST', /^\/v1\/subscriptions\//)).toHaveLength(1);
  });
});
