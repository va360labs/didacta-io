import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, HttpException } from '@nestjs/common';
import Stripe from 'stripe';
import { BillingService } from '@didacta/mod-billing';
import { MembershipService, SubscriptionsService } from '@didacta/mod-subscriptions';
import { BillingErrorFilter } from '../src/modules/billing/billing-error.filter';
import { BillingWebhookController } from '../src/modules/billing/billing-webhook.controller';
import { SubscriptionsErrorFilter } from '../src/modules/subscriptions/subscriptions-error.filter';
import { SubscriptionsWebhookController } from '../src/modules/subscriptions/subscriptions-webhook.controller';
import { TenantStripeResolverService } from '../src/modules/tenant-stripe-resolver.service';
import { TenantResolverService } from '../src/tenancy/tenant-resolver.service';

/**
 * Aislamiento entre aulas de los webhooks de Stripe.
 *
 * El fallo que cubre: la firma se verifica con el secreto del aula del DOMINIO
 * de la petición, pero el evento se procesaba para el aula que dijera su
 * `metadata` (o para la dueña de la fila que nombrara por id). El admin del
 * aula B firmaba con SU secreto un evento que nombraba al aula A y conseguía en
 * A una membresía ACTIVE y un pedido COMPLETED sin pagar.
 *
 * Aquí no hay mocks de los servicios: son los `BillingService`,
 * `SubscriptionsService` y `MembershipService` de verdad, la firma es la de
 * Stripe de verdad (`constructEvent` con su tolerancia de reloj) y el resolutor
 * de credenciales es el de verdad. Lo único simulado es la base, en memoria y
 * SIN RLS a propósito: el arreglo no puede depender de que la base filtre.
 *
 * Los tests del ataque solo miran lo que se ve desde fuera —el código HTTP y
 * el estado de la base— para que se puedan ejecutar tal cual contra el código
 * anterior al arreglo, donde FALLAN.
 */

// ───────────────────────────── aulas ─────────────────────────────

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // la víctima
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // la atacante
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // sin Stripe propio (cuenta de instancia)
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; // sin Stripe propio (cuenta de instancia)
const E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'; // misma cuenta de Stripe que A, otro endpoint

const HOST: Record<string, string> = {
  'aula-a.test': A,
  'aula-b.test': B,
  'aula-c.test': C,
  'aula-d.test': D,
  'aula-e.test': E,
};

const CREDS = {
  [A]: { secretKey: 'sk_test_cuenta_de_A', webhookSecret: 'whsec_de_A' },
  [B]: { secretKey: 'sk_test_cuenta_de_B', webhookSecret: 'whsec_de_B' },
  // Misma cuenta que A (misma clave secreta), con su propio endpoint en Stripe.
  [E]: { secretKey: 'sk_test_cuenta_de_A', webhookSecret: 'whsec_de_E' },
} as Record<string, { secretKey: string; webhookSecret: string }>;

const GLOBAL = { secretKey: 'sk_test_cuenta_de_instancia', webhookSecret: 'whsec_de_instancia' };

// ───────────────────── base en memoria (sin RLS) ─────────────────────

type Row = Record<string, unknown>;

