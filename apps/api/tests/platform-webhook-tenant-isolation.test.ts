import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import Stripe from 'stripe';
import { BillingService } from '@didacta/mod-billing';
import { MembershipService, SubscriptionsService } from '@didacta/mod-subscriptions';
import {
  InMemoryPlatformStripeClient,
  PayoutsError,
  RefsService,
  signStripePayload,
} from '@didacta/mod-payouts';
import { BillingErrorFilter } from '../src/modules/billing/billing-error.filter';
import { BillingProvisioningService } from '../src/modules/billing/billing-provisioning.service';
import { BillingWebhookController } from '../src/modules/billing/billing-webhook.controller';
import { ModuleRegistryService } from '../src/modules/module-registry.service';
import { PAYOUTS_STATUS_BY_CODE } from '../src/modules/payouts/payouts-error.filter';
import { ModulesPlatformEventDispatcher } from '../src/modules/payouts/platform-event-dispatcher';
import { PlatformObjectGuard } from '../src/modules/payouts/platform-object-guard';
import {
  PAYOUTS_REF_MISMATCH_ALERT,
  PlatformWebhookController,
} from '../src/modules/payouts/platform-webhook.controller';
import { SubscriptionsErrorFilter } from '../src/modules/subscriptions/subscriptions-error.filter';
import { MembershipProvisioningService } from '../src/modules/subscriptions/membership-provisioning.service';
import { SubscriptionsWebhookController } from '../src/modules/subscriptions/subscriptions-webhook.controller';
import { TenantStripeResolverService } from '../src/modules/tenant-stripe-resolver.service';
import { TenantResolverService } from '../src/tenancy/tenant-resolver.service';

/**
 * Aislamiento entre aulas del webhook ÚNICO de plataforma (cobros de
 * plataforma, etapa E3) y de su convivencia con los webhooks heredados.
 *
 * En modo plataforma todas las aulas cobran en la cuenta de Stripe del
 * operador. El tenant de un evento sale SOLO del registro de objetos
 * (`mod_payouts_object_ref`), que escribe nuestro servidor al crear la sesión;
 * los webhooks heredados (claves propias de cada aula) rechazan cualquier
 * evento que nombre un objeto de plataforma.
 *
 * Mismo planteamiento que `stripe-webhook-tenant-isolation.test.ts`: los
 * servicios de billing, suscripciones y membresía son los de verdad, las firmas
 * son las de verdad (la de Stripe con su SDK para los heredados y la del
 * operador para el de plataforma), el registro de objetos y el manejador de la
 * venta son los de verdad, y la base es una en memoria SIN RLS a propósito.
 * La contraparte contra Postgres real como `didacta_app` está en
 * `integration/platform-webhook-tenant-isolation.integration.test.ts`.
 */

// ───────────────────────────── aulas ─────────────────────────────

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // la víctima, cobra por la plataforma
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // la atacante: plataforma Y claves propias

const HOST: Record<string, string> = { 'aula-a.test': A, 'aula-b.test': B };

/** Claves propias que B conserva (convivencia): con ellas firma en los heredados. */
const CREDS = {
  [B]: { secretKey: 'sk_test_cuenta_de_B', webhookSecret: 'whsec_de_B' },
} as Record<string, { secretKey: string; webhookSecret: string }>;

/** Secretos del OPERADOR (endpoints del webhook de plataforma). */
const OPERATOR_SECRETS = ['whsec_operador_uno', 'whsec_operador_dos'];

const ACCT = { [A]: 'acct_1CreadoraA', [B]: 'acct_1CreadoraB' } as Record<string, string>;

// ───────────────────── base en memoria (sin RLS) ─────────────────────

type Row = Record<string, unknown>;

function uniqueViolation(table: string): Error {
  return new Error(`Unique constraint failed on the constraint: \`${table}_pkey\``);
}

