/**
 * Reembolsos, disputas y deudas (cobros de plataforma, E6) contra un Postgres
 * REAL, conectando como el runtime de producción: rol `didacta_app`
 * (NOSUPERUSER, NOBYPASSRLS) y RLS forzada.
 *
 * Lo que solo se ve con la base de verdad: el doble clic con los cerrojos
 * consultivos de Postgres, la RLS de una venta de otra academia (404), el
 * recobro de deudas con la reversión DENTRO de su transacción, y que cada
 * grupo de asientos cuadra con las dos invariantes del conciliador.
 *
 * De verdad: el webhook de plataforma, el `PayoutsRuntime` (reembolsos,
 * disputas, deudas, desconexión), la liquidación, el conciliador, los
 * servicios de billing (retirada del acceso al reembolsar) y la extensión RLS
 * de Prisma. Simulado: Stripe (el doble en memoria de `mod.payouts`), con el
 * comportamiento visto en el sandbox (reversión sin saldo → «does not have
 * sufficient funds…»).
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
  PayoutsSaleNotFoundError,
  PlatformStripeApiError,
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

const OPERATOR_SECRET = 'whsec_operador_e6_integracion';
const CONFIG = loadPlatformPaymentsConfig({
  PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: 'sk_test_inventadaE6',
  PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: OPERATOR_SECRET,
}) as PlatformPaymentsEnabled;
/** El mismo despliegue con la tasa de una disputa ganada a cargo del operador. */
const CONFIG_PLATFORM_WON_FEE = loadPlatformPaymentsConfig({
  PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: 'sk_test_inventadaE6',
  PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: OPERATOR_SECRET,
  PAYMENTS_PLATFORM_DISPUTE_WON_FEE_BEARER: 'platform',
}) as PlatformPaymentsEnabled;