function uniqueViolation(table: string): Error {
  return new Error(`Unique constraint failed on the constraint: \`${table}_pkey\``);
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
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

class FakeDb {
  orders: Row[] = [];
  billingEvents: Row[] = [];
  subs: Row[] = [];
  invoices: Row[] = [];
  subsEvents: Row[] = [];
  plans: Row[] = [];
  private seq = 0;

  /** Todo lo que un evento podría crear o modificar. */
  snapshot() {
    return structuredClone({
      orders: this.orders,
      billingEvents: this.billingEvents,
      subs: this.subs,
      invoices: this.invoices,
      subsEvents: this.subsEvents,
    });
  }

  private table(rows: () => Row[], opts: { pk?: string; name?: string } = {}) {
    const pk = opts.pk ?? 'id';
    return {
      findUnique: async (args: { where: Row }) =>
        rows().find((r) => matches(r, args.where)) ?? null,
      findFirst: async (args: { where: Row }) => rows().find((r) => matches(r, args.where)) ?? null,
      create: async (args: { data: Row }) => {
        const row: Row = { ...args.data };
        if (row[pk] === undefined) row[pk] = `${opts.name ?? 'row'}-${++this.seq}`;
        if (rows().some((r) => r[pk] === row[pk])) throw uniqueViolation(opts.name ?? 'tabla');
        rows().push(row);
        return row;
      },
      update: async (args: { where: Row; data: Row }) => {
        const row = rows().find((r) => matches(r, args.where));
        if (!row) throw new Error('Record to update not found.');
        Object.assign(row, args.data);
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
}

// ───────────────────────────── arnés ─────────────────────────────

function build(opts: { globalFallbackAllowed?: boolean } = {}) {
  const db = new FakeDb();
  const published: Array<{ tenantId: string; name: string; payload: Row }> = [];
  const publisher = {
    publish: async (tenantId: string, _actor: string | null, name: string, payload: Row) => {
      published.push({ tenantId, name, payload });
    },
  };
  const noStripe = async () => {
    throw new Error('el webhook no debe llamar a la API de Stripe en estos tests');
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
  const stripeResolver = new TenantStripeResolverService(
    tenantConfig as never,
    async () => opts.globalFallbackAllowed ?? true,
  );

  const domainResolver = new TenantResolverService({
    tenantDomain: {
      findFirst: async (args: { where: { tenantId?: string } }) => {
        const hostname = Object.keys(HOST).find((h) => HOST[h] === args.where.tenantId);
        return hostname ? { hostname } : null;
      },
    },
  } as never);
  const tenantResolver = {
    resolveByHost: async (host: string | undefined) => {
      const id = host ? HOST[host] : undefined;
      return id ? { id, slug: host, name: host, matchedBy: 'hostname', hostname: host } : null;
    },
    // Resolvedor REAL sobre los dominios de arriba: el «define tu contraseña»
    // del comprador sale con el dominio del aula del EVENTO, no con el de la
    // petición (el endpoint de Stripe puede estar en el dominio de otra aula, o
    // en el del despliegue).
    resolveTenantWebBaseUrl: (tenantId: string | null, req?: never) =>
      domainResolver.resolveTenantWebBaseUrl(tenantId, req),
  };

  // Los dos provisioners (comprador de curso y comprador de membresía).
  const provisioned: Array<{ tenantId: string; email: string }> = [];
  /** Base del enlace «define tu contraseña» que recibió cada alta. */
  const provisionedBases: Array<{ tenantId: string; webBaseUrl: string }> = [];
  const provision = async (args: { tenantId: string; email: string; webBaseUrl: string }) => {
    provisioned.push({ tenantId: args.tenantId, email: args.email });
    provisionedBases.push({ tenantId: args.tenantId, webBaseUrl: args.webBaseUrl });
    return { userId: `user-${args.tenantId.slice(0, 1)}-${args.email}`, created: true };
  };
  const provisioning = { provision };

  const audited: Row[] = [];
  const auditLog = {
    record: async (entry: Row) => {
      audited.push(entry);
    },
  };
  const logger = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };

  const billingController = new BillingWebhookController(
    registry as never,
    provisioning as never,
    tenantResolver as never,
    stripeResolver,
    auditLog as never,
    logger as never,
  );
  const subsController = new SubscriptionsWebhookController(
    registry as never,
    provisioning as never,
    provisioning as never,
    logger as never,
    tenantResolver as never,
    stripeResolver,
    auditLog as never,
  );

  return {
    db,
    published,
    provisioned,
    provisionedBases,
    audited,
    logger,
    billingController,
    subsController,
  };
}

let eventSeq = 0;

/** Petición tal como la entrega Stripe: cuerpo crudo + cabecera `stripe-signature`. */
function signedRequest(args: {
  host: string;
  /** Secreto con el que se firma: el que conoce quien envía. */
  secret: string;
  type: string;
  object: Row;
  id?: string;
  signature?: string;
}) {
  const payload = JSON.stringify({
    id: args.id ?? `evt_test_${++eventSeq}`,
    object: 'event',
    type: args.type,
    created: Math.floor(Date.now() / 1000),
    data: { object: args.object },
  });
  const signature =
    args.signature ?? Stripe.webhooks.generateTestHeaderString({ payload, secret: args.secret });
  return {
    headers: { host: args.host, 'stripe-signature': signature, 'user-agent': 'Stripe/1.0' },
    ip: '203.0.113.7',
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
    const name = (err as { constructor?: { name?: string } }).constructor?.name ?? '';
    const code = (err as { code?: string }).code ?? '';
    if (code.startsWith('BILLING_')) new BillingErrorFilter().catch(err as never, host);
    else if (code.startsWith('SUBSCRIPTIONS_') || code.startsWith('MEMBERSHIP_'))
      new SubscriptionsErrorFilter().catch(err as never, host);
    else {
      throw new Error(`error sin mapeo HTTP conocido (${name}): ${(err as Error).message}`, {
        cause: err,
      });
    }
    return status;
  }
}

// ─────────────────── datos de partida de cada aula ───────────────────

function seedPlan(db: FakeDb, tenantId: string, id: string) {
  db.plans.push({
    id,
    tenantId,
    name: 'Plan mensual',
    amountCents: 4900,
    currency: 'eur',
    intervalMonths: 1,
    trialDays: 0,
    active: true,
    stripePriceId: `price_${id}`,
    stripeProductId: `prod_${id}`,
  });
}

function seedOrder(db: FakeDb, tenantId: string, id: string, extra: Row = {}) {
  db.orders.push({
    id,
    tenantId,
    userId: `alumno-de-${tenantId.slice(0, 1)}`,
    productId: `producto-${id}`,
    courseId: `curso-${id}`,
    stripeSessionId: `cs_${id}`,
    stripePaymentIntentId: null,
    status: 'PENDING',
    amountPaid: null,
    currency: 'eur',
    customerEmail: null,
    completedAt: null,
    refundedAt: null,
    ...extra,
  });
}

function seedSubscription(db: FakeDb, tenantId: string, id: string, extra: Row = {}) {
  db.subs.push({
    id,
    tenantId,
    userId: `alumno-de-${tenantId.slice(0, 1)}`,
    courseId: null,
    planId: `plan-${tenantId.slice(0, 1)}`,
    stripeSubscriptionId: `sub_${id}`,
    stripeCustomerId: `cus_${id}`,
    status: 'ACTIVE',
    canceledAt: null,
    canceledReason: null,
    gracePeriodEndsAt: null,
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    ...extra,
  });
}

function membershipSession(tenantId: string, planId: string, extra: Row = {}): Row {
  return {
    id: `cs_memb_${++eventSeq}`,
    object: 'checkout.session',
    payment_status: 'paid',
    status: 'complete',
    subscription: `sub_nueva_${eventSeq}`,
    customer: 'cus_comprador',
    customer_details: { email: 'comprador@example.com', name: 'Comprador' },
    metadata: { membership: '1', tenantId, planId },
    ...extra,
  };
}

function courseSession(tenantId: string, orderId: string, extra: Row = {}): Row {
  return {
    id: `cs_curso_${++eventSeq}`,
    object: 'checkout.session',
    payment_status: 'paid',
    status: 'complete',
    payment_intent: `pi_${orderId}`,
    amount_total: 9900,
    customer_details: { email: 'comprador@example.com', name: 'Comprador' },
    metadata: { orderId, productId: `producto-${orderId}`, tenantId, courseId: `curso-${orderId}` },
    ...extra,
  };
}

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

// ══════════════════════════ (a) EL ATAQUE ══════════════════════════

describe('webhooks de Stripe · un aula no puede tocar a otra firmando con su propio secreto', () => {
  it('MEMBRESÍA: evento firmado por B que nombra a A, enviado al dominio de B → 403 y cero efectos', async () => {
    const t = build();
    seedPlan(t.db, A, 'plan-a');
    seedPlan(t.db, B, 'plan-b');
    const antes = t.db.snapshot();

    const status = await statusOf(() =>
      t.subsController.handle(
        signedRequest({
          host: 'aula-b.test',
          secret: CREDS[B]!.webhookSecret,
          type: 'checkout.session.completed',
          object: membershipSession(A, 'plan-a'),
        }),
      ),
    );

    expect(status).toBe(403);
    // Ni en A ni en B: ni membresía, ni usuario, ni evento de dominio, ni
    // siquiera el archivo del webhook.
    expect(t.db.snapshot()).toEqual(antes);
    expect(t.db.subs).toHaveLength(0);
    expect(t.provisioned).toEqual([]);
    expect(t.published).toEqual([]);
  });

  it('CURSO: evento firmado por B que nombra una orden de A, enviado al dominio de B → 403 y la orden sigue PENDING', async () => {
    const t = build();
    seedOrder(t.db, A, 'orden-a');
    const antes = t.db.snapshot();

    const status = await statusOf(() =>
      t.billingController.handle(
        signedRequest({
          host: 'aula-b.test',
          secret: CREDS[B]!.webhookSecret,
          type: 'checkout.session.completed',
          object: courseSession(A, 'orden-a'),
        }),
      ),
    );

    expect(status).toBe(403);
    expect(t.db.snapshot()).toEqual(antes);
    expect(t.db.orders[0]!['status']).toBe('PENDING');
    expect(t.provisioned).toEqual([]);
    expect(t.published).toEqual([]);
  });

  it('CURSO por el webhook compartido de suscripciones (fan-out a billing): mismo ataque, mismo 403', async () => {
    const t = build();
    seedOrder(t.db, A, 'orden-a');
    const antes = t.db.snapshot();

    const status = await statusOf(() =>
      t.subsController.handle(
        signedRequest({
          host: 'aula-b.test',
          secret: CREDS[B]!.webhookSecret,
          type: 'checkout.session.completed',
          object: courseSession(A, 'orden-a'),
        }),
      ),
    );

    expect(status).toBe(403);
    expect(t.db.snapshot()).toEqual(antes);
    expect(t.published).toEqual([]);
  });

  it('metadata con el tenant PROPIO pero una orden AJENA: la fila manda → 403', async () => {
    const t = build();
    seedOrder(t.db, A, 'orden-a');
    const antes = t.db.snapshot();

    // B dice «es mío» en la metadata y apunta a la orden de A.
    const status = await statusOf(() =>
      t.billingController.handle(
        signedRequest({
          host: 'aula-b.test',
          secret: CREDS[B]!.webhookSecret,
          type: 'checkout.session.completed',
          object: courseSession(B, 'orden-a'),
        }),
      ),
    );

    expect(status).toBe(403);
    expect(t.db.snapshot()).toEqual(antes);
    expect(t.provisioned).toEqual([]);
    expect(t.published).toEqual([]);
  });

  describe('objetos que se resuelven por id (sin metadata de tenant)', () => {
    it('customer.subscription.deleted con el id de una suscripción de A → 403 y sigue ACTIVE', async () => {
      const t = build();
      seedSubscription(t.db, A, 'memb-a');
      const antes = t.db.snapshot();

      const status = await statusOf(() =>
        t.subsController.handle(
          signedRequest({
            host: 'aula-b.test',
            secret: CREDS[B]!.webhookSecret,
            type: 'customer.subscription.deleted',
            object: { id: 'sub_memb-a', object: 'subscription', status: 'canceled' },
          }),
        ),
      );

      expect(status).toBe(403);
      expect(t.db.snapshot()).toEqual(antes);
      expect(t.db.subs[0]!['status']).toBe('ACTIVE');
      expect(t.published).toEqual([]);
    });

    it('customer.subscription.created con el id LOCAL de una suscripción PENDING de A → 403 y sigue PENDING', async () => {
      const t = build();
      seedSubscription(t.db, A, 'pend-a', { status: 'PENDING', stripeSubscriptionId: null });
      const antes = t.db.snapshot();

      const status = await statusOf(() =>
        t.subsController.handle(
          signedRequest({
            host: 'aula-b.test',
            secret: CREDS[B]!.webhookSecret,
            type: 'customer.subscription.created',
            object: {
              id: 'sub_inventada',
              object: 'subscription',
              status: 'active',
              customer: 'cus_x',
              metadata: { subscriptionLocalId: 'pend-a' },
            },
          }),
        ),
      );

      expect(status).toBe(403);
      expect(t.db.snapshot()).toEqual(antes);
      expect(t.published).toEqual([]);
    });

    it('invoice.paid sobre una suscripción impagada de A → 403 y no se reactiva', async () => {
      const t = build();
      seedSubscription(t.db, A, 'impagada-a', { status: 'UNPAID' });
      const antes = t.db.snapshot();

      const status = await statusOf(() =>
        t.subsController.handle(
          signedRequest({
            host: 'aula-b.test',
            secret: CREDS[B]!.webhookSecret,
            type: 'invoice.paid',
            object: {
              id: 'in_inventada',
              object: 'invoice',
              subscription: 'sub_impagada-a',
              amount_paid: 4900,
              currency: 'eur',
            },
          }),
        ),
      );

      expect(status).toBe(403);
      expect(t.db.snapshot()).toEqual(antes);
      expect(t.published).toEqual([]);
    });

    it('invoice.paid sobre una suscripción PROPIA con el id de una factura de A → 403 y la factura no cambia de dueño', async () => {
      const t = build();
      seedSubscription(t.db, B, 'memb-b');
      t.db.invoices.push({
        id: 'factura-a',
        tenantId: A,
        subscriptionId: 'memb-a',
        stripeInvoiceId: 'in_de_A',
        status: 'PAID',
        amount: 4900,
        currency: 'eur',
      });
      const antes = t.db.snapshot();

      const status = await statusOf(() =>
        t.subsController.handle(
          signedRequest({
            host: 'aula-b.test',
            secret: CREDS[B]!.webhookSecret,
            type: 'invoice.paid',
            object: {
              id: 'in_de_A',
              object: 'invoice',
              subscription: 'sub_memb-b',
              amount_paid: 1,
              currency: 'eur',
            },
          }),
        ),
      );

      expect(status).toBe(403);
      expect(t.db.snapshot()).toEqual(antes);
      expect(t.db.invoices[0]!['tenantId']).toBe(A);
    });

    it('charge.refunded con el PaymentIntent de una compra de A → 403 y la compra sigue COMPLETED', async () => {
      const t = build();
      seedOrder(t.db, A, 'orden-a', { status: 'COMPLETED', stripePaymentIntentId: 'pi_de_A' });
      const antes = t.db.snapshot();

      const status = await statusOf(() =>
        t.billingController.handle(
          signedRequest({
            host: 'aula-b.test',
            secret: CREDS[B]!.webhookSecret,
            type: 'charge.refunded',
            object: {
              id: 'ch_inventado',
              object: 'charge',
              payment_intent: 'pi_de_A',
              amount: 9900,
              amount_refunded: 9900,
            },
          }),
        ),
      );

      expect(status).toBe(403);
      expect(t.db.snapshot()).toEqual(antes);
      expect(t.published).toEqual([]);
    });

    it('async_payment_failed con el orderId de una compra pagada de A (sin más marca) → 403 y no pierde el acceso', async () => {
      const t = build();
      seedOrder(t.db, A, 'orden-a', { status: 'COMPLETED' });
      const antes = t.db.snapshot();

      // Sin `productId` ni `tenantId`: antes esto no resolvía tenant alguno y el
      // procesado corría con acceso global — encontraba la orden de A igual.
      const status = await statusOf(() =>
        t.billingController.handle(
          signedRequest({
            host: 'aula-b.test',
            secret: CREDS[B]!.webhookSecret,
            type: 'checkout.session.async_payment_failed',
            object: {
              id: 'cs_inventada',
              object: 'checkout.session',
              status: 'complete',
              metadata: { orderId: 'orden-a' },
            },
          }),
        ),
      );

      expect(status).toBe(403);
      expect(t.db.snapshot()).toEqual(antes);
      expect(t.db.orders[0]!['status']).toBe('COMPLETED');
      expect(t.published).toEqual([]);
    });
  });

  it('el rechazo deja rastro: log de error y auditoría en el aula que FIRMÓ, no en la víctima', async () => {
    const t = build();
    seedPlan(t.db, A, 'plan-a');

    await statusOf(() =>
      t.subsController.handle(
        signedRequest({
          host: 'aula-b.test',
          secret: CREDS[B]!.webhookSecret,
          type: 'checkout.session.completed',
          object: membershipSession(A, 'plan-a'),
          id: 'evt_sospechoso',
        }),
      ),
    );

    expect(t.logger.error).toHaveBeenCalledTimes(1);
    expect(t.logger.error.mock.calls[0]![0]).toMatchObject({
      verifiedTenantId: B,
      claimedTenantIds: [A],
      eventId: 'evt_sospechoso',
    });
    expect(t.audited).toHaveLength(1);
    expect(t.audited[0]).toMatchObject({
      tenantId: B,
      action: 'security.webhook.tenant_mismatch',
      resourceType: 'stripe_webhook',
      resourceId: 'evt_sospechoso',
      ip: '203.0.113.7',
    });
  });

  it('una metadata con un tenantId que no es un UUID se rechaza sin usarlo de contexto', async () => {
    const t = build();
    const antes = t.db.snapshot();

    const status = await statusOf(() =>
      t.subsController.handle(
        signedRequest({
          host: 'aula-b.test',
          secret: CREDS[B]!.webhookSecret,
          type: 'checkout.session.completed',
          object: membershipSession("x'; select 1 --", 'plan-a'),
        }),
      ),
    );

    expect(status).toBe(403);
    expect(t.db.snapshot()).toEqual(antes);
  });
});

// ══════════════════════════ (b) CONTROL ══════════════════════════

describe('webhooks de Stripe · control: lo legítimo se sigue procesando', () => {
  it('MEMBRESÍA de B para B, firmada por B, en el dominio de B → 200 y membresía ACTIVE en B', async () => {
    const t = build();
    seedPlan(t.db, A, 'plan-a');
    seedPlan(t.db, B, 'plan-b');

    const status = await statusOf(() =>
      t.subsController.handle(
        signedRequest({
          host: 'aula-b.test',
          secret: CREDS[B]!.webhookSecret,
          type: 'checkout.session.completed',
          object: membershipSession(B, 'plan-b'),
        }),
      ),
    );

    expect(status).toBe(200);
    expect(t.db.subs).toHaveLength(1);
    expect(t.db.subs[0]).toMatchObject({ tenantId: B, planId: 'plan-b', status: 'ACTIVE' });
    expect(t.provisioned).toEqual([{ tenantId: B, email: 'comprador@example.com' }]);
    expect(t.provisionedBases).toEqual([{ tenantId: B, webBaseUrl: 'https://aula-b.test' }]);
    expect(t.published.map((e) => [e.tenantId, e.name])).toEqual([
      [B, 'subscriptions.membership.activated'],
    ]);
    // El webhook queda archivado a nombre del aula verificada.
    expect(t.db.subsEvents).toHaveLength(1);
    expect(t.db.subsEvents[0]).toMatchObject({ tenantId: B });
    expect(t.audited).toEqual([]);
  });

  it('CURSO de B para B → 200, orden COMPLETED y evento de dominio en B', async () => {
    const t = build();
    seedOrder(t.db, B, 'orden-b');

    const status = await statusOf(() =>
      t.billingController.handle(
        signedRequest({
          host: 'aula-b.test',
          secret: CREDS[B]!.webhookSecret,
          type: 'checkout.session.completed',
          object: courseSession(B, 'orden-b'),
        }),
      ),
    );

    expect(status).toBe(200);
    expect(t.db.orders[0]).toMatchObject({ tenantId: B, status: 'COMPLETED', amountPaid: 9900 });
    expect(t.published.map((e) => [e.tenantId, e.name])).toEqual([[B, 'billing.order.completed']]);
    expect(t.db.billingEvents[0]).toMatchObject({ tenantId: B });
  });

  it('baja de una suscripción PROPIA → 200 y CANCELED', async () => {
    const t = build();
    seedSubscription(t.db, B, 'memb-b');

    const status = await statusOf(() =>
      t.subsController.handle(
        signedRequest({
          host: 'aula-b.test',
          secret: CREDS[B]!.webhookSecret,
          type: 'customer.subscription.deleted',
          object: { id: 'sub_memb-b', object: 'subscription', status: 'canceled' },
        }),
      ),
    );

    expect(status).toBe(200);
    expect(t.db.subs[0]!['status']).toBe('CANCELED');
  });

  it('evento que no es de ningún módulo (sin metadata ni filas) → 200 y solo se archiva en el aula del dominio', async () => {
    const t = build();

    const status = await statusOf(() =>
      t.subsController.handle(
        signedRequest({
          host: 'aula-b.test',
          secret: CREDS[B]!.webhookSecret,
          type: 'payment_method.attached',
          object: { id: 'pm_1', object: 'payment_method' },
        }),
      ),
    );

    expect(status).toBe(200);
    expect(t.db.subsEvents).toHaveLength(1);
    expect(t.db.subsEvents[0]).toMatchObject({ tenantId: B });
    expect(t.db.subs).toHaveLength(0);
    expect(t.published).toEqual([]);
  });
});

// ══════════════════════ (c) FIRMA INVÁLIDA → 401 ══════════════════════

describe('webhooks de Stripe · firma', () => {
  it('firma inventada → 401 y cero efectos (los dos endpoints)', async () => {
    const t = build();
    seedPlan(t.db, B, 'plan-b');
    seedOrder(t.db, B, 'orden-b');
    const antes = t.db.snapshot();

    const basura = `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`;
    expect(
      await statusOf(() =>
        t.subsController.handle(
          signedRequest({
            host: 'aula-b.test',
            secret: 'da-igual',
            signature: basura,
            type: 'checkout.session.completed',
            object: membershipSession(B, 'plan-b'),
          }),
        ),
      ),
    ).toBe(401);
    expect(
      await statusOf(() =>
        t.billingController.handle(
          signedRequest({
            host: 'aula-b.test',
            secret: 'da-igual',
            signature: basura,
            type: 'checkout.session.completed',
            object: courseSession(B, 'orden-b'),
          }),
        ),
      ),
    ).toBe(401);

    expect(t.db.snapshot()).toEqual(antes);
    expect(t.published).toEqual([]);
  });

  it('el evento del ataque enviado al dominio de la VÍCTIMA → 401 (el secreto de B no es el de A)', async () => {
    const t = build();
    seedPlan(t.db, A, 'plan-a');
    const antes = t.db.snapshot();

    const status = await statusOf(() =>
      t.subsController.handle(
        signedRequest({
          host: 'aula-a.test',
          secret: CREDS[B]!.webhookSecret,
          type: 'checkout.session.completed',
          object: membershipSession(A, 'plan-a'),
        }),
      ),
    );

    expect(status).toBe(401);
    expect(t.db.snapshot()).toEqual(antes);
  });

  it('sin cabecera stripe-signature → 401', async () => {
    const t = build();
    const req = signedRequest({
      host: 'aula-b.test',
      secret: CREDS[B]!.webhookSecret,
      type: 'checkout.session.completed',
      object: membershipSession(B, 'plan-b'),
    }) as unknown as { headers: Record<string, string> };
    delete req.headers['stripe-signature'];

    expect(await statusOf(() => t.subsController.handle(req as never))).toBe(401);
    expect(await statusOf(() => t.billingController.handle(req as never))).toBe(401);
  });

  it('dominio que no es de ningún aula → 404', async () => {
    const t = build();
    const status = await statusOf(() =>
      t.billingController.handle(
        signedRequest({
          host: 'no-existe.test',
          secret: CREDS[B]!.webhookSecret,
          type: 'checkout.session.completed',
          object: courseSession(B, 'orden-b'),
        }),
      ),
    );
    expect(status).toBe(404);
  });
});

// ═════════════════ (d) REENTREGA DEL MISMO EVENTO ═════════════════

describe('webhooks de Stripe · la reentrega del mismo evento no duplica', () => {
  it('membresía: dos entregas → una suscripción, un usuario, un evento de dominio', async () => {
    const t = build();
    seedPlan(t.db, B, 'plan-b');
    const args = {
      host: 'aula-b.test',
      secret: CREDS[B]!.webhookSecret,
      type: 'checkout.session.completed',
      object: membershipSession(B, 'plan-b'),
      id: 'evt_reentregado',
    };

    expect(await statusOf(() => t.subsController.handle(signedRequest(args)))).toBe(200);
    expect(await statusOf(() => t.subsController.handle(signedRequest(args)))).toBe(200);

    expect(t.db.subs).toHaveLength(1);
    expect(t.provisioned).toHaveLength(1);
    expect(t.published.filter((e) => e.name === 'subscriptions.membership.activated')).toHaveLength(
      1,
    );
    expect(t.db.subsEvents).toHaveLength(1);
  });

  it('curso: dos entregas → la orden se completa una vez y no se vuelve a publicar', async () => {
    const t = build();
    seedOrder(t.db, B, 'orden-b');
    const args = {
      host: 'aula-b.test',
      secret: CREDS[B]!.webhookSecret,
      type: 'checkout.session.completed',
      object: courseSession(B, 'orden-b'),
      id: 'evt_reentregado_curso',
    };

    expect(await statusOf(() => t.billingController.handle(signedRequest(args)))).toBe(200);
    const completedAt = t.db.orders[0]!['completedAt'];
    expect(await statusOf(() => t.billingController.handle(signedRequest(args)))).toBe(200);

    expect(t.db.orders[0]!['status']).toBe('COMPLETED');
    expect(t.db.orders[0]!['completedAt']).toBe(completedAt);
    expect(t.published.filter((e) => e.name === 'billing.order.completed')).toHaveLength(1);
    expect(t.db.billingEvents).toHaveLength(1);
  });
});

// ══════════ COMPATIBILIDAD: una cuenta de Stripe para varias aulas ══════════

describe('webhooks de Stripe · varias aulas sobre la MISMA cuenta de Stripe', () => {
  beforeEach(() => {
    process.env['STRIPE_SECRET_KEY'] = GLOBAL.secretKey;
    process.env['STRIPE_WEBHOOK_SECRET'] = GLOBAL.webhookSecret;
  });

  it('cuenta de instancia: el único endpoint apunta al dominio de C y el evento es de D → se procesa para D', async () => {
    // Despliegue heredado: varias aulas del mismo dueño cobrando con las
    // STRIPE_* de instancia. Stripe tiene UN endpoint (un secreto) y reparte
    // por metadata. Tiene que seguir funcionando.
    const t = build({ globalFallbackAllowed: true });
    seedPlan(t.db, D, 'plan-d');

    const status = await statusOf(() =>
      t.subsController.handle(
        signedRequest({
          host: 'aula-c.test',
          secret: GLOBAL.webhookSecret,
          type: 'checkout.session.completed',
          object: membershipSession(D, 'plan-d'),
        }),
      ),
    );

    expect(status).toBe(200);
    expect(t.db.subs).toHaveLength(1);
    expect(t.db.subs[0]).toMatchObject({ tenantId: D, status: 'ACTIVE' });
    expect(t.provisioned).toEqual([{ tenantId: D, email: 'comprador@example.com' }]);
    // El enlace del comprador va al aula de la compra (D), no a la del
    // dominio por el que llegó el webhook (C).
    expect(t.provisionedBases).toEqual([{ tenantId: D, webBaseUrl: 'https://aula-d.test' }]);
    expect(t.audited).toEqual([]);
  });

  it('compra de CURSO sin cuenta en D, webhook por el dominio de C y WEB_PUBLIC_URL del despliegue → enlace al dominio de D', async () => {
    const previous = process.env['WEB_PUBLIC_URL'];
    process.env['WEB_PUBLIC_URL'] = 'https://pool.didacta.io';
    try {
      const t = build({ globalFallbackAllowed: true });
      seedOrder(t.db, D, 'orden-d', { userId: null });

      const status = await statusOf(() =>
        t.billingController.handle(
          signedRequest({
            host: 'aula-c.test',
            secret: GLOBAL.webhookSecret,
            type: 'checkout.session.completed',
            object: courseSession(D, 'orden-d'),
          }),
        ),
      );

      expect(status).toBe(200);
      expect(t.provisioned).toEqual([{ tenantId: D, email: 'comprador@example.com' }]);
      expect(t.provisionedBases).toEqual([{ tenantId: D, webBaseUrl: 'https://aula-d.test' }]);
    } finally {
      if (previous === undefined) delete process.env['WEB_PUBLIC_URL'];
      else process.env['WEB_PUBLIC_URL'] = previous;
    }
  });

  it('cuenta de instancia: un evento suyo NO puede nombrar a un aula con Stripe propio → 403', async () => {
    const t = build({ globalFallbackAllowed: true });
    seedPlan(t.db, A, 'plan-a');
    const antes = t.db.snapshot();

    const status = await statusOf(() =>
      t.subsController.handle(
        signedRequest({
          host: 'aula-c.test',
          secret: GLOBAL.webhookSecret,
          type: 'checkout.session.completed',
          object: membershipSession(A, 'plan-a'),
        }),
      ),
    );

    expect(status).toBe(403);
    expect(t.db.snapshot()).toEqual(antes);
  });

  it('con el fallback de instancia APAGADO, el aula sin Stripe ni verifica firmas con esa cuenta → 401', async () => {
    const t = build({ globalFallbackAllowed: false });
    seedPlan(t.db, D, 'plan-d');
    const antes = t.db.snapshot();

    const status = await statusOf(() =>
      t.subsController.handle(
        signedRequest({
          host: 'aula-c.test',
          secret: GLOBAL.webhookSecret,
          type: 'checkout.session.completed',
          object: membershipSession(D, 'plan-d'),
        }),
      ),
    );

    expect(status).toBe(401);
    expect(t.db.snapshot()).toEqual(antes);
  });

  it('dos aulas con la misma clave secreta y endpoints distintos: el evento de A que llega al de E se procesa para A', async () => {
    // Stripe entrega TODOS los eventos de la cuenta a todos sus endpoints, así
    // que el de E recibe los de A. Quien firma con el secreto de E tiene la
    // clave secreta de A (es la misma): no es otra parte.
    const t = build();
    seedPlan(t.db, A, 'plan-a');

    const status = await statusOf(() =>
      t.subsController.handle(
        signedRequest({
          host: 'aula-e.test',
          secret: CREDS[E]!.webhookSecret,
          type: 'checkout.session.completed',
          object: membershipSession(A, 'plan-a'),
        }),
      ),
    );

    expect(status).toBe(200);
    expect(t.db.subs[0]).toMatchObject({ tenantId: A, status: 'ACTIVE' });
  });
});

// ═══════════════ el 403 es un 403 de verdad ═══════════════

describe('webhooks de Stripe · forma del rechazo', () => {
  it('lanza ForbiddenException con un code estable y sin decir nada del aula nombrada', async () => {
    const t = build();
    seedPlan(t.db, A, 'plan-a');

    const err = await t.subsController
      .handle(
        signedRequest({
          host: 'aula-b.test',
          secret: CREDS[B]!.webhookSecret,
          type: 'checkout.session.completed',
          object: membershipSession(A, 'plan-a'),
        }),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(ForbiddenException);
    const body = (err as ForbiddenException).getResponse() as { code: string; message: string };
    expect(body.code).toBe('SUBS_WEBHOOK_FOREIGN_TENANT');
    expect(body.message).not.toContain(A);
  });

  it('un fallo al escribir la auditoría no convierte el rechazo en otra cosa', async () => {
    const t = build();
    seedPlan(t.db, A, 'plan-a');
    t.audited.push = () => {
      throw new Error('auditoría caída');
    };
    const antes = t.db.snapshot();

    const status = await statusOf(() =>
      t.subsController.handle(
        signedRequest({
          host: 'aula-b.test',
          secret: CREDS[B]!.webhookSecret,
          type: 'checkout.session.completed',
          object: membershipSession(A, 'plan-a'),
        }),
      ),
    );

    expect(status).toBe(403);
    expect(t.db.snapshot()).toEqual(antes);
  });
});