/** El subconjunto de `where` de Prisma que usan los servicios de este test. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Row[]).some((inner) => matches(row, inner));
    const v = row[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { not?: unknown; in?: unknown[]; gt?: number };
      if ('not' in c) return v !== c.not;
      if ('in' in c) return (c.in ?? []).includes(v);
      if ('gt' in c) return typeof v === 'number' && v > (c.gt ?? 0);
      return true;
    }
    return v === cond;
  });
}

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as Row)) {
      row[k] = ((row[k] as number) ?? 0) + ((v as { increment: number }).increment ?? 0);
    } else {
      row[k] = v;
    }
  }
}

class FakeDb {
  orders: Row[] = [];
  billingEvents: Row[] = [];
  subs: Row[] = [];
  invoices: Row[] = [];
  subsEvents: Row[] = [];
  plans: Row[] = [];
  payoutsEvents: Row[] = [];
  refs: Row[] = [];
  accounts: Row[] = [];
  sales: Row[] = [];
  private seq = 0;

  /** Lo que un evento podría crear o modificar en los MÓDULOS y en el dinero. */
  snapshot() {
    return structuredClone({
      orders: this.orders,
      billingEvents: this.billingEvents,
      subs: this.subs,
      invoices: this.invoices,
      subsEvents: this.subsEvents,
      refs: this.refs,
      sales: this.sales,
    });
  }

  private table(rows: () => Row[], opts: { pk?: string; name?: string; unique?: string } = {}) {
    const pk = opts.pk ?? 'id';
    /** Otra clave única además de la primaria (p. ej. `stripe_charge_id` de la venta). */
    const clash = (row: Row) =>
      rows().some(
        (r) =>
          r[pk] === row[pk] || (opts.unique !== undefined && r[opts.unique] === row[opts.unique]),
      );
    return {
      findUnique: async (args: { where: Row }) =>
        rows().find((r) => matches(r, args.where)) ?? null,
      findFirst: async (args: { where: Row }) => rows().find((r) => matches(r, args.where)) ?? null,
      findMany: async (args: { where?: Row } = {}) =>
        rows()
          .filter((r) => matches(r, args.where))
          .sort((a, b) => String(a[pk]).localeCompare(String(b[pk]))),
      create: async (args: { data: Row }) => {
        const row: Row = { ...args.data };
        if (row[pk] === undefined) row[pk] = `${opts.name ?? 'row'}-${++this.seq}`;
        if (rows().some((r) => r[pk] === row[pk])) throw uniqueViolation(opts.name ?? 'tabla');
        rows().push(row);
        return row;
      },
      createMany: async (args: { data: Row[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const data of args.data) {
          const row: Row = { attempts: 0, processedAt: null, errorMessage: null, ...data };
          if (row[pk] === undefined) row[pk] = `${opts.name ?? 'row'}-${++this.seq}`;
          if (clash(row)) {
            if (args.skipDuplicates) continue;
            throw uniqueViolation(opts.name ?? 'tabla');
          }
          rows().push(row);
          count += 1;
        }
        return { count };
      },
      update: async (args: { where: Row; data: Row }) => {
        const row = rows().find((r) => matches(r, args.where));
        if (!row) throw new Error('Record to update not found.');
        applyData(row, args.data);
        return row;
      },
    };
  }

  modBillingOrder = this.table(() => this.orders, { name: 'mod_billing_order' });
  modBillingWebhookEvent = this.table(() => this.billingEvents, {
    pk: 'stripeEventId',
    name: 'mod_billing_webhook_event',
  });
  modSubscriptionsSubscription = this.table(() => this.subs, {
    name: 'mod_subscriptions_subscription',
  });
  modSubscriptionsInvoice = this.table(() => this.invoices, { name: 'mod_subscriptions_invoice' });
  modSubscriptionsWebhookEvent = this.table(() => this.subsEvents, {
    pk: 'stripeEventId',
    name: 'mod_subscriptions_webhook_event',
  });
  modSubscriptionsPlan = this.table(() => this.plans, { name: 'mod_subscriptions_plan' });
  modPayoutsWebhookEvent = this.table(() => this.payoutsEvents, {
    pk: 'stripeEventId',
    name: 'mod_payouts_webhook_event',
  });
  modPayoutsObjectRef = this.table(() => this.refs, {
    pk: 'stripeObjectId',
    name: 'mod_payouts_object_ref',
  });
  modPayoutsAccount = this.table(() => this.accounts, { name: 'mod_payouts_account' });
  modPayoutsSale = this.table(() => this.sales, {
    name: 'mod_payouts_sale',
    unique: 'stripeChargeId',
  });
}