describeWithDb('Reembolsos, disputas y deudas — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let runtime: PayoutsRuntime;
  let platform: PlatformWebhookController;
  /** Webhook de un despliegue con `PAYMENTS_PLATFORM_DISPUTE_WON_FEE_BEARER=platform`. */
  let platformWonFee: PlatformWebhookController;
  let reconciler: PayoutsReconcilerService;

  const A = randomUUID();
  const B = randomUUID();
  const stamp = Date.now();
  const ACCT: Record<string, string> = { [A]: `acct_1E6A${stamp}`, [B]: `acct_1E6B${stamp}` };
  const ACCOUNT_ID: Record<string, string> = { [A]: randomUUID(), [B]: randomUUID() };

  const fake = new InMemoryPlatformStripeClient({ livemode: false });
  const transfers: StripeObject[] = [];
  const refundsInStripe: StripeObject[] = [];
  const reversals: StripeObject[] = [];
  /** Saldo de cada cuenta conectada por divisa. Sin entrada: de sobra. */
  const balances = new Map<string, Record<string, number>>();
  const logger = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };

  const stripeError = (message: string, code?: string) =>
    new PlatformStripeApiError(message, {
      status: 400,
      type: 'invalid_request_error',
      stripeCode: code,
      operation: 'POST (doble)',
    });

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
          data: { id, slug: `e6-${slug}-${stamp}`, name: `Aula E6 ${slug}` },
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
        const left = (charge['amount'] as number) - (charge['amount_refunded'] as number);
        const amount = (req.params['amount'] as number | undefined) ?? left;
        if (amount > left) throw stripeError('Refund amount is greater than unrefunded amount');
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
        const account = transfer['destination'] as string;
        const currency = transfer['currency'] as string;
        const balance = balances.get(account);
        if (balance && (balance[currency] ?? 0) < amount) {
          throw stripeError(
            `The account ${account} does not have sufficient funds to reverse this transfer.`,
            'balance_insufficient',
          );
        }
        if (balance) balance[currency] = (balance[currency] ?? 0) - amount;
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
      fake.on('GET', '/v1/balance', (req) => {
        const balance = balances.get(req.options.account ?? '');
        return {
          object: 'balance',
          available: balance
            ? Object.entries(balance).map(([currency, amount]) => ({ currency, amount }))
            : [{ currency: 'eur', amount: 100_000_000 }],
          pending: [],
        };
      });
      for (const path of ['/v1/events', '/v1/charges', '/v1/disputes']) {
        fake.on('GET', path, () => ({ object: 'list', has_more: false, data: [] }));
      }

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
      platformWonFee = new PlatformWebhookController(
        new PayoutsRuntime(CONFIG_PLATFORM_WON_FEE, fake, prisma, stripeResolver, logger as never),
        logger as never,
        dispatcher,
      );
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
      where: { tenantId: { in: [A, B] } },
      data: { closedAt: new Date(), status: 'DISCONNECTED' },
    });
    await admin?.modPayoutsDebt.updateMany({
      where: { tenantId: { in: [A, B] }, status: 'OPEN' },
      data: { status: 'WRITTEN_OFF' },
    });
    await closeModule?.();
    await admin?.$disconnect();
  });

  // ── utilidades ──

  let seq = 0;
  const evtId = (label: string) => `evt_e6_${label}_${stamp}_${++seq}`;

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

  /** Compra cobrada por la plataforma, asentada y TRANSFERIDA, por el webhook. */
  async function soldAndTransferred(
    tenantId: string,
    opts: { fee?: number; currency?: string; amount?: number } = {},
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
    const btId = `txn_${tag}`;
    fake.seed(
      {
        id: btId,
        object: 'balance_transaction',
        type: 'charge',
        amount,
        fee: opts.fee ?? 175,
        net: amount - (opts.fee ?? 175),
        currency,
        available_on: 1_763_510_400,
      },
      {
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
        balance_transaction: btId,
      },
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
        line_items: { object: 'list', data: [{ description: 'Curso de 100' }] },
      },
    );
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
        evtId('completed'),
      ),
    );
    expect(completed).toMatchObject({ outcome: 'processed', settlement: 'transferred' });
    const sale = await admin.modPayoutsSale.findUniqueOrThrow({
      where: { stripeChargeId: ids.chId },
    });
    return { ...ids, saleId: sale.id };
  }

  const saleRow = (saleId: string) =>
    admin.modPayoutsSale.findUniqueOrThrow({ where: { id: saleId } });

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
    return violations.filter((v) => v.tenantId === A || v.tenantId === B);
  }

  const refundPosts = (chargeId: string) =>
    fake.callsTo('POST', '/v1/refunds').filter((c) => c.params['charge'] === chargeId);

  // ══════════════════ reembolsos ══════════════════

  it('total desde el botón: 10000 / 9325 revertidos / 500 devueltos / deuda 175; charge.refunded retira el acceso y no duplica', async () => {
    const s = await soldAndTransferred(A);
    const result = await runtime.refunds.refund({
      tenantId: A,
      saleId: s.saleId,
      initiatedBy: 'admin-a',
    });
    expect(result).toMatchObject({ status: 'succeeded', accounting: 'accounted', amount: 10000 });
    expect(await lossEntries(s.saleId)).toEqual({
      REFUND: -10000,
      PLATFORM_FEE_REFUND: 500,
      TRANSFER_REVERSAL: 9325,
      DEBT_CREATED: 175,
    });
    expect(await saleRow(s.saleId)).toMatchObject({ refundedAmount: 10000, reversedAmount: 9325 });
    const debts = await admin.modPayoutsDebt.findMany({ where: { originSaleId: s.saleId } });
    expect(debts.map((d) => [d.reason, d.amountOutstanding, d.status])).toEqual([
      ['REFUND_FEE', 175, 'OPEN'],
    ]);

    // Stripe avisa del reembolso: billing retira el acceso; el dinero ya estaba anotado.
    const charge = fake.get(s.chId)!;
    const event = await platform.handle(
      signed(
        'charge.refunded',
        {
          id: s.chId,
          object: 'charge',
          payment_intent: s.piId,
          amount: charge['amount'],
          amount_refunded: charge['amount_refunded'],
        },
        evtId('refunded'),
      ),
    );
    expect(event).toMatchObject({ outcome: 'processed', refund: 'synced' });
    expect(
      (await admin.modBillingOrder.findUniqueOrThrow({ where: { id: s.orderId } })).status,
    ).toBe('REFUNDED');
    expect(await lossEntries(s.saleId)).toMatchObject({ REFUND: -10000, TRANSFER_REVERSAL: 9325 });
    expect(await violationsOfOurTenants()).toEqual([]);

    // La deuda de 175 la compensa la siguiente venta.
    const next = await soldAndTransferred(A);
    expect(await saleRow(next.saleId)).toMatchObject({ debtNetted: 175, transferAmount: 9150 });
    expect(await violationsOfOurTenants()).toEqual([]);
  });

  it('dos parciales (4000 + 6000) suman exactamente la venta y un tercero no pasa', async () => {
    const s = await soldAndTransferred(A);
    await runtime.refunds.refund({ tenantId: A, saleId: s.saleId, amount: 4000, initiatedBy: 'u' });
    await expect(
      runtime.refunds.refund({ tenantId: A, saleId: s.saleId, amount: 6001, initiatedBy: 'u' }),
    ).rejects.toMatchObject({ code: 'PAYOUTS_REFUND_EXCEEDS_REMAINING' });
    await runtime.refunds.refund({ tenantId: A, saleId: s.saleId, amount: 6000, initiatedBy: 'u' });
    await expect(
      runtime.refunds.refund({ tenantId: A, saleId: s.saleId, amount: 1, initiatedBy: 'u' }),
    ).rejects.toMatchObject({ code: 'PAYOUTS_SALE_NOT_REFUNDABLE' });
    expect(refundPosts(s.chId).map((c) => c.params['amount'])).toEqual([4000, 6000]);
    expect(await lossEntries(s.saleId)).toEqual({
      REFUND: -10000,
      PLATFORM_FEE_REFUND: 500,
      TRANSFER_REVERSAL: 9325,
      DEBT_CREATED: 175,
    });
    expect(await violationsOfOurTenants()).toEqual([]);
  });

  it('doble clic de verdad: 5 peticiones a la vez con el mismo requestId → UN reembolso', async () => {
    const s = await soldAndTransferred(A);
    const requestId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        runtime.refunds.refund({
          tenantId: A,
          saleId: s.saleId,
          amount: 4000,
          requestId,
          initiatedBy: 'u',
        }),
      ),
    );
    expect(new Set(results.map((r) => r.refundId))).toEqual(new Set([requestId]));
    expect(refundPosts(s.chId)).toHaveLength(1);
    expect(await admin.modPayoutsRefund.count({ where: { saleId: s.saleId } })).toBe(1);
    expect(await lossEntries(s.saleId)).toMatchObject({ REFUND: -4000, TRANSFER_REVERSAL: 3730 });
    expect(await violationsOfOurTenants()).toEqual([]);
  });

  it('dos «reembolsar todo» a la vez sin requestId → uno solo', async () => {
    const s = await soldAndTransferred(A);
    const results = await Promise.allSettled([
      runtime.refunds.refund({ tenantId: A, saleId: s.saleId, initiatedBy: 'u' }),
      runtime.refunds.refund({ tenantId: A, saleId: s.saleId, initiatedBy: 'u' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(refundPosts(s.chId)).toHaveLength(1);
    expect(await violationsOfOurTenants()).toEqual([]);
  });

  it('venta de otra academia → 404: la RLS no deja ni verla, y Stripe no recibe nada', async () => {
    const s = await soldAndTransferred(A);
    const before = fake.calls.length;
    await expect(
      runtime.refunds.refund({ tenantId: B, saleId: s.saleId, initiatedBy: 'admin-b' }),
    ).rejects.toBeInstanceOf(PayoutsSaleNotFoundError);
    expect(fake.calls.length).toBe(before);
    expect(await admin.modPayoutsRefund.count({ where: { saleId: s.saleId } })).toBe(0);
  });

  it('reembolso hecho a mano en el panel de Stripe: charge.refunded lo detecta y lo anota', async () => {
    const s = await soldAndTransferred(A);
    await fake.v1('POST', '/v1/refunds', { charge: s.chId, amount: 2500 });
    const charge = fake.get(s.chId)!;
    const event = await platform.handle(
      signed(
        'charge.refunded',
        {
          id: s.chId,
          object: 'charge',
          payment_intent: s.piId,
          amount: 10000,
          amount_refunded: charge['amount_refunded'],
        },
        evtId('manual'),
      ),
    );
    expect(event).toMatchObject({ refund: 'synced' });
    const rows = await admin.modPayoutsRefund.findMany({ where: { saleId: s.saleId } });
    expect(rows.map((r) => [r.initiatedBy, r.amount, r.reversalStatus])).toEqual([
      ['stripe_dashboard', 2500, 'DONE'],
    ]);
    expect(await lossEntries(s.saleId)).toMatchObject({ REFUND: -2500, TRANSFER_REVERSAL: 2331 });
    // Parcial: billing no retira el acceso.
    expect(
      (await admin.modBillingOrder.findUniqueOrThrow({ where: { id: s.orderId } })).status,
    ).toBe('COMPLETED');
    expect(await violationsOfOurTenants()).toEqual([]);
  });

  it('saldo del creador a cero: deuda 9160 y el recobro diario la cobra revirtiendo (dentro de su transacción)', async () => {
    const s = await soldAndTransferred(B, { fee: 340 });
    balances.set(ACCT[B]!, { eur: 0 });
    await runtime.refunds.refund({ tenantId: B, saleId: s.saleId, initiatedBy: 'u' });
    const debts = await admin.modPayoutsDebt.findMany({
      where: { originSaleId: s.saleId },
      orderBy: { reason: 'asc' },
    });
    expect(debts.map((d) => [d.reason, d.amountOutstanding])).toEqual([
      ['REFUND_FEE', 340],
      ['REVERSAL_FAILED', 9160],
    ]);
    expect(await violationsOfOurTenants()).toEqual([]);

    try {
      balances.set(ACCT[B]!, { eur: 50_000 });
      // El informe suma todas las aulas: lo que importa es lo de B.
      await runtime.debts.recoverOpenDebts();
      expect((await saleRow(s.saleId)).reversedAmount).toBe(9160);
      expect(balances.get(ACCT[B]!)!['eur']).toBe(50_000 - 9160);
      const open = await admin.modPayoutsDebt.aggregate({
        where: { tenantId: B, status: 'OPEN' },
        _sum: { amountOutstanding: true },
      });
      // La comisión (340) espera a la próxima venta: no queda más transferido que revertir.
      expect(open._sum.amountOutstanding).toBe(340);
      // Otra pasada no revierte dos veces.
      await runtime.debts.recoverOpenDebts();
      expect(balances.get(ACCT[B]!)!['eur']).toBe(50_000 - 9160);
      expect(await violationsOfOurTenants()).toEqual([]);
    } finally {
      balances.delete(ACCT[B]!);
    }
  });

  it('venta en CHF: todo en CHF y su deuda no la compensa una venta en euros', async () => {
    const chf = await soldAndTransferred(B, { currency: 'chf', fee: 320 });
    await runtime.refunds.refund({ tenantId: B, saleId: chf.saleId, initiatedBy: 'u' });
    const entries = await admin.modPayoutsLedgerEntry.findMany({ where: { saleId: chf.saleId } });
    expect(new Set(entries.map((e) => e.currency))).toEqual(new Set(['chf']));
    const eur = await soldAndTransferred(B);
    const eurSale = await saleRow(eur.saleId);
    // Solo pudo compensar deuda en EUR (la de 340 del caso anterior), nunca la de CHF.
    expect(eurSale.currency).toBe('eur');
    const chfDebt = await admin.modPayoutsDebt.findFirstOrThrow({
      where: { originSaleId: chf.saleId, reason: 'REFUND_FEE' },
    });
    expect([chfDebt.currency, chfDebt.amountOutstanding, chfDebt.status]).toEqual([
      'chf',
      320,
      'OPEN',
    ]);
    expect(await violationsOfOurTenants()).toEqual([]);
  });

  // ══════════════════ disputas ══════════════════

  function seedDispute(
    id: string,
    chargeId: string,
    status: string,
    bts: Array<{ amount: number; fee: number }>,
  ) {
    fake.seed({
      id,
      object: 'dispute',
      amount: 10000,
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
    });
  }

  it('disputa con tarjeta US por el webhook: retirada 10000 + 2000, reversión 9160; perdida → deuda 2340', async () => {
    const s = await soldAndTransferred(A, { fee: 340 });
    const dp = `dp_us_${stamp}`;
    seedDispute(dp, s.chId, 'needs_response', []);
    const obj = { id: dp, object: 'dispute', charge: s.chId, payment_intent: s.piId };
    expect(await platform.handle(signed('charge.dispute.created', obj, evtId('dc')))).toMatchObject(
      {
        dispute: 'synced',
      },
    );
    expect(await lossEntries(s.saleId)).toEqual({});

    seedDispute(dp, s.chId, 'needs_response', [{ amount: -10000, fee: 2000 }]);
    await platform.handle(signed('charge.dispute.funds_withdrawn', obj, evtId('dw')));
    expect(await lossEntries(s.saleId)).toEqual({
      DISPUTE_WITHDRAWN: -10000,
      DISPUTE_FEE: -2000,
      PLATFORM_FEE_REFUND: 500,
      TRANSFER_REVERSAL: 9160,
      ADJUSTMENT: 2340,
    });
    expect(await violationsOfOurTenants()).toEqual([]);

    seedDispute(dp, s.chId, 'lost', [{ amount: -10000, fee: 2000 }]);
    await platform.handle(signed('charge.dispute.closed', obj, evtId('dl')));
    const debt = await admin.modPayoutsDebt.findFirstOrThrow({
      where: { originSaleId: s.saleId, reason: 'DISPUTE_FEE' },
    });
    expect([debt.amountOriginal, debt.status]).toEqual([2340, 'OPEN']);
    expect(
      await admin.modPayoutsDispute.findFirstOrThrow({ where: { stripeDisputeId: dp } }),
    ).toMatchObject({
      outcome: 'lost',
      amount: 10000,
      fee: 2000,
    });
    expect(await violationsOfOurTenants()).toEqual([]);
  });

  const absorbedAlertsFor = (disputeId: string) =>
    logger.error.mock.calls.filter(
      (c) =>
        (c[0] as Row)['alert'] === 'payouts.platform_absorbed' &&
        (c[0] as Row)['disputeId'] === disputeId,
    );

  it('disputa ganada por el webhook (por defecto): transferencia nueva por lo revertido, deuda DISPUTE cancelada y la tasa no devuelta, deuda DISPUTE_FEE del creador', async () => {
    const s = await soldAndTransferred(A, { fee: 340 });
    const dp = `dp_won_${stamp}`;
    const obj = { id: dp, object: 'dispute', charge: s.chId, payment_intent: s.piId };
    seedDispute(dp, s.chId, 'under_review', [{ amount: -10000, fee: 2000 }]);
    try {
      balances.set(ACCT[A]!, { eur: 5000 });
      await platform.handle(signed('charge.dispute.funds_withdrawn', obj, evtId('ww')));
    } finally {
      balances.delete(ACCT[A]!);
    }
    const frozen = await admin.modPayoutsDebt.findFirstOrThrow({
      where: { originSaleId: s.saleId, reason: 'DISPUTE' },
    });
    expect(frozen.amountOutstanding).toBe(4160);
    expect(await violationsOfOurTenants()).toEqual([]);

    // Ganada: Stripe devuelve el importe pero NO su tasa de 2000.
    seedDispute(dp, s.chId, 'won', [
      { amount: -10000, fee: 2000 },
      { amount: 10000, fee: 0 },
    ]);
    const reinstated = signed('charge.dispute.funds_reinstated', obj, evtId('wr'));
    await platform.handle(reinstated);
    await platform.handle(signed('charge.dispute.closed', obj, evtId('wc')));
    const reinstate = transfers.filter((t) => t['transfer_group'] === `didacta_dispute_${dp}`);
    expect(reinstate.map((t) => t['amount'])).toEqual([5000]);
    expect(
      await admin.modPayoutsDebt.findUniqueOrThrow({ where: { id: frozen.id } }),
    ).toMatchObject({ amountOutstanding: 0, status: 'WRITTEN_OFF' });
    const feeDebts = await admin.modPayoutsDebt.findMany({
      where: { originSaleId: s.saleId, reason: 'DISPUTE_FEE' },
    });
    expect(feeDebts.map((d) => [d.amountOriginal, d.amountOutstanding, d.status])).toEqual([
      [2000, 2000, 'OPEN'],
    ]);
    expect(absorbedAlertsFor(dp)).toEqual([]);
    expect(await violationsOfOurTenants()).toEqual([]);

    // Reentrega del mismo evento: una sola deuda.
    await platform.handle(reinstated);
    expect(
      await admin.modPayoutsDebt.count({
        where: { originSaleId: s.saleId, reason: 'DISPUTE_FEE' },
      }),
    ).toBe(1);
    // El evento `transfer.created` de esa transferencia cuadra con su asiento.
    const check = await platform.handle(
      signed(
        'transfer.created',
        { id: reinstate[0]!['id'], object: 'transfer', destination: ACCT[A] },
        evtId('tc'),
      ),
    );
    expect(check).toMatchObject({ outcome: 'processed' });
    expect(
      logger.error.mock.calls.filter((c) => (c[0] as Row)['alert'] === 'payouts.transfer_mismatch'),
    ).toEqual([]);
    expect(await violationsOfOurTenants()).toEqual([]);
  });

  it('disputa ganada con PAYMENTS_PLATFORM_DISPUTE_WON_FEE_BEARER=platform: la tasa la asume el operador, con asiento y alerta, como antes', async () => {
    const s = await soldAndTransferred(A, { fee: 340 });
    const dp = `dp_won_platform_${stamp}`;
    const obj = { id: dp, object: 'dispute', charge: s.chId, payment_intent: s.piId };
    seedDispute(dp, s.chId, 'under_review', [{ amount: -10000, fee: 2000 }]);
    await platformWonFee.handle(signed('charge.dispute.funds_withdrawn', obj, evtId('pw')));
    seedDispute(dp, s.chId, 'won', [
      { amount: -10000, fee: 2000 },
      { amount: 10000, fee: 0 },
    ]);
    await platformWonFee.handle(signed('charge.dispute.closed', obj, evtId('pc')));
    // Se le devuelve exactamente lo que se le revirtió (la venta pudo pagar
    // antes deudas abiertas de otros casos de este fichero).
    const entries = await lossEntries(s.saleId);
    expect(entries['TRANSFER_REVERSAL']).toBeGreaterThan(0);
    expect(
      transfers
        .filter((t) => t['transfer_group'] === `didacta_dispute_${dp}`)
        .map((t) => t['amount']),
    ).toEqual([entries['TRANSFER_REVERSAL']]);
    // Ninguna deuda de la tasa, y ninguna deuda abierta de esta venta.
    expect(
      await admin.modPayoutsDebt.count({
        where: { originSaleId: s.saleId, reason: 'DISPUTE_FEE' },
      }),
    ).toBe(0);
    expect(
      await admin.modPayoutsDebt.count({ where: { originSaleId: s.saleId, status: 'OPEN' } }),
    ).toBe(0);
    const wonCost = await admin.modPayoutsLedgerEntry.findMany({
      where: { saleId: s.saleId, type: 'ADJUSTMENT', idempotencyKey: { endsWith: ':won-cost' } },
    });
    expect(wonCost.map((e) => e.amount)).toEqual([2000]);
    expect(absorbedAlertsFor(dp)).toHaveLength(1);
    expect(await violationsOfOurTenants()).toEqual([]);
  });

  it('disputa que llega ANTES que la compra (como en el sandbox): el evento queda pendiente y la venta la pone al día', async () => {
    // La compra existe en Stripe (sesión registrada) pero su completed aún no llegó.
    const orderId = randomUUID();
    const tag = orderId.replace(/-/g, '');
    const ids = { sessionId: `cs_test_${tag}`, piId: `pi_${tag}`, chId: `ch_${tag}` };
    await admin.modBillingOrder.create({
      data: {
        id: orderId,
        tenantId: A,
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
        tenantId: A,
        kind: 'checkout_session',
        source: 'billing',
        localRef: orderId,
      },
    });
    fake.seed(
      {
        id: `txn_${tag}`,
        object: 'balance_transaction',
        type: 'charge',
        amount: 10000,
        fee: 340,
        net: 9660,
        currency: 'eur',
      },
      {
        id: ids.chId,
        object: 'charge',
        amount: 10000,
        currency: 'eur',
        status: 'succeeded',
        paid: true,
        amount_refunded: 0,
        disputed: true,
        created: Math.floor(Date.now() / 1000),
        on_behalf_of: ACCT[A],
        payment_intent: ids.piId,
        transfer_group: `didacta_${orderId}`,
        balance_transaction: `txn_${tag}`,
      },
      { id: ids.piId, object: 'payment_intent', latest_charge: ids.chId, on_behalf_of: ACCT[A] },
      {
        id: ids.sessionId,
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'paid',
        livemode: false,
        customer_details: { email: `t-${tag}@example.test` },
        payment_intent: ids.piId,
        line_items: { object: 'list', data: [{ description: 'Curso temprano' }] },
      },
    );
    fake.on('GET', '/v1/checkout/sessions', (req) => ({
      object: 'list',
      has_more: false,
      data: req.params['payment_intent'] === ids.piId ? [{ id: ids.sessionId }] : [],
    }));
    const dp = `dp_early_${stamp}`;
    seedDispute(dp, ids.chId, 'needs_response', [{ amount: -10000, fee: 2000 }]);
    fake.on('GET', '/v1/disputes', (req) => ({
      object: 'list',
      has_more: false,
      data: req.params['charge'] === ids.chId ? [fake.get(dp)!] : [],
    }));
    const early = evtId('early');
    const first = await platform.handle(
      signed(
        'charge.dispute.created',
        { id: dp, object: 'dispute', charge: ids.chId, payment_intent: ids.piId },
        early,
      ),
    );
    expect(first).toMatchObject({ outcome: 'processed', dispute: 'no_sale' });
    const archived = await admin.modPayoutsWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId: early },
    });
    expect(archived.processedAt).toBeNull();

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
          metadata: { orderId, tenantId: A },
        },
        evtId('latecompleted'),
      ),
    );
    expect(completed).toMatchObject({ sale: 'created', settlement: 'held' });
    const sale = await admin.modPayoutsSale.findUniqueOrThrow({
      where: { stripeChargeId: ids.chId },
    });
    expect(sale).toMatchObject({
      status: 'SETTLED_NETTED',
      debtNetted: 9160,
      stripeTransferId: null,
    });
    expect(await lossEntries(sale.id)).toMatchObject({
      DISPUTE_WITHDRAWN: -10000,
      DISPUTE_FEE: -2000,
    });
    // El evento pendiente, al reproducirse, ya no tiene nada que hacer.
    expect(
      await platform.process(
        JSON.parse(
          JSON.stringify({
            id: early,
            object: 'event',
            type: 'charge.dispute.created',
            livemode: false,
            created: 1,
            data: {
              object: { id: dp, object: 'dispute', charge: ids.chId, payment_intent: ids.piId },
            },
          }),
        ),
      ),
    ).toMatchObject({ dispute: 'synced' });
    expect(await violationsOfOurTenants()).toEqual([]);
  });

  // ══════════════════ desconexión ══════════════════

  it('desconectar: DISCONNECTED cierra el checkout; lo pendiente se sigue liquidando', async () => {
    const result = await runtime.offboarding.disconnect(B, { reason: 'creator' });
    expect(result).toMatchObject({ changed: true, account: { status: 'DISCONNECTED' } });
    const mode = await runAsTenant(B, () => runtime.mode.resolve(B));
    expect(mode).toEqual({ mode: 'platform', ready: false, reason: 'disconnected' });
    expect(await runAsTenant(A, () => runtime.mode.resolve(A))).toMatchObject({
      mode: 'platform',
      ready: true,
    });
  });
});
