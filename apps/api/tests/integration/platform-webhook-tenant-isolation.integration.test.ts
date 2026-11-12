/**
 * Aislamiento entre aulas del webhook ÚNICO de plataforma (cobros de
 * plataforma, E3) contra un Postgres REAL, conectando como el runtime de
 * producción: rol `didacta_app` (NOSUPERUSER, NOBYPASSRLS) y RLS forzada.
 *
 * Los seis ataques de `platform-webhook-tenant-isolation.test.ts` corren allí
 * con una base en memoria sin RLS a propósito (la defensa no puede depender de
 * que la base filtre). Aquí se repiten contra la base de verdad porque lo que
 * solo pasa con RLS no se ve en memoria: el registro de objetos buscado bajo
 * acceso sancionado, el evento archivado sin aula, la venta y los hijos de la
 * sesión escritos con el contexto del tenant, la unicidad por cargo con
 * entregas simultáneas, el índice nuevo de la orden local…
 *
 * Los controladores (heredados y de plataforma), los servicios de billing,
 * suscripciones y membresía, el registro de objetos, el manejador de la venta,
 * el `PayoutsRuntime`, la extensión RLS de Prisma y las firmas son los de
 * verdad. Simulado: Stripe (el doble en memoria de `mod.payouts`), de dónde
 * salen las credenciales propias de cada aula y a qué aula va cada dominio.
 *
 * REQUISITOS: los de `rls-isolation-didacta-app.integration.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { BillingService } from '@didacta/mod-billing';
import { MembershipService, SubscriptionsService } from '@didacta/mod-subscriptions';
import {
  InMemoryPlatformStripeClient,
  PayoutsError,
  signStripePayload,
} from '@didacta/mod-payouts';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BillingProvisioningService } from '../../src/modules/billing/billing-provisioning.service';
import { BillingWebhookController } from '../../src/modules/billing/billing-webhook.controller';
import { ModuleRegistryService } from '../../src/modules/module-registry.service';
import { PAYOUTS_STATUS_BY_CODE } from '../../src/modules/payouts/payouts-error.filter';
import { PayoutsRuntime } from '../../src/modules/payouts/payouts-runtime.service';
import { ModulesPlatformEventDispatcher } from '../../src/modules/payouts/platform-event-dispatcher';
import { PlatformObjectGuard } from '../../src/modules/payouts/platform-object-guard';
import {
  loadPlatformPaymentsConfig,
  type PlatformPaymentsEnabled,
} from '../../src/modules/payouts/platform-payments.config';
import { PlatformWebhookController } from '../../src/modules/payouts/platform-webhook.controller';
import { PrismaAuditLogService } from '../../src/modules/prisma-audit-log.service';
import { MembershipProvisioningService } from '../../src/modules/subscriptions/membership-provisioning.service';
import { SubscriptionsWebhookController } from '../../src/modules/subscriptions/subscriptions-webhook.controller';
import { TenantStripeResolverService } from '../../src/modules/tenant-stripe-resolver.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TenantResolverService } from '../../src/tenancy/tenant-resolver.service';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

type Row = Record<string, unknown>;

const OPERATOR_SECRETS = ['whsec_operador_int_uno', 'whsec_operador_int_dos'];
const CONFIG = loadPlatformPaymentsConfig({
  PAYMENTS_PLATFORM_STRIPE_SECRET_KEY: 'sk_test_inventadaIntegracion',
  PAYMENTS_PLATFORM_STRIPE_WEBHOOK_SECRETS: OPERATOR_SECRETS.join(','),
}) as PlatformPaymentsEnabled;

describeWithDb('Webhook de plataforma — Postgres real como didacta_app (RLS forzada)', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;

  // A = víctima (solo plataforma) · B = atacante (plataforma Y claves propias)
  const A = randomUUID();
  const B = randomUUID();
  const stamp = Date.now();
  const HOST: Record<string, string> = { 'plat-a.test': A, 'plat-b.test': B };
  const STRIPE_OWN: Record<string, { secretKey: string; webhookSecret: string }> = {
    [B]: { secretKey: 'sk_test_cuenta-propia-de-B', webhookSecret: 'whsec_propio_de_B' },
  };
  const ACCT: Record<string, string> = { [A]: `acct_1IntA${stamp}`, [B]: `acct_1IntB${stamp}` };
  const ACCOUNT_ID: Record<string, string> = { [A]: randomUUID(), [B]: randomUUID() };

  const fake = new InMemoryPlatformStripeClient({ livemode: false });
  const published: Array<{ tenantId: string; name: string }> = [];
  const provisioned: Array<{ tenantId: string; email: string }> = [];
  const logger = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };

  let platform: PlatformWebhookController;
  let billingController: BillingWebhookController;
  let subsController: SubscriptionsWebhookController;

  beforeAll(async () => {
    const prepared = await prepareDidactaAppRole();
    admin = prepared.admin;

    const previousUrl = process.env['DATABASE_URL'];
    const previousMode = process.env['RLS_ENFORCEMENT'];
    process.env['DATABASE_URL'] = prepared.appUrl;
    process.env['RLS_ENFORCEMENT'] = 'on';
    try {
      const moduleRef = await Test.createTestingModule({ imports: [PrismaModule] }).compile();
      await moduleRef.init();
      prisma = moduleRef.get(PrismaService);
      closeModule = () => moduleRef.close();
    } finally {
      process.env['DATABASE_URL'] = previousUrl;
      if (previousMode === undefined) delete process.env['RLS_ENFORCEMENT'];
      else process.env['RLS_ENFORCEMENT'] = previousMode;
    }

    for (const [id, slug] of [
      [A, 'a'],
      [B, 'b'],
    ] as const) {
      await admin.tenant.create({
        data: { id, slug: `plat-${slug}-${stamp}`, name: `Aula ${slug}` },
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
    }

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
      {
        get: async (tenantId: string, scope: string, key: string) =>
          scope === 'billing' && key === 'stripe' ? STRIPE_OWN[tenantId] : undefined,
      } as never,
      async () => false,
    );
    const tenantResolver = {
      resolveByHost: async (host: string | undefined) => {
        const id = host ? HOST[host] : undefined;
        return id ? { id, slug: host, name: host, matchedBy: 'hostname', hostname: host } : null;
      },
      resolveTenantWebBaseUrl: async () => 'https://aula.test',
      resolveTenantWebBaseUrlForBackground: async () => 'https://aula.test',
    };
    const provisioning = {
      provision: async (args: { tenantId: string; email: string }) => {
        provisioned.push({ tenantId: args.tenantId, email: args.email });
        return { userId: randomUUID(), created: true };
      },
    };
    const auditLog = new PrismaAuditLogService(prisma);

    const runtime = new PayoutsRuntime(CONFIG, fake, prisma, stripeResolver, logger as never);
    const guard = new PlatformObjectGuard(runtime);
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
    billingController = new BillingWebhookController(
      registry as never,
      provisioning as never,
      tenantResolver as never,
      stripeResolver,
      auditLog,
      logger as never,
      guard,
    );
    subsController = new SubscriptionsWebhookController(
      registry as never,
      provisioning as never,
      provisioning as never,
      logger as never,
      tenantResolver as never,
      stripeResolver,
      auditLog,
      guard,
    );
  }, 90_000);

  afterAll(async () => {
    const tenants = [A, B];
    if (admin) {
      await admin.modPayoutsSale.deleteMany({ where: { tenantId: { in: tenants } } });
      await admin.modPayoutsObjectRef.deleteMany({ where: { tenantId: { in: tenants } } });
      await admin.modPayoutsWebhookEvent.deleteMany({
        where: { OR: [{ tenantId: { in: tenants } }, { stripeEventId: { contains: `${stamp}` } }] },
      });
      await admin.modPayoutsAccount.deleteMany({ where: { tenantId: { in: tenants } } });
      await admin.modSubscriptionsWebhookEvent.deleteMany({ where: { tenantId: { in: tenants } } });
      await admin.modBillingWebhookEvent.deleteMany({ where: { tenantId: { in: tenants } } });
      await admin.modBillingOrder.deleteMany({ where: { tenantId: { in: tenants } } });
      // audit_log es de solo inserción: sus filas y las aulas se quedan en la base desechable.
    }
    await closeModule?.();
    await admin?.$disconnect();
  });

  // ── utilidades ──

  let seq = 0;
  const evtId = (label: string) => `evt_plat_${label}_${stamp}_${++seq}`;

  function payload(type: string, object: Row, id: string, livemode = false) {
    return JSON.stringify({
      id,
      object: 'event',
      type,
      livemode,
      created: Math.floor(Date.now() / 1000),
      data: { object },
    });
  }

  function platformReq(secret: string, type: string, object: Row, id: string, livemode = false) {
    const body = payload(type, object, id, livemode);
    return {
      headers: { host: 'api.didacta.test', 'stripe-signature': signStripePayload(body, secret) },
      ip: '203.0.113.8',
      rawBody: Buffer.from(body, 'utf8'),
    } as never;
  }

  function legacyReq(host: string, secret: string, type: string, object: Row, id: string) {
    const body = payload(type, object, id);
    return {
      headers: {
        host,
        'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload: body, secret }),
        'user-agent': 'Stripe/1.0',
      },
      ip: '203.0.113.7',
      rawBody: Buffer.from(body, 'utf8'),
    } as never;
  }

  async function statusOf(run: () => Promise<unknown>): Promise<number> {
    try {
      await run();
      return 200;
    } catch (err) {
      if (err instanceof HttpException) return err.getStatus();
      if (err instanceof PayoutsError) return PAYOUTS_STATUS_BY_CODE[err.code] ?? 400;
      return 500;
    }
  }

  /** Orden PENDING cobrada por la plataforma + su cs_ registrado + lo que tiene Stripe. */
  async function platformOrder(tenantId: string, opts: { amount?: number } = {}) {
    const orderId = randomUUID();
    const tag = orderId.replace(/-/g, '');
    const sessionId = `cs_test_${tag}`;
    const piId = `pi_${tag}`;
    const chId = `ch_${tag}`;
    await admin.modBillingOrder.create({
      data: {
        id: orderId,
        tenantId,
        userId: null,
        productId: randomUUID(),
        courseId: randomUUID(),
        stripeSessionId: sessionId,
        currency: 'eur',
      },
    });
    await admin.modPayoutsObjectRef.create({
      data: {
        stripeObjectId: sessionId,
        tenantId,
        kind: 'checkout_session',
        source: 'billing',
        localRef: orderId,
      },
    });
    const amount = opts.amount ?? 4900;
    fake.seed(
      {
        id: chId,
        object: 'charge',
        amount,
        currency: 'eur',
        status: 'succeeded',
        paid: true,
        created: Math.floor(Date.now() / 1000),
        on_behalf_of: ACCT[tenantId],
        customer: `cus_${tag}`,
        balance_transaction: null,
      },
      { id: piId, object: 'payment_intent', latest_charge: chId, on_behalf_of: ACCT[tenantId] },
      {
        id: sessionId,
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'paid',
        livemode: false,
        customer: `cus_${tag}`,
        customer_details: { email: `alumna-${tag}@example.test` },
        payment_intent: piId,
        amount_total: amount,
        line_items: { object: 'list', data: [{ description: 'Curso de 49 €' }] },
      },
    );
    return { orderId, sessionId, piId, chId };
  }

  const session = (tenantId: string, orderId: string, sessionId: string, extra: Row = {}) => ({
    id: sessionId,
    object: 'checkout.session',
    mode: 'payment',
    payment_status: 'paid',
    status: 'complete',
    payment_intent: `pi_${orderId.replace(/-/g, '')}`,
    amount_total: 4900,
    client_reference_id: orderId,
    customer_details: { email: `alumna-${orderId.replace(/-/g, '')}@example.test` },
    metadata: { orderId, productId: randomUUID(), tenantId, courseId: randomUUID() },
    ...extra,
  });

  /** Todo lo que un evento podría tocar de las dos aulas, visto como superusuario. */
  async function snapshot() {
    const tenants = { in: [A, B] };
    return {
      orders: await admin.modBillingOrder.findMany({
        where: { tenantId: tenants },
        orderBy: { id: 'asc' },
      }),
      billingEvents: await admin.modBillingWebhookEvent.findMany({ where: { tenantId: tenants } }),
      subsEvents: await admin.modSubscriptionsWebhookEvent.findMany({
        where: { tenantId: tenants },
      }),
      refs: await admin.modPayoutsObjectRef.findMany({
        where: { tenantId: tenants },
        orderBy: { stripeObjectId: 'asc' },
      }),
      sales: await admin.modPayoutsSale.findMany({ where: { tenantId: tenants } }),
    };
  }

  // ══════════════════════════ los seis ataques ══════════════════════════

  it('(1) B firma en los HEREDADOS un completed de una orden de plataforma de A → 403 y base idéntica', async () => {
    const { orderId, sessionId } = await platformOrder(A);
    const antes = await snapshot();
    for (const controller of [billingController, subsController]) {
      const id = evtId('ataque1');
      expect(
        await statusOf(() =>
          controller.handle(
            legacyReq(
              'plat-b.test',
              STRIPE_OWN[B]!.webhookSecret,
              'checkout.session.completed',
              session(A, orderId, sessionId),
              id,
            ),
          ),
        ),
      ).toBe(403);
    }
    expect(await snapshot()).toEqual(antes);
    expect(published).toEqual([]);
  });

  it('(2) el mismo evento al webhook de PLATAFORMA con el secreto de B → 401, nada archivado', async () => {
    const { orderId, sessionId } = await platformOrder(A);
    const antes = await snapshot();
    const id = evtId('ataque2');
    expect(
      await statusOf(() =>
        platform.handle(
          platformReq(
            STRIPE_OWN[B]!.webhookSecret,
            'checkout.session.completed',
            session(A, orderId, sessionId),
            id,
          ),
        ),
      ),
    ).toBe(401);
    expect(await snapshot()).toEqual(antes);
    expect(await admin.modPayoutsWebhookEvent.count({ where: { stripeEventId: id } })).toBe(0);
  });

  it('(3) firma del operador, sesión registrada a A, metadata.tenantId de B → sin efectos, archivado con error', async () => {
    const { orderId, sessionId } = await platformOrder(A);
    const antes = await snapshot();
    const id = evtId('ataque3');
    const res = await platform.handle(
      platformReq(
        OPERATOR_SECRETS[0]!,
        'checkout.session.completed',
        session(B, orderId, sessionId),
        id,
      ),
    );
    expect(res).toEqual({ received: true, outcome: 'mismatch' });
    expect(await snapshot()).toEqual(antes);
    const archived = await admin.modPayoutsWebhookEvent.findUnique({
      where: { stripeEventId: id },
    });
    expect(archived).toMatchObject({ tenantId: null, objectId: sessionId });
    expect(archived?.errorMessage).toContain('payouts.ref_mismatch');
  });

  it('(4) firma del operador, sesión SIN registro que nombra una orden real de A → sin atribuir, orden PENDING', async () => {
    const { orderId } = await platformOrder(A);
    const antes = await snapshot();
    const id = evtId('ataque4');
    const res = await platform.handle(
      platformReq(
        OPERATOR_SECRETS[1]!,
        'checkout.session.completed',
        session(A, orderId, `cs_test_inventada_${stamp}`),
        id,
      ),
    );
    expect(res).toEqual({ received: true, outcome: 'unattributed' });
    expect(await snapshot()).toEqual(antes);
    expect((await admin.modBillingOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      'PENDING',
    );
    expect(
      await admin.modPayoutsWebhookEvent.findUnique({ where: { stripeEventId: id } }),
    ).toMatchObject({ tenantId: null, objectId: `cs_test_inventada_${stamp}` });
  });

  it('(5) B firma en los HEREDADOS sobre su PROPIA venta de plataforma (cs_ real o inventado) → 403, auditado en B', async () => {
    const { orderId, sessionId } = await platformOrder(B);
    const antes = await snapshot();
    const ids: string[] = [];
    for (const controller of [billingController, subsController]) {
      for (const object of [
        session(B, orderId, sessionId),
        session(B, orderId, `cs_test_falsa_${stamp}_${seq}`, { payment_intent: 'pi_falso' }),
      ]) {
        const id = evtId('ataque5');
        ids.push(id);
        expect(
          await statusOf(() =>
            controller.handle(
              legacyReq(
                'plat-b.test',
                STRIPE_OWN[B]!.webhookSecret,
                'checkout.session.completed',
                object,
                id,
              ),
            ),
          ),
        ).toBe(403);
      }
    }
    expect(await snapshot()).toEqual(antes);
    const audit = await admin.auditLog.findMany({
      where: { action: 'security.webhook.platform_object', resourceId: { in: ids } },
    });
    expect(audit.map((a) => a.tenantId)).toEqual([B, B, B, B]);
  });

  it('(6) control: el evento legítimo de A completa la orden, matricula y deja UNA venta AWAITING_FEE, aunque llegue 5 veces a la vez', async () => {
    const { orderId, sessionId, piId, chId } = await platformOrder(A, { amount: 4900 });
    const id = evtId('legitimo');
    const req = () =>
      platformReq(
        OPERATOR_SECRETS[0]!,
        'checkout.session.completed',
        // El evento dice otro importe: la venta lo lee de la API.
        session(A, orderId, sessionId, { amount_total: 1 }),
        id,
      );

    const first = await platform.handle(req());
    expect(first).toEqual({ received: true, outcome: 'processed', sale: 'created' });
    const rest = await Promise.all(Array.from({ length: 4 }, () => platform.handle(req())));
    expect(rest.every((r) => r.outcome === 'duplicate')).toBe(true);
    // Otro evento (otro id) de la misma sesión, en paralelo ×3: sigue habiendo una venta.
    const others = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        platform.handle(
          platformReq(
            OPERATOR_SECRETS[1]!,
            'checkout.session.async_payment_succeeded',
            session(A, orderId, sessionId),
            `${id}_otro_${i}`,
          ),
        ),
      ),
    );
    expect(others.every((r) => r.outcome === 'processed')).toBe(true);

    const order = await admin.modBillingOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('COMPLETED');
    expect(published.filter((p) => p.name === 'billing.order.completed')[0]).toEqual({
      tenantId: A,
      name: 'billing.order.completed',
    });
    const sales = await admin.modPayoutsSale.findMany({ where: { sourceRef: orderId } });
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({
      tenantId: A,
      accountId: ACCOUNT_ID[A],
      sourceKind: 'ORDER',
      stripeChargeId: chId,
      stripePaymentIntentId: piId,
      presentmentAmount: 4900,
      presentmentCurrency: 'eur',
      status: 'AWAITING_FEE',
      gross: null,
      stripeFee: null,
    });
    const refs = await admin.modPayoutsObjectRef.findMany({
      where: { localRef: orderId },
      orderBy: { stripeObjectId: 'asc' },
    });
    expect(refs.map((r) => [r.stripeObjectId, r.tenantId])).toEqual(
      [
        [chId, A],
        [`cus_${orderId.replace(/-/g, '')}`, A],
        [sessionId, A],
        [piId, A],
      ].sort((a, b) => a[0]!.localeCompare(b[0]!)),
    );
    expect(
      await admin.modPayoutsWebhookEvent.findUnique({ where: { stripeEventId: id } }),
    ).toMatchObject({ tenantId: A, errorMessage: null, processedAt: expect.any(Date) });
  });

  it('un evento posterior del cargo (charge.updated) se atribuye por los hijos registrados', async () => {
    const { orderId, sessionId, piId, chId } = await platformOrder(A);
    await platform.handle(
      platformReq(
        OPERATOR_SECRETS[0]!,
        'checkout.session.completed',
        session(A, orderId, sessionId),
        evtId('hijos'),
      ),
    );
    const id = evtId('cargo');
    const res = await platform.handle(
      platformReq(OPERATOR_SECRETS[0]!, 'charge.updated', { id: chId, payment_intent: piId }, id),
    );
    expect(res.outcome).toBe('processed');
    expect(
      await admin.modPayoutsWebhookEvent.findUnique({ where: { stripeEventId: id } }),
    ).toMatchObject({ tenantId: A, objectId: chId });
  });

  it('evento de modo prueba con la clave de producción → 400 sin tocar nada', async () => {
    const { orderId, sessionId } = await platformOrder(A);
    const live = new PlatformWebhookController(
      new PayoutsRuntime(
        { ...CONFIG, livemode: true },
        fake,
        prisma,
        new TenantStripeResolverService({ get: async () => undefined } as never, async () => false),
        logger as never,
      ),
      logger as never,
      { claims: async () => [], dispatch: async () => undefined },
    );
    const antes = await snapshot();
    const id = evtId('modo');
    expect(
      await statusOf(() =>
        live.handle(
          platformReq(
            OPERATOR_SECRETS[0]!,
            'checkout.session.completed',
            session(A, orderId, sessionId),
            id,
            false,
          ),
        ),
      ),
    ).toBe(400);
    expect(await snapshot()).toEqual(antes);
    expect(await admin.modPayoutsWebhookEvent.count({ where: { stripeEventId: id } })).toBe(0);
  });

  it('con RLS, el aula A no ve la venta ni los registros de B', async () => {
    const b = await platformOrder(B);
    await platform.handle(
      platformReq(
        OPERATOR_SECRETS[0]!,
        'checkout.session.completed',
        session(B, b.orderId, b.sessionId),
        evtId('rls'),
      ),
    );
    const { runAsTenant } = await import('../../src/tenancy/tenant-context.storage');
    const visto = await runAsTenant(A, () =>
      prisma.$transaction(async (tx) => ({
        sales: await tx.modPayoutsSale.count({ where: { sourceRef: b.orderId } }),
        refs: await tx.modPayoutsObjectRef.count({ where: { localRef: b.orderId } }),
      })),
    );
    expect(visto).toEqual({ sales: 0, refs: 0 });
    expect(await admin.modPayoutsSale.count({ where: { sourceRef: b.orderId } })).toBe(1);
  });
});