// ───────────────────────────── arnés ─────────────────────────────

function build() {
  const db = new FakeDb();
  const published: Array<{ tenantId: string; name: string; payload: Row }> = [];
  const publisher = {
    publish: async (tenantId: string, _actor: string | null, name: string, payload: Row) => {
      published.push({ tenantId, name, payload });
    },
  };
  const noStripe = async () => {
    throw new Error('los módulos no deben llamar a Stripe al procesar el webhook');
  };
  const urls = { successUrl: () => 'https://x/ok', cancelUrl: () => 'https://x/ko' };
  const billing = new BillingService(db as never, noStripe as never, publisher, urls);
  const subs = new SubscriptionsService(db as never, noStripe as never, publisher, urls);
  const membership = new MembershipService(db as never, noStripe as never, publisher);
  const registry = {
    getBillingService: () => billing,
    getSubscriptionsService: () => subs,
    getMembershipService: () => membership,
  };

  const tenantConfig = {
    async get(tenantId: string, scope: string, key: string) {
      if (scope === 'billing' && key === 'stripe') return CREDS[tenantId];
      return undefined;
    },
  };
  // Modo plataforma: sin fallback de instancia.
  const stripeResolver = new TenantStripeResolverService(tenantConfig as never, async () => false);
  const tenantResolver = {
    resolveByHost: async (host: string | undefined) => {
      const id = host ? HOST[host] : undefined;
      return id ? { id, slug: host, name: host, matchedBy: 'hostname', hostname: host } : null;
    },
    resolveTenantWebBaseUrl: async () => 'https://aula.test',
    resolveTenantWebBaseUrlForBackground: async () => 'https://aula.test',
  };

  const provisioned: Array<{ tenantId: string; email: string }> = [];
  const provisioning = {
    provision: async (args: { tenantId: string; email: string }) => {
      provisioned.push({ tenantId: args.tenantId, email: args.email });
      return { userId: `user-${args.tenantId.slice(0, 1)}-${args.email}`, created: true };
    },
  };
  const audited: Row[] = [];
  const auditLog = {
    record: async (entry: Row) => {
      audited.push(entry);
    },
  };
  const logger = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };

  // ── la plataforma ──
  const stripe = new InMemoryPlatformStripeClient({ livemode: false });
  const refs = new RefsService(db as never);
  const runtime = {
    config: { webhookSecrets: OPERATOR_SECRETS, livemode: false },
    prisma: db,
    refs,
    stripe,
    db: {
      inTenant: (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => fn(db),
      global: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    },
    tenantOfAccount: async () => null,
    accounts: { syncAccount: vi.fn() },
  };
  const guard = new PlatformObjectGuard(runtime as never);
  const services = new Map<unknown, unknown>([
    [ModuleRegistryService, registry],
    [TenantResolverService, tenantResolver],
    [BillingProvisioningService, provisioning],
    [MembershipProvisioningService, provisioning],
  ]);
  const dispatcher = new ModulesPlatformEventDispatcher({
    get: (token: unknown) => services.get(token),
  } as never);
  const platformController = new PlatformWebhookController(
    runtime as never,
    logger as never,
    dispatcher,
  );

  const billingController = new BillingWebhookController(
    registry as never,
    provisioning as never,
    tenantResolver as never,
    stripeResolver,
    auditLog as never,
    logger as never,
    guard,
  );
  const subsController = new SubscriptionsWebhookController(
    registry as never,
    provisioning as never,
    provisioning as never,
    logger as never,
    tenantResolver as never,
    stripeResolver,
    auditLog as never,
    guard,
  );

  return {
    db,
    stripe,
    published,
    provisioned,
    audited,
    logger,
    platformController,
    billingController,
    subsController,
  };
}

