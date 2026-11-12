/**
 * Liquidación, conciliador y «Tus ventas» (cobros de plataforma, E4) contra un
 * Postgres REAL, conectando como el runtime de producción: rol `didacta_app`
 * (NOSUPERUSER, NOBYPASSRLS) y RLS forzada.
 *
 * Lo que solo se ve con la base de verdad: dos liquidaciones simultáneas de la
 * misma venta (la venta como cerrojo con actualización condicionada), dos
 * ventas a la vez sobre la misma deuda (cerrojo consultivo por cuenta y
 * divisa), el libro de solo inserción, la RLS de ventas y resumen, y el
 * acceso global sancionado del conciliador y del volumen del pool.
 *
 * De verdad: el webhook de plataforma, el `PayoutsRuntime`, la liquidación,
 * el conciliador, los servicios de billing/suscripciones/membresía (el
 * acceso al curso) y la extensión RLS de Prisma. Simulado: Stripe (el doble
 * en memoria de `mod.payouts`).
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
  type PlatformStripeEvent,
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

const OPERATOR_SECRET = 'whsec_operador_e4_integracion';
const CONFIG = loadPlatformPaymentsConfig({
  PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: 'sk_test_inventadaE4',
  PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: OPERATOR_SECRET,
}) as PlatformPaymentsEnabled;

describeWithDb('Liquidación y conciliador — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let runtime: PayoutsRuntime;
  let platform: PlatformWebhookController;
  let reconciler: PayoutsReconcilerService;

  const A = randomUUID();
  const B = randomUUID();
  const stamp = Date.now();
  const ACCT: Record<string, string> = { [A]: `acct_1E4A${stamp}`, [B]: `acct_1E4B${stamp}` };
  const ACCOUNT_ID: Record<string, string> = { [A]: randomUUID(), [B]: randomUUID() };

  const fake = new InMemoryPlatformStripeClient({ livemode: false });
  const transfers: StripeObject[] = [];
  const stripeCharges: StripeObject[] = [];
  const stripeEvents: StripeObject[] = [];
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
          data: { id, slug: `e4-${slug}-${stamp}`, name: `Aula ${slug}` },
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
            payoutSchedule: {
              interval: 'weekly',
              weeklyDay: 'monday',
              monthlyDay: null,
              delayDays: 7,
              minimumBalance: null,
            },
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

      // ── Stripe: transferencias, listados de cargos y eventos ──
      fake.on('POST', '/v1/transfers', (req, f) => {
        const transfer = {
          id: `${f.nextId('tr')}_${stamp}`,
          object: 'transfer',
          amount: req.params['amount'],
          amount_reversed: 0,
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
      fake.on('GET', '/v1/charges', () => ({
        object: 'list',
        has_more: false,
        data: [...stripeCharges].reverse(),
      }));
      fake.on('GET', '/v1/events', () => ({
        object: 'list',
        has_more: false,
        data: [...stripeEvents].reverse(),
      }));
      fake.on('GET', '/v1/checkout/sessions', (req) => {
        const found = stripeCharges.find(
          (c) => c['payment_intent'] === req.params['payment_intent'],
        );
        return {
          object: 'list',
          has_more: false,
          data: found ? [{ id: `cs_test_${String(found['payment_intent']).slice(3)}` }] : [],
        };
      });

      // ── servicios y controladores de verdad ──
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
    // El libro es de solo inserción (trigger): sus filas, las ventas que
    // apunta y las aulas se quedan en la base desechable. Las cuentas se
    // cierran para que los barridos de cuentas de otros ficheros no las vean.
    await admin?.modPayoutsAccount.updateMany({
      where: { tenantId: { in: [A, B] } },
      data: { closedAt: new Date(), status: 'DISCONNECTED' },
    });
    await closeModule?.();
    await admin?.$disconnect();
  });

  // ── utilidades ──

  let seq = 0;
  const evtId = (label: string) => `evt_e4_${label}_${stamp}_${++seq}`;

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

  /** Orden PENDING cobrada por la plataforma (cs_ registrado) y lo que tiene Stripe. */
  async function paidOrder(
    tenantId: string,
    opts: {
      amount?: number;
      currency?: string;
      presentment?: { amount: number; currency: string };
    } = {},
  ) {
    const orderId = randomUUID();
    const tag = orderId.replace(/-/g, '');
    const ids = { orderId, sessionId: `cs_test_${tag}`, piId: `pi_${tag}`, chId: `ch_${tag}` };
    const amount = opts.amount ?? 10000;
    const currency = opts.currency ?? 'eur';
    await admin.modBillingOrder.create({
      data: {
        id: orderId,
        tenantId,
        userId: null,
        productId: randomUUID(),
        courseId: randomUUID(),
        stripeSessionId: ids.sessionId,
        currency,
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
    const charge = {
      id: ids.chId,
      object: 'charge',
      amount,
      currency,
      status: 'succeeded',
      paid: true,
      amount_refunded: 0,
      disputed: false,
      created: Math.floor(Date.now() / 1000),
      on_behalf_of: ACCT[tenantId],
      customer: `cus_${tag}`,
      payment_intent: ids.piId,
      transfer_group: `didacta_${orderId}`,
      presentment_details: opts.presentment
        ? {
            presentment_amount: opts.presentment.amount,
            presentment_currency: opts.presentment.currency,
          }
        : null,
      balance_transaction: null,
    };
    fake.seed(
      charge,
      {
        id: ids.piId,
        object: 'payment_intent',
        latest_charge: ids.chId,
        on_behalf_of: ACCT[tenantId],
      },
      {
        id: ids.sessionId,
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'paid',
        livemode: false,
        customer: `cus_${tag}`,
        customer_details: { email: `alumna-${tag}@example.test` },
        payment_intent: ids.piId,
        line_items: { object: 'list', data: [{ description: 'Curso de 100 €' }] },
      },
    );
    stripeCharges.push(fake.get(ids.chId)!);
    return ids;
  }

  const completedObject = (
    tenantId: string,
    ids: { orderId: string; sessionId: string; piId: string },
  ) => ({
    id: ids.sessionId,
    object: 'checkout.session',
    mode: 'payment',
    payment_status: 'paid',
    status: 'complete',
    payment_intent: ids.piId,
    client_reference_id: ids.orderId,
    customer_details: { email: `alumna-${ids.orderId.replace(/-/g, '')}@example.test` },
    metadata: { orderId: ids.orderId, productId: randomUUID(), tenantId, courseId: randomUUID() },
  });

  /** Stripe asienta el cargo (aparece su `balance_transaction`). */
  function settleInStripe(chId: string, bt: { amount: number; fee: number; currency: string }) {
    const btId = `txn_${chId.slice(3)}`;
    fake.seed({
      id: btId,
      object: 'balance_transaction',
      type: 'charge',
      ...bt,
      net: bt.amount - bt.fee,
      available_on: 1_763_510_400,
    });
    fake.patch(chId, { balance_transaction: btId });
  }

  const ledgerOf = async (saleId: string) =>
    (
      await admin.modPayoutsLedgerEntry.findMany({
        where: { saleId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((e) => [e.type, e.amount, e.currency] as const);
  const saleOf = (chId: string) =>
    admin.modPayoutsSale.findUniqueOrThrow({ where: { stripeChargeId: chId } });
  const postsFor = (chId: string) =>
    fake.callsTo('POST', '/v1/transfers').filter((c) => c.params['source_transaction'] === chId);

  async function violationsOfOurTenants() {
    const { violations } = await reconciler.checkInvariants(null);
    return violations.filter((v) => v.tenantId === A || v.tenantId === B);
  }

  // ══════════════════ de punta a punta por el webhook ══════════════════

  it.each([
    {
      name: 'tarjeta ES',
      amount: 10000,
      bt: { amount: 10000, fee: 175, currency: 'eur' },
      pf: 500,
      net: 9325,
    },
    {
      name: 'tarjeta US',
      amount: 10000,
      bt: { amount: 10000, fee: 340, currency: 'eur' },
      pf: 500,
      net: 9160,
    },
    {
      name: 'creador GB',
      amount: 10000,
      currency: 'gbp',
      bt: { amount: 10000, fee: 170, currency: 'gbp' },
      pf: 500,
      net: 9330,
    },
    {
      name: 'creador HU',
      amount: 3990000,
      currency: 'huf',
      bt: { amount: 3990000, fee: 68350, currency: 'huf' },
      pf: 199500,
      net: 3722150,
    },
    {
      name: 'alumno en MXN con Adaptive Pricing',
      amount: 10000,
      presentment: { amount: 214977, currency: 'mxn' },
      bt: { amount: 10000, fee: 340, currency: 'eur' },
      pf: 500,
      net: 9160,
    },
  ])(
    '$name: completed (sin comisión) → charge.updated con fee=0 en el evento y la real en la API → transferencia $net y cuatro asientos',
    async (c) => {
      const ids = await paidOrder(A, {
        amount: c.amount,
        currency: c.currency,
        presentment: c.presentment,
      });
      const completed = await platform.handle(
        signed('checkout.session.completed', completedObject(A, ids), evtId('completed')),
      );
      expect(completed).toEqual({
        received: true,
        outcome: 'processed',
        sale: 'created',
        settlement: 'awaiting_fee',
      });
      expect(
        (await admin.modBillingOrder.findUniqueOrThrow({ where: { id: ids.orderId } })).status,
      ).toBe('COMPLETED');
      expect(postsFor(ids.chId)).toHaveLength(0);

      settleInStripe(ids.chId, c.bt);
      // El evento MIENTE: comisión 0 e importe 1. La liquidación lee la API.
      const lying = {
        id: ids.chId,
        object: 'charge',
        payment_intent: ids.piId,
        amount: 1,
        balance_transaction: { id: 'txn_mentira', amount: 1, fee: 0, currency: c.bt.currency },
      };
      const updated = await platform.handle(signed('charge.updated', lying, evtId('updated')));
      expect(updated).toEqual({ received: true, outcome: 'processed', settlement: 'transferred' });

      const posts = postsFor(ids.chId);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.params).toMatchObject({
        amount: c.net,
        currency: c.bt.currency,
        destination: ACCT[A],
        source_transaction: ids.chId,
        transfer_group: `didacta_${ids.orderId}`,
      });
      const sale = await saleOf(ids.chId);
      expect(posts[0]!.options.idempotencyKey).toBe(`payouts:transfer:${sale.id}`);
      expect(sale).toMatchObject({
        status: 'TRANSFERRED',
        gross: c.bt.amount,
        stripeFee: c.bt.fee,
        platformFee: c.pf,
        creatorNet: c.net,
        transferAmount: c.net,
        currency: c.bt.currency,
        presentmentAmount: c.presentment?.amount ?? c.amount,
        presentmentCurrency: c.presentment?.currency ?? c.currency ?? 'eur',
        stripeTransferId: expect.stringMatching(/^tr_fake_\d+_\d+$/),
      });
      expect(await ledgerOf(sale.id)).toEqual([
        ['SALE_GROSS', c.bt.amount, c.bt.currency],
        ['STRIPE_FEE', -c.bt.fee, c.bt.currency],
        ['PLATFORM_FEE', -c.pf, c.bt.currency],
        ['TRANSFER', -c.net, c.bt.currency],
      ]);
    },
  );

  it('charge.updated ×5 A LA VEZ (eventos distintos) → UNA transferencia y cuatro asientos', async () => {
    const ids = await paidOrder(A);
    await platform.handle(
      signed('checkout.session.completed', completedObject(A, ids), evtId('c5')),
    );
    settleInStripe(ids.chId, { amount: 10000, fee: 175, currency: 'eur' });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        platform.handle(
          signed('charge.updated', { id: ids.chId, payment_intent: ids.piId }, evtId('par')),
        ),
      ),
    );
    expect(results.filter((r) => r.settlement === 'transferred')).toHaveLength(1);
    expect(postsFor(ids.chId)).toHaveLength(1);
    const sale = await saleOf(ids.chId);
    expect(await ledgerOf(sale.id)).toHaveLength(4);
    expect(sale.transferAmount).toBe(9325);
  });

  it('el libro sigue siendo de solo inserción: didacta_app no puede corregir un asiento', async () => {
    const ids = await paidOrder(A);
    await platform.handle(
      signed('checkout.session.completed', completedObject(A, ids), evtId('ro')),
    );
    settleInStripe(ids.chId, { amount: 10000, fee: 175, currency: 'eur' });
    await platform.handle(
      signed('charge.updated', { id: ids.chId, payment_intent: ids.piId }, evtId('ro2')),
    );
    const sale = await saleOf(ids.chId);
    await expect(
      runAsTenant(A, () =>
        prisma.$transaction((tx) =>
          tx.modPayoutsLedgerEntry.updateMany({ where: { saleId: sale.id }, data: { amount: 0 } }),
        ),
      ),
    ).rejects.toThrow();
  });

  // ══════════════════ deuda ══════════════════

  async function seedDebt(tenantId: string, currency: string, amount: number) {
    const debt = await admin.modPayoutsDebt.create({
      data: {
        tenantId,
        accountId: ACCOUNT_ID[tenantId]!,
        reason: 'MANUAL',
        amountOriginal: amount,
        amountOutstanding: amount,
        currency,
      },
    });
    await admin.modPayoutsLedgerEntry.createMany({
      data: [
        {
          tenantId,
          accountId: ACCOUNT_ID[tenantId]!,
          type: 'ADJUSTMENT',
          amount: -amount,
          currency,
          idempotencyKey: `test:ajuste:${debt.id}`,
          occurredAt: new Date(),
        },
        {
          tenantId,
          accountId: ACCOUNT_ID[tenantId]!,
          type: 'DEBT_CREATED',
          amount,
          currency,
          idempotencyKey: `test:deuda:${debt.id}`,
          occurredAt: new Date(),
        },
      ],
    });
    return debt.id;
  }

  /** Venta AWAITING_FEE ya asentada en Stripe, lista para liquidar. */
  async function pendingSale(
    tenantId: string,
    bt: { amount: number; fee: number; currency: string },
  ) {
    const ids = await paidOrder(tenantId, { amount: bt.amount, currency: bt.currency });
    // Sin pasar por el webhook (que liquidaría en línea): la anota el conciliador.
    const { recordCheckoutSale } = await import('@didacta/mod-payouts');
    const recorded = await recordCheckoutSale(
      { db: runtime.db, stripe: fake },
      { tenantId, sessionId: ids.sessionId, orderId: ids.orderId },
    );
    if (recorded.outcome !== 'created') throw new Error(recorded.outcome);
    settleInStripe(ids.chId, bt);
    return { ...ids, saleId: recorded.saleId };
  }

  it('deuda abierta 2340 y venta de 9325 → transferencia 6985 + DEBT_RECOVERED; dos ventas A LA VEZ no la compensan dos veces', async () => {
    const debtId = await seedDebt(A, 'eur', 2340);
    const one = await pendingSale(A, { amount: 10000, fee: 175, currency: 'eur' });
    const two = await pendingSale(A, { amount: 10000, fee: 175, currency: 'eur' });
    await Promise.all([
      runtime.settlement.settleSale(A, one.saleId),
      runtime.settlement.settleSale(A, two.saleId),
    ]);
    const sales = [await saleOf(one.chId), await saleOf(two.chId)];
    expect(sales.map((s) => s.debtNetted).sort()).toEqual([0, 2340]);
    expect(sales.map((s) => s.transferAmount).sort()).toEqual([6985, 9325]);
    expect(
      [...postsFor(one.chId), ...postsFor(two.chId)].map((c) => c.params['amount']).sort(),
    ).toEqual([6985, 9325]);
    expect(await admin.modPayoutsDebt.findUniqueOrThrow({ where: { id: debtId } })).toMatchObject({
      amountOutstanding: 0,
      status: 'RECOVERED',
    });
    const netted = sales.find((s) => s.debtNetted === 2340)!;
    expect(await ledgerOf(netted.id)).toEqual([
      ['SALE_GROSS', 10000, 'eur'],
      ['STRIPE_FEE', -175, 'eur'],
      ['PLATFORM_FEE', -500, 'eur'],
      ['DEBT_RECOVERED', -2340, 'eur'],
      ['TRANSFER', -6985, 'eur'],
    ]);
  });

  it('deuda en usd NO se compensa con una venta en eur', async () => {
    const debtId = await seedDebt(B, 'usd', 2340);
    const sale = await pendingSale(B, { amount: 10000, fee: 175, currency: 'eur' });
    await expect(runtime.settlement.settleSale(B, sale.saleId)).resolves.toMatchObject({
      outcome: 'transferred',
      transferAmount: 9325,
      debtNetted: 0,
    });
    expect(await admin.modPayoutsDebt.findUniqueOrThrow({ where: { id: debtId } })).toMatchObject({
      amountOutstanding: 2340,
      status: 'OPEN',
    });
  });

  it('transferencia rechazada → HELD; al vencer el reintento, el barrido la completa', async () => {
    const sale = await pendingSale(A, { amount: 10000, fee: 340, currency: 'eur' });
    fake.failNext('/v1/transfers', {
      method: 'POST',
      status: 400,
      stripeCode: 'balance_insufficient',
      message: 'Insufficient funds',
    });
    await expect(runtime.settlement.settleSale(A, sale.saleId)).resolves.toMatchObject({
      outcome: 'held',
      reason: 'transfer_rejected',
    });
    expect(await saleOf(sale.chId)).toMatchObject({
      status: 'HELD',
      attempts: 1,
      stripeTransferId: null,
    });
    await admin.modPayoutsSale.update({
      where: { id: sale.saleId },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    await expect(runtime.settlement.settleSale(A, sale.saleId)).resolves.toMatchObject({
      outcome: 'transferred',
      transferAmount: 9160,
    });
    expect(postsFor(sale.chId).map((c) => c.options.idempotencyKey)).toEqual([
      `payouts:transfer:${sale.saleId}`,
      `payouts:transfer:${sale.saleId}:1`,
    ]);
  });

  // ══════════════════ conciliador ══════════════════

  it('evento no procesado → el conciliador lo reproduce por el camino del webhook: acceso concedido y venta liquidada', async () => {
    const ids = await paidOrder(A);
    settleInStripe(ids.chId, { amount: 10000, fee: 175, currency: 'eur' });
    const id = evtId('perdido');
    stripeEvents.push({
      id,
      object: 'event',
      type: 'checkout.session.completed',
      livemode: false,
      created: Math.floor(Date.now() / 1000) - 60,
      data: { object: completedObject(A, ids) },
    } as unknown as StripeObject);
    expect(
      (await admin.modBillingOrder.findUniqueOrThrow({ where: { id: ids.orderId } })).status,
    ).toBe('PENDING');

    const report = await reconciler.run({ deep: true });
    expect(report.events.replayed).toBeGreaterThanOrEqual(1);
    expect(
      (await admin.modBillingOrder.findUniqueOrThrow({ where: { id: ids.orderId } })).status,
    ).toBe('COMPLETED');
    expect(await saleOf(ids.chId)).toMatchObject({ status: 'TRANSFERRED', transferAmount: 9325 });
    expect(
      await admin.modPayoutsWebhookEvent.findUnique({ where: { stripeEventId: id } }),
    ).toMatchObject({
      tenantId: A,
      processedAt: expect.any(Date),
      errorMessage: null,
    });
    // La siguiente pasada no lo vuelve a reproducir.
    const again = await reconciler.run({ deep: false });
    expect(postsFor(ids.chId)).toHaveLength(1);
    expect(again.events.outcomes['processed'] ?? 0).toBe(0);
  });

  it('cargo en Stripe sin venta (su sesión está registrada) → el conciliador la crea', async () => {
    const ids = await paidOrder(B);
    settleInStripe(ids.chId, { amount: 3000, fee: 70, currency: 'eur' });
    fake.patch(ids.chId, { amount: 3000 });
    stripeCharges.splice(
      stripeCharges.findIndex((c) => c['id'] === ids.chId),
      1,
      fake.get(ids.chId)!,
    );
    await expect(admin.modPayoutsSale.count({ where: { stripeChargeId: ids.chId } })).resolves.toBe(
      0,
    );
    const report = await reconciler.run({ deep: true });
    expect(report.charges.created).toBeGreaterThanOrEqual(1);
    expect(await saleOf(ids.chId)).toMatchObject({ tenantId: B, sourceRef: ids.orderId });
  });

  it('transferencia en Stripe sin asiento → SOLO alerta: ni la base ni Stripe cambian', async () => {
    const stray = {
      id: `tr_hecha_a_mano_${stamp}`,
      object: 'transfer',
      amount: 4242,
      currency: 'eur',
      destination: ACCT[A],
      created: Math.floor(Date.now() / 1000) - 3600,
      metadata: {},
    };
    transfers.push(stray);
    fake.seed(stray);
    const before = {
      sales: await admin.modPayoutsSale.findMany({
        where: { tenantId: { in: [A, B] } },
        orderBy: { id: 'asc' },
      }),
      ledger: await admin.modPayoutsLedgerEntry.count({ where: { tenantId: { in: [A, B] } } }),
    };
    // Que no haya nada pendiente que el barrido pueda mover en esta pasada.
    await reconciler.run({ deep: false });
    const postsBefore = fake.callsTo('POST', '/v1/transfers').length;
    const salesBefore = await admin.modPayoutsSale.findMany({
      where: { tenantId: { in: [A, B] } },
      orderBy: { id: 'asc' },
    });
    logger.error.mockClear();
    await reconciler.run({ deep: false });
    expect(fake.callsTo('POST', '/v1/transfers').length).toBe(postsBefore);
    expect(
      await admin.modPayoutsSale.findMany({
        where: { tenantId: { in: [A, B] } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(salesBefore);
    expect(before.ledger).toBeGreaterThan(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        alert: 'payouts.transfer_unrecorded',
        transferId: stray.id,
        amount: 4242,
      }),
      expect.any(String),
    );
  });

  // ══════════════════ «Tus ventas» con RLS ══════════════════

  it('sales y summary de A no ven nada de B (RLS como didacta_app)', async () => {
    const fromA = await runAsTenant(A, () => runtime.reports.listSales(A, { pageSize: 100 }));
    const fromB = await runAsTenant(B, () => runtime.reports.listSales(B, { pageSize: 100 }));
    expect(fromA.total).toBeGreaterThan(0);
    expect(fromB.total).toBeGreaterThan(0);
    const idsB = new Set(fromB.items.map((s) => s.id));
    expect(fromA.items.some((s) => idsB.has(s.id))).toBe(false);
    // Aunque se pida el tenant de B desde el contexto de A, RLS no deja ver nada.
    const crossed = await runAsTenant(A, () =>
      prisma.$transaction((tx) => tx.modPayoutsSale.count({ where: { tenantId: B } })),
    );
    expect(crossed).toBe(0);

    const summaryA = await runAsTenant(A, () => runtime.reports.summary(A));
    const summaryB = await runAsTenant(B, () => runtime.reports.summary(B));
    // B tiene deuda en usd; A no la ve.
    expect(summaryB.currencies.find((c) => c.currency === 'usd')?.debtOutstanding).toBe(2340);
    expect(summaryA.currencies.find((c) => c.currency === 'usd')).toBeUndefined();
    const eurA = summaryA.currencies.find((c) => c.currency === 'eur')!;
    const transferredA = await admin.modPayoutsSale.aggregate({
      where: { tenantId: A, status: 'TRANSFERRED', currency: 'eur' },
      _sum: { transferAmount: true },
    });
    expect(eurA.received).toBe(transferredA._sum.transferAmount);
  });

  it('volumen del pool: acceso global sancionado, por aula, día y divisa', async () => {
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
    const rows = await runtime.reports.volume(today, new Date(today.getTime() + 86_400_000));
    const ours = rows.filter((r) => r.tenantId === A || r.tenantId === B);
    expect(new Set(ours.map((r) => r.tenantId))).toEqual(new Set([A, B]));
    const eurA = ours.find((r) => r.tenantId === A && r.currency === 'eur')!;
    const agg = await admin.modPayoutsSale.aggregate({
      where: { tenantId: A, currency: 'eur', gross: { not: null }, chargedAt: { gte: today } },
      _sum: { gross: true, platformFee: true },
      _count: { _all: true },
    });
    expect(eurA).toMatchObject({
      gmv: agg._sum.gross,
      platformFees: agg._sum.platformFee,
      salesCount: agg._count._all,
    });
  });

  it('al final, el libro de las dos aulas cuadra: sin violaciones de invariantes', async () => {
    expect(await violationsOfOurTenants()).toEqual([]);
  });
});