type Harness = ReturnType<typeof build>;

let eventSeq = 0;

function eventPayload(type: string, object: Row, opts: { id?: string; livemode?: boolean } = {}) {
  return JSON.stringify({
    id: opts.id ?? `evt_test_${++eventSeq}`,
    object: 'event',
    type,
    livemode: opts.livemode ?? false,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
}

/** Petición a un webhook HEREDADO (por aula): firma con el SDK de Stripe. */
function legacyRequest(args: { host: string; secret: string; type: string; object: Row }) {
  const payload = eventPayload(args.type, args.object);
  return {
    headers: {
      host: args.host,
      'stripe-signature': Stripe.webhooks.generateTestHeaderString({
        payload,
        secret: args.secret,
      }),
      'user-agent': 'Stripe/1.0',
    },
    ip: '203.0.113.7',
    rawBody: Buffer.from(payload, 'utf8'),
  } as never;
}

/** Petición al webhook de PLATAFORMA: sin Host que valga, firma con un secreto. */
function platformRequest(args: {
  secret: string;
  type: string;
  object: Row;
  id?: string;
  livemode?: boolean;
}) {
  const payload = eventPayload(args.type, args.object, { id: args.id, livemode: args.livemode });
  return {
    headers: {
      host: 'api.didacta.test',
      'stripe-signature': signStripePayload(payload, args.secret),
    },
    ip: '203.0.113.8',
    rawBody: Buffer.from(payload, 'utf8'),
  } as never;
}

/** Código HTTP que acabaría viendo quien llama, pasando por los filtros reales. */
async function statusOf(run: () => Promise<unknown>): Promise<number> {
  try {
    await run();
    return 200;
  } catch (err) {
    if (err instanceof HttpException) return err.getStatus();
    if (err instanceof PayoutsError) return PAYOUTS_STATUS_BY_CODE[err.code] ?? 400;
    let status = 0;
    const host = {
      getType: () => 'http',
      switchToHttp: () => ({
        getResponse: () => ({
          status: (s: number) => {
            status = s;
            return { send: () => undefined };
          },
        }),
      }),
    } as never;
    const code = (err as { code?: string }).code ?? '';
    if (code.startsWith('BILLING_')) new BillingErrorFilter().catch(err as never, host);
    else if (code.startsWith('SUBSCRIPTIONS_') || code.startsWith('MEMBERSHIP_'))
      new SubscriptionsErrorFilter().catch(err as never, host);
    else
      throw new Error(`error sin mapeo HTTP conocido: ${(err as Error).message}`, { cause: err });
    return status;
  }
}

// ─────────────────── datos de partida de cada aula ───────────────────

/**
 * Una compra de curso cobrada por la PLATAFORMA, tal y como la deja
 * `startCheckout` con el adaptador de plataforma: orden PENDING y su `cs_`
 * registrado a nombre del aula. Y lo que Stripe tiene de ella.
 */
function seedPlatformOrder(
  t: Harness,
  tenantId: string,
  orderId: string,
  opts: { paymentStatus?: string; chargeStatus?: string; amount?: number } = {},
) {
  const sessionId = `cs_test_${orderId.replace(/-/g, '')}`;
  t.db.orders.push({
    id: orderId,
    tenantId,
    userId: null,
    productId: `producto-${orderId}`,
    courseId: `curso-${orderId}`,
    stripeSessionId: sessionId,
    stripePaymentIntentId: null,
    status: 'PENDING',
    amountPaid: null,
    currency: 'eur',
    customerEmail: null,
    completedAt: null,
    refundedAt: null,
  });
  t.db.refs.push({
    stripeObjectId: sessionId,
    tenantId,
    kind: 'checkout_session',
    source: 'billing',
    localRef: orderId,
    parentObjectId: null,
    livemode: false,
    createdAt: new Date(),
  });
  const amount = opts.amount ?? 4900;
  const piId = `pi_${orderId.replace(/-/g, '')}`;
  const chId = `ch_${orderId.replace(/-/g, '')}`;
  const chargeStatus = opts.chargeStatus ?? 'succeeded';
  t.stripe.seed(
    {
      id: chId,
      object: 'charge',
      amount,
      currency: 'eur',
      status: chargeStatus,
      paid: chargeStatus === 'succeeded',
      created: 1_762_950_000,
      on_behalf_of: ACCT[tenantId],
      customer: null,
      balance_transaction: null,
    },
    { id: piId, object: 'payment_intent', latest_charge: chId, on_behalf_of: ACCT[tenantId] },
    {
      id: sessionId,
      object: 'checkout.session',
      mode: 'payment',
      payment_status: opts.paymentStatus ?? 'paid',
      livemode: false,
      customer: null,
      customer_details: { email: 'alumna@example.com' },
      payment_intent: piId,
      amount_total: amount,
      line_items: { object: 'list', data: [{ description: 'Curso de plataforma' }] },
    },
  );
  return { sessionId, piId, chId };
}

function seedAccount(t: Harness, tenantId: string) {
  t.db.accounts.push({
    id: `cuenta-${tenantId.slice(0, 1)}`,
    tenantId,
    stripeAccountId: ACCT[tenantId],
    status: 'READY',
  });
}

/** La sesión tal y como la manda Stripe en el evento (su metadata la escribe nuestro checkout). */
function sessionObject(tenantId: string, orderId: string, sessionId: string, extra: Row = {}): Row {
  return {
    id: sessionId,
    object: 'checkout.session',
    mode: 'payment',
    payment_status: 'paid',
    status: 'complete',
    payment_intent: `pi_${orderId.replace(/-/g, '')}`,
    amount_total: 4900,
    client_reference_id: orderId,
    customer_details: { email: 'alumna@example.com', name: 'Alumna' },
    metadata: { orderId, productId: `producto-${orderId}`, tenantId, courseId: `curso-${orderId}` },
    ...extra,
  };
}

const ORDER_A = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const ORDER_B = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';

const ENV_KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SUBSCRIPTIONS_WEBHOOK_SECRET'];
const SAVED_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

// ══════════════════════ los seis ataques del plan ══════════════════════

describe('webhook de plataforma · aislamiento entre aulas (los seis casos del plan)', () => {
  it('(1) B firma en un endpoint HEREDADO un checkout.session.completed de una orden de plataforma de A → 403, base idéntica', async () => {
    const t = build();
    seedAccount(t, A);
    const { sessionId } = seedPlatformOrder(t, A, ORDER_A);
    const antes = t.db.snapshot();

    for (const controller of [t.billingController, t.subsController]) {
      const status = await statusOf(() =>
        controller.handle(
          legacyRequest({
            host: 'aula-b.test',
            secret: CREDS[B]!.webhookSecret,
            type: 'checkout.session.completed',
            object: sessionObject(A, ORDER_A, sessionId),
          }),
        ),
      );
      expect(status).toBe(403);
    }
    expect(t.db.snapshot()).toEqual(antes);
    expect(t.db.orders[0]!['status']).toBe('PENDING');
    expect(t.published).toEqual([]);
    expect(t.provisioned).toEqual([]);
  });

  it('(2) el mismo evento al endpoint de PLATAFORMA firmado con el secreto de B → 401, base idéntica', async () => {
    const t = build();
    seedAccount(t, A);
    const { sessionId } = seedPlatformOrder(t, A, ORDER_A);
    const antes = t.db.snapshot();

    const status = await statusOf(() =>
      t.platformController.handle(
        platformRequest({
          secret: CREDS[B]!.webhookSecret,
          type: 'checkout.session.completed',
          object: sessionObject(A, ORDER_A, sessionId),
        }),
      ),
    );

    expect(status).toBe(401);
    expect(t.db.snapshot()).toEqual(antes);
    expect(t.db.payoutsEvents).toEqual([]);
    expect(t.published).toEqual([]);
  });

  it('(3) firma de plataforma válida, sesión registrada a A y metadata.tenantId de B → sin efectos y alerta', async () => {
    const t = build();
    seedAccount(t, A);
    const { sessionId } = seedPlatformOrder(t, A, ORDER_A);
    const antes = t.db.snapshot();

    const res = await t.platformController.handle(
      platformRequest({
        secret: OPERATOR_SECRETS[0]!,
        type: 'checkout.session.completed',
        object: sessionObject(B, ORDER_A, sessionId),
      }),
    );

    expect(res).toEqual({ received: true, outcome: 'mismatch' });
    expect(t.db.snapshot()).toEqual(antes);
    expect(t.db.orders[0]!['status']).toBe('PENDING');
    expect(t.published).toEqual([]);
    // Archivado con error y sin aula.
    expect(t.db.payoutsEvents).toEqual([
      expect.objectContaining({
        tenantId: null,
        objectId: sessionId,
        errorMessage: expect.stringContaining(PAYOUTS_REF_MISMATCH_ALERT),
      }),
    ]);
    // La alerta que buscan los operadores.
    expect(t.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: PAYOUTS_REF_MISMATCH_ALERT }),
      expect.stringContaining(PAYOUTS_REF_MISMATCH_ALERT),
    );
    // Ni siquiera se preguntó a Stripe por la sesión.
    expect(t.stripe.calls).toEqual([]);
  });

  it('(4) firma válida, sesión SIN registro y metadata que nombra una orden real de A → «sin atribuir», orden PENDING', async () => {
    const t = build();
    seedAccount(t, A);
    seedPlatformOrder(t, A, ORDER_A);
    const antes = t.db.snapshot();

    const res = await t.platformController.handle(
      platformRequest({
        secret: OPERATOR_SECRETS[1]!,
        type: 'checkout.session.completed',
        object: sessionObject(A, ORDER_A, 'cs_test_inventada'),
      }),
    );

    expect(res).toEqual({ received: true, outcome: 'unattributed' });
    expect(t.db.snapshot()).toEqual(antes);
    expect(t.db.orders[0]!['status']).toBe('PENDING');
    expect(t.published).toEqual([]);
    expect(t.db.payoutsEvents).toEqual([
      expect.objectContaining({ tenantId: null, objectId: 'cs_test_inventada' }),
    ]);
  });

  it('(5) B firma en el HEREDADO un evento sobre su PROPIA sesión de plataforma → 403 (no puede completarse su venta sin pagar a la plataforma)', async () => {
    const t = build();
    seedAccount(t, B);
    const { sessionId } = seedPlatformOrder(t, B, ORDER_B);
    const antes = t.db.snapshot();

    for (const controller of [t.billingController, t.subsController]) {
      // Con el cs_ real…
      expect(
        await statusOf(() =>
          controller.handle(
            legacyRequest({
              host: 'aula-b.test',
              secret: CREDS[B]!.webhookSecret,
              type: 'checkout.session.completed',
              object: sessionObject(B, ORDER_B, sessionId),
            }),
          ),
        ),
      ).toBe(403);
      // …y con un cs_ inventado que apunta con la metadata a la orden de plataforma.
      expect(
        await statusOf(() =>
          controller.handle(
            legacyRequest({
              host: 'aula-b.test',
              secret: CREDS[B]!.webhookSecret,
              type: 'checkout.session.completed',
              object: sessionObject(B, ORDER_B, 'cs_test_de_mentira', {
                payment_intent: 'pi_de_mentira',
              }),
            }),
          ),
        ),
      ).toBe(403);
    }
    expect(t.db.snapshot()).toEqual(antes);
    expect(t.db.orders[0]!['status']).toBe('PENDING');
    expect(t.published).toEqual([]);
    expect(t.audited.map((a) => a['action'])).toEqual([
      'security.webhook.platform_object',
      'security.webhook.platform_object',
      'security.webhook.platform_object',
      'security.webhook.platform_object',
    ]);
  });

  it('(6) control: el evento legítimo de A completa la orden, matricula y deja la venta AWAITING_FEE con importes de la API', async () => {
    const t = build();
    seedAccount(t, A);
    const { sessionId, piId, chId } = seedPlatformOrder(t, A, ORDER_A, { amount: 4900 });

    const res = await t.platformController.handle(
      platformRequest({
        secret: OPERATOR_SECRETS[0]!,
        type: 'checkout.session.completed',
        // El evento dice 1 céntimo: la venta no se fía del evento.
        object: sessionObject(A, ORDER_A, sessionId, { amount_total: 1 }),
      }),
    );

    expect(res).toEqual({ received: true, outcome: 'processed', sale: 'created' });
    expect(t.db.orders[0]).toMatchObject({ status: 'COMPLETED', tenantId: A });
    expect(t.published.map((p) => [p.tenantId, p.name])).toEqual([[A, 'billing.order.completed']]);
    expect(t.provisioned).toEqual([{ tenantId: A, email: 'alumna@example.com' }]);
    expect(t.db.sales).toEqual([
      expect.objectContaining({
        tenantId: A,
        accountId: 'cuenta-a',
        sourceKind: 'ORDER',
        sourceRef: ORDER_A,
        stripeChargeId: chId,
        stripePaymentIntentId: piId,
        presentmentAmount: 4900,
        presentmentCurrency: 'eur',
        status: 'AWAITING_FEE',
      }),
    ]);
    expect(t.db.refs.map((r) => r['stripeObjectId']).sort()).toEqual(
      [sessionId, piId, chId].sort(),
    );
    expect(t.db.payoutsEvents).toEqual([
      expect.objectContaining({ tenantId: A, processedAt: expect.any(Date), errorMessage: null }),
    ]);
  });
});

// ═══════════════════════════ el resto del contrato ═══════════════════════════

describe('webhook de plataforma · idempotencia, modo y pago diferido', () => {
  it('reentrega ×5 (en serie y en paralelo) → una orden completada y una venta', async () => {
    const t = build();
    seedAccount(t, A);
    const { sessionId } = seedPlatformOrder(t, A, ORDER_A);
    const req = () =>
      platformRequest({
        secret: OPERATOR_SECRETS[0]!,
        type: 'checkout.session.completed',
        object: sessionObject(A, ORDER_A, sessionId),
        id: 'evt_test_reentrega',
      });

    const first = await t.platformController.handle(req());
    expect(first.outcome).toBe('processed');
    const rest = await Promise.all(
      Array.from({ length: 4 }, () => t.platformController.handle(req())),
    );
    expect(rest.map((r) => r.outcome)).toEqual([
      'duplicate',
      'duplicate',
      'duplicate',
      'duplicate',
    ]);

    // Otro evento distinto de la MISMA sesión (p. ej. un reenvío manual con otro id).
    const otro = await t.platformController.handle(
      platformRequest({
        secret: OPERATOR_SECRETS[1]!,
        type: 'checkout.session.completed',
        object: sessionObject(A, ORDER_A, sessionId),
      }),
    );
    expect(otro).toEqual({ received: true, outcome: 'processed', sale: 'exists' });

    expect(t.db.orders.filter((o) => o['status'] === 'COMPLETED')).toHaveLength(1);
    expect(t.db.sales).toHaveLength(1);
    expect(t.provisioned).toHaveLength(1);
  });

  it('evento de modo prueba con la clave de producción → 400 sin tocar nada', async () => {
    const t = build();
    seedAccount(t, A);
    const { sessionId } = seedPlatformOrder(t, A, ORDER_A);
    (
      t.platformController as unknown as { runtime: { config: { livemode: boolean } } }
    ).runtime.config.livemode = true;
    const antes = t.db.snapshot();

    const status = await statusOf(() =>
      t.platformController.handle(
        platformRequest({
          secret: OPERATOR_SECRETS[0]!,
          type: 'checkout.session.completed',
          object: sessionObject(A, ORDER_A, sessionId),
          livemode: false,
        }),
      ),
    );
    expect(status).toBe(400);
    expect(t.db.snapshot()).toEqual(antes);
    expect(t.db.payoutsEvents).toEqual([]);
  });

  it('pago diferido: completed sin cobrar → ni venta ni acceso; async_payment_succeeded → las dos cosas', async () => {
    const t = build();
    seedAccount(t, A);
    const { sessionId } = seedPlatformOrder(t, A, ORDER_A, {
      paymentStatus: 'unpaid',
      chargeStatus: 'pending',
    });

    const completed = await t.platformController.handle(
      platformRequest({
        secret: OPERATOR_SECRETS[0]!,
        type: 'checkout.session.completed',
        object: sessionObject(A, ORDER_A, sessionId, { payment_status: 'unpaid' }),
      }),
    );
    expect(completed).toEqual({ received: true, outcome: 'processed', sale: 'not_paid' });
    expect(t.db.sales).toEqual([]);
    expect(t.db.orders[0]!['status']).toBe('PENDING');
    expect(t.published).toEqual([]);

    // Llega el dinero.
    t.stripe.patch(sessionId, { payment_status: 'paid' });
    t.stripe.patch(`ch_${ORDER_A.replace(/-/g, '')}`, { status: 'succeeded', paid: true });
    const succeeded = await t.platformController.handle(
      platformRequest({
        secret: OPERATOR_SECRETS[0]!,
        type: 'checkout.session.async_payment_succeeded',
        object: sessionObject(A, ORDER_A, sessionId),
      }),
    );
    expect(succeeded).toEqual({ received: true, outcome: 'processed', sale: 'created' });
    expect(t.db.sales).toHaveLength(1);
    expect(t.db.orders[0]!['status']).toBe('COMPLETED');
  });

  it('la sesión apunta a otra orden que la registrada → mismatch sin efectos', async () => {
    const t = build();
    seedAccount(t, A);
    const { sessionId } = seedPlatformOrder(t, A, ORDER_A);
    // Otra orden real de A, PENDING, a la que intenta llevarse el pago.
    t.db.orders.push({ ...t.db.orders[0]!, id: '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c' });
    const antes = t.db.snapshot();

    const res = await t.platformController.handle(
      platformRequest({
        secret: OPERATOR_SECRETS[0]!,
        type: 'checkout.session.completed',
        object: sessionObject(A, '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c', sessionId),
      }),
    );
    expect(res.outcome).toBe('mismatch');
    expect(t.db.snapshot()).toEqual(antes);
    expect(t.published).toEqual([]);
  });

  it('la parte de dinero falla (Stripe caído) → el acceso se concede igual y la venta queda pendiente', async () => {
    const t = build();
    seedAccount(t, A);
    const { sessionId } = seedPlatformOrder(t, A, ORDER_A);
    t.stripe.failNext(`/v1/checkout/sessions/${sessionId}`, {
      message: 'Stripe no responde',
      status: 503,
      type: 'api_error',
    });

    const res = await t.platformController.handle(
      platformRequest({
        secret: OPERATOR_SECRETS[0]!,
        type: 'checkout.session.completed',
        object: sessionObject(A, ORDER_A, sessionId),
      }),
    );
    expect(res).toEqual({ received: true, outcome: 'processed', sale: 'pending' });
    expect(t.db.orders[0]!['status']).toBe('COMPLETED');
    expect(t.db.sales).toEqual([]);
    expect(t.db.payoutsEvents[0]).toMatchObject({
      tenantId: A,
      processedAt: expect.any(Date),
      errorMessage: expect.stringMatching(/^dinero: /),
    });
  });

  it('el reparto a módulos falla → 5xx (el error sale) y el evento queda sin procesar para el reintento', async () => {
    const t = build();
    seedAccount(t, A);
    const { sessionId } = seedPlatformOrder(t, A, ORDER_A);
    // La orden no existe en billing: el módulo lanza y Stripe debe reintentar.
    t.db.orders = [];

    await expect(
      t.platformController.handle(
        platformRequest({
          secret: OPERATOR_SECRETS[0]!,
          type: 'checkout.session.completed',
          object: sessionObject(A, ORDER_A, sessionId),
          id: 'evt_test_falla_reparto',
        }),
      ),
    ).rejects.toThrow();
    expect(t.db.payoutsEvents[0]).toMatchObject({
      stripeEventId: 'evt_test_falla_reparto',
      tenantId: A,
      processedAt: null,
      attempts: 1,
    });
  });
});
