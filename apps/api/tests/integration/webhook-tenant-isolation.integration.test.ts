/**
 * Aislamiento entre aulas de los webhooks de Stripe y de Zoom contra un
 * Postgres REAL, conectando como el runtime de producción: rol `didacta_app`
 * (NOSUPERUSER, NOBYPASSRLS) y RLS forzada.
 *
 * Los tests unitarios del ataque (`stripe-webhook-tenant-isolation.test.ts`,
 * `zoom-webhook.controller.test.ts`) usan una base en memoria SIN RLS a
 * propósito —el arreglo no puede depender de que la base filtre—, pero por eso
 * mismo no ven lo que solo pasa cuando la base SÍ filtra. Se les escaparon dos
 * fallos que este fichero cubre:
 *
 *  - El aviso de Zoom se archivaba sin `tenant_id`. Con RLS, y procesándose ya
 *    siempre en contexto de aula, la base rechazaba el INSERT: 500.
 *  - Dos aulas con la misma cuenta de Stripe y un endpoint cada una reciben
 *    las dos cada evento. La segunda entrega chocaba con la clave primaria
 *    (global), no veía la fila de la otra aula y reventaba al actualizarla:
 *    500 en bucle.
 *
 * Aquí los controladores, los servicios de los módulos, el resolutor de
 * credenciales, la auditoría, la extensión de RLS de Prisma y la firma son los
 * de verdad. Lo único simulado es de dónde salen las credenciales de cada aula
 * y a qué aula pertenece cada dominio.
 *
 * REQUISITOS: los de `rls-isolation-didacta-app.integration.test.ts`.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { BillingService } from '@didacta/mod-billing';
import { MembershipService, SubscriptionsService } from '@didacta/mod-subscriptions';
import { ZoomLiveService } from '@didacta/mod-zoom-live';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BillingErrorFilter } from '../../src/modules/billing/billing-error.filter';
import { BillingWebhookController } from '../../src/modules/billing/billing-webhook.controller';
import { PrismaAuditLogService } from '../../src/modules/prisma-audit-log.service';
import { SubscriptionsErrorFilter } from '../../src/modules/subscriptions/subscriptions-error.filter';
import { SubscriptionsWebhookController } from '../../src/modules/subscriptions/subscriptions-webhook.controller';
import { TenantStripeResolverService } from '../../src/modules/tenant-stripe-resolver.service';
import { ZoomWebhookController } from '../../src/modules/zoom-live/zoom-webhook.controller';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

type Row = Record<string, unknown>;

describeWithDb('Webhooks entre aulas — Postgres real como didacta_app (RLS forzada)', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;

  // A = víctima · B = atacante · E1/E2 = dos aulas con la MISMA cuenta de Stripe.
  const A = randomUUID();
  const B = randomUUID();
  const E1 = randomUUID();
  const E2 = randomUUID();
  const stamp = Date.now();
  const HOST: Record<string, string> = {
    'aula-a.test': A,
    'aula-b.test': B,
    'aula-e1.test': E1,
    'aula-e2.test': E2,
  };
  const STRIPE: Record<string, { secretKey: string; webhookSecret: string }> = {
    [A]: { secretKey: 'sk_test_cuenta-de-A', webhookSecret: 'whsec_de_A' },
    [B]: { secretKey: 'sk_test_cuenta-de-B', webhookSecret: 'whsec_de_B' },
    [E1]: { secretKey: 'sk_test_cuenta-compartida', webhookSecret: 'whsec_de_E1' },
    [E2]: { secretKey: 'sk_test_cuenta-compartida', webhookSecret: 'whsec_de_E2' },
  };
  const ZOOM_SECRET: Record<string, string> = {
    [A]: 'secreto-de-zoom-de-A',
    [B]: 'secreto-de-zoom-de-B',
  };

  const ids = {
    planA: randomUUID(),
    planB: randomUUID(),
    orderA: randomUUID(),
    orderB: randomUUID(),
    subA: randomUUID(),
    subE1: randomUUID(),
    zoomA: randomUUID(),
    zoomB: randomUUID(),
  };
  const MEETING_A = `81${stamp}`.slice(0, 11);
  const MEETING_B = `82${stamp}`.slice(0, 11);

  let billingController: BillingWebhookController;
  let subsController: SubscriptionsWebhookController;
  let zoomController: ZoomWebhookController;
  const published: Array<{ tenantId: string; name: string }> = [];
  const provisioned: Array<{ tenantId: string; email: string }> = [];
  const logger = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };

  beforeAll(async () => {
    const prepared = await prepareDidactaAppRole();
    admin = prepared.admin;

    // PrismaService lee DATABASE_URL al construirse: se le da la de didacta_app
    // solo durante el arranque del módulo y se restaura después.
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

    // ── datos ──
    for (const [id, slug] of [
      [A, 'a'],
      [B, 'b'],
      [E1, 'e1'],
      [E2, 'e2'],
    ] as const) {
      await admin.tenant.create({
        data: { id, slug: `wh-${slug}-${stamp}`, name: `Aula ${slug}` },
      });
    }
    for (const [id, tenantId] of [
      [ids.planA, A],
      [ids.planB, B],
    ] as const) {
      await admin.modSubscriptionsPlan.create({
        data: { id, tenantId, name: `Plan ${stamp}`, intervalMonths: 1, amountCents: 4900 },
      });
    }
    for (const [id, tenantId] of [
      [ids.orderA, A],
      [ids.orderB, B],
    ] as const) {
      await admin.modBillingOrder.create({
        data: {
          id,
          tenantId,
          userId: randomUUID(),
          productId: randomUUID(),
          courseId: randomUUID(),
          stripeSessionId: `cs_${id}`,
        },
      });
    }
    for (const [id, tenantId, stripeSubscriptionId] of [
      [ids.subA, A, `sub_de_A_${stamp}`],
      [ids.subE1, E1, `sub_de_E1_${stamp}`],
    ] as const) {
      await admin.modSubscriptionsSubscription.create({
        data: {
          id,
          tenantId,
          userId: randomUUID(),
          stripeSubscriptionId,
          stripeCustomerId: 'cus_x',
          stripePriceId: 'price_x',
          status: 'ACTIVE',
          unitAmount: 4900,
          interval: 'month',
        },
      });
    }
    for (const [id, tenantId, zoomMeetingId] of [
      [ids.zoomA, A, MEETING_A],
      [ids.zoomB, B, MEETING_B],
    ] as const) {
      await admin.modZoomSession.create({
        data: {
          id,
          tenantId,
          topic: 'Clase',
          startTime: new Date(),
          durationMinutes: 60,
          timezone: 'UTC',
          hostEmail: 'h@example.test',
          zoomMeetingId,
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
      throw new Error('el webhook no debe llamar a la API de Stripe');
    };
    const urls = { successUrl: () => 'https://x/ok', cancelUrl: () => 'https://x/ko' };
    const billing = new BillingService(prisma as never, noStripe as never, publisher, urls);
    const subs = new SubscriptionsService(prisma as never, noStripe as never, publisher, urls);
    const membership = new MembershipService(prisma as never, noStripe as never, publisher);
    const zoomCtx = {
      config: {
        get: async (tenantId: string, scope: string, key: string) =>
          scope === 'zoom-live' && key === 'credentials' && ZOOM_SECRET[tenantId]
            ? { webhookSecret: ZOOM_SECRET[tenantId] }
            : undefined,
      },
      eventBus: {
        publish: async (e: { name: string; metadata: { tenantId: string } }) => {
          published.push({ tenantId: e.metadata.tenantId, name: e.name });
        },
        subscribe: () => undefined,
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    const zoomLive = new ZoomLiveService(prisma as never, zoomCtx as never);
    const registry = {
      getBillingService: () => billing,
      getSubscriptionsService: () => subs,
      getMembershipService: () => membership,
      getZoomLiveService: () => zoomLive,
    };
    const stripeResolver = new TenantStripeResolverService(
      {
        get: async (tenantId: string, scope: string, key: string) =>
          scope === 'billing' && key === 'stripe' ? STRIPE[tenantId] : undefined,
      } as never,
      async () => false,
    );
    const tenantResolver = {
      resolveByHost: async (host: string | undefined) => {
        const id = host ? HOST[host] : undefined;
        return id ? { id, slug: host, name: host, matchedBy: 'hostname', hostname: host } : null;
      },
      resolveTenantWebBaseUrl: async () => 'https://aula.test',
    };
    const provisioning = {
      provision: async (args: { tenantId: string; email: string }) => {
        provisioned.push({ tenantId: args.tenantId, email: args.email });
        return { userId: randomUUID(), created: true };
      },
    };
    const auditLog = new PrismaAuditLogService(prisma);

    billingController = new BillingWebhookController(
      registry as never,
      provisioning as never,
      tenantResolver as never,
      stripeResolver,
      auditLog,
      logger as never,
    );
    subsController = new SubscriptionsWebhookController(
      registry as never,
      provisioning as never,
      provisioning as never,
      logger as never,
      tenantResolver as never,
      stripeResolver,
      auditLog,
    );
    zoomController = new ZoomWebhookController(
      registry as never,
      tenantResolver as never,
      auditLog,
      logger as never,
    );
  }, 90_000);

  afterAll(async () => {
    const tenants = [A, B, E1, E2];
    if (admin) {
      await admin.modZoomWebhookEvent.deleteMany({ where: { tenantId: { in: tenants } } });
      await admin.modZoomSession.deleteMany({ where: { tenantId: { in: tenants } } });
      await admin.modSubscriptionsWebhookEvent.deleteMany({ where: { tenantId: { in: tenants } } });
      await admin.modBillingWebhookEvent.deleteMany({ where: { tenantId: { in: tenants } } });
      await admin.modSubscriptionsSubscription.deleteMany({ where: { tenantId: { in: tenants } } });
      await admin.modSubscriptionsPlan.deleteMany({ where: { tenantId: { in: tenants } } });
      await admin.modBillingOrder.deleteMany({ where: { tenantId: { in: tenants } } });
      // audit_log es de solo inserción (trigger): sus filas y las aulas que
      // referencian se quedan en la base desechable.
    }
    await closeModule?.();
    await admin?.$disconnect();
  });

  // ── utilidades ──

  let seq = 0;
  function stripeReq(host: string, secret: string, type: string, object: Row, id?: string) {
    const payload = JSON.stringify({
      id: id ?? `evt_int_${stamp}_${++seq}`,
      object: 'event',
      type,
      created: Math.floor(Date.now() / 1000),
      data: { object },
    });
    return {
      headers: {
        host,
        'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret }),
        'user-agent': 'Stripe/1.0',
      },
      ip: '203.0.113.7',
      rawBody: Buffer.from(payload, 'utf8'),
    } as never;
  }

  function zoomReq(host: string, secret: string, body: Row) {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const digest = createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
    return {
      headers: { host, 'x-zm-signature': `v0=${digest}`, 'x-zm-request-timestamp': ts },
      ip: '203.0.113.7',
      rawBody: Buffer.from(raw, 'utf8'),
    } as never;
  }

  /** Código HTTP que vería quien llama, pasando por los filtros reales. */
  async function statusOf(run: () => Promise<unknown>): Promise<number> {
    try {
      await run();
      return 200;
    } catch (err) {
      if (err instanceof HttpException) return err.getStatus();
      const code = (err as { code?: string }).code ?? '';
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
      if (code.startsWith('BILLING_')) new BillingErrorFilter().catch(err as never, host);
      else if (code.startsWith('SUBSCRIPTIONS_') || code.startsWith('MEMBERSHIP_'))
        new SubscriptionsErrorFilter().catch(err as never, host);
      // Cualquier otra cosa (p. ej. un error de Prisma) es un 500 de verdad.
      else return 500;
      return status;
    }
  }

  const membershipSession = (tenantId: string, planId: string, sub: string): Row => ({
    id: `cs_memb_${++seq}`,
    object: 'checkout.session',
    payment_status: 'paid',
    status: 'complete',
    subscription: sub,
    customer: 'cus_comprador',
    customer_details: { email: `comprador-${stamp}-${seq}@example.test`, name: 'Comprador' },
    metadata: { membership: '1', tenantId, planId },
  });
  const courseSession = (tenantId: string, orderId: string): Row => ({
    id: `cs_curso_${++seq}`,
    object: 'checkout.session',
    payment_status: 'paid',
    status: 'complete',
    payment_intent: `pi_${orderId}`,
    amount_total: 9900,
    customer_details: { email: 'comprador@example.test', name: 'Comprador' },
    metadata: { orderId, productId: randomUUID(), tenantId, courseId: randomUUID() },
  });

  const eventRows = async (id: string) => ({
    subs: await admin.modSubscriptionsWebhookEvent.findMany({ where: { stripeEventId: id } }),
    billing: await admin.modBillingWebhookEvent.findMany({ where: { stripeEventId: id } }),
  });

  // ══════════════════════════ STRIPE ══════════════════════════

  describe('Stripe', () => {
    it('ATAQUE membresía: firmado por B, nombra a A, al dominio de B → 403 y nada escrito en ninguna aula', async () => {
      const id = `evt_ataque_memb_${stamp}`;
      const status = await statusOf(() =>
        subsController.handle(
          stripeReq(
            'aula-b.test',
            STRIPE[B]!.webhookSecret,
            'checkout.session.completed',
            membershipSession(A, ids.planA, `sub_ataque_${stamp}`),
            id,
          ),
        ),
      );

      expect(status).toBe(403);
      expect(
        await admin.modSubscriptionsSubscription.count({
          where: { stripeSubscriptionId: `sub_ataque_${stamp}` },
        }),
      ).toBe(0);
      expect(await eventRows(id)).toEqual({ subs: [], billing: [] });
      expect(provisioned).toEqual([]);
      expect(published).toEqual([]);
      // El rastro queda en la auditoría del aula que firmó, escrito bajo RLS.
      const audit = await admin.auditLog.findMany({
        where: { action: 'security.webhook.tenant_mismatch', resourceId: id },
      });
      expect(audit.map((a) => a.tenantId)).toEqual([B]);
    });

    it('ATAQUE curso: firmado por B con una orden de A → 403 y la orden sigue PENDING', async () => {
      const id = `evt_ataque_curso_${stamp}`;
      const status = await statusOf(() =>
        billingController.handle(
          stripeReq(
            'aula-b.test',
            STRIPE[B]!.webhookSecret,
            'checkout.session.completed',
            courseSession(A, ids.orderA),
            id,
          ),
        ),
      );

      expect(status).toBe(403);
      expect(
        (await admin.modBillingOrder.findUniqueOrThrow({ where: { id: ids.orderA } })).status,
      ).toBe('PENDING');
      expect(await eventRows(id)).toEqual({ subs: [], billing: [] });
      expect(published).toEqual([]);
    });

    it('ATAQUE por id: baja de una suscripción de A firmada por B → 403 y sigue ACTIVE', async () => {
      const status = await statusOf(() =>
        subsController.handle(
          stripeReq('aula-b.test', STRIPE[B]!.webhookSecret, 'customer.subscription.deleted', {
            id: `sub_de_A_${stamp}`,
            object: 'subscription',
            status: 'canceled',
          }),
        ),
      );

      expect(status).toBe(403);
      expect(
        (await admin.modSubscriptionsSubscription.findUniqueOrThrow({ where: { id: ids.subA } }))
          .status,
      ).toBe('ACTIVE');
    });

    it('CONTROL membresía: evento de B para B → 200, membresía ACTIVE en B y archivo a nombre de B', async () => {
      const id = `evt_control_memb_${stamp}`;
      const sub = `sub_control_${stamp}`;
      const req = () =>
        stripeReq(
          'aula-b.test',
          STRIPE[B]!.webhookSecret,
          'checkout.session.completed',
          membershipSession(B, ids.planB, sub),
          id,
        );

      expect(await statusOf(() => subsController.handle(req()))).toBe(200);
      // Reentrega del mismo evento.
      expect(await statusOf(() => subsController.handle(req()))).toBe(200);

      const rows = await admin.modSubscriptionsSubscription.findMany({
        where: { stripeSubscriptionId: sub },
      });
      expect(rows.map((r) => [r.tenantId, r.status, r.planId])).toEqual([[B, 'ACTIVE', ids.planB]]);
      const archived = await eventRows(id);
      expect(archived.subs.map((e) => [e.tenantId, e.processedAt !== null])).toEqual([[B, true]]);
      expect(archived.billing.map((e) => [e.tenantId, e.processedAt !== null])).toEqual([
        [B, true],
      ]);
      expect(provisioned.filter((p) => p.tenantId === B)).toHaveLength(1);
      expect(published.filter((e) => e.name === 'subscriptions.membership.activated')).toEqual([
        { tenantId: B, name: 'subscriptions.membership.activated' },
      ]);
    });

    it('CONTROL curso: evento de B para B → 200 y la orden COMPLETED', async () => {
      const status = await statusOf(() =>
        billingController.handle(
          stripeReq(
            'aula-b.test',
            STRIPE[B]!.webhookSecret,
            'checkout.session.completed',
            courseSession(B, ids.orderB),
          ),
        ),
      );

      expect(status).toBe(200);
      expect(
        (await admin.modBillingOrder.findUniqueOrThrow({ where: { id: ids.orderB } })).status,
      ).toBe('COMPLETED');
    });

    it('firma inválida → 401', async () => {
      const req = stripeReq('aula-b.test', 'otro-secreto', 'checkout.session.completed', {
        id: 'cs_x',
        object: 'checkout.session',
      });
      expect(await statusOf(() => subsController.handle(req))).toBe(401);
      expect(await statusOf(() => billingController.handle(req))).toBe(401);
    });

    describe('dos aulas con la misma cuenta de Stripe y un endpoint cada una', () => {
      it('un evento sin dueño llega a los DOS endpoints → 200 las dos veces, y una sola fila de archivo', async () => {
        const id = `evt_compartido_${stamp}`;
        const object = { id: 'pm_1', object: 'payment_method' };

        const primera = await statusOf(() =>
          subsController.handle(
            stripeReq(
              'aula-e1.test',
              STRIPE[E1]!.webhookSecret,
              'payment_method.attached',
              object,
              id,
            ),
          ),
        );
        // La segunda choca con la clave primaria de una fila que E2 no ve.
        const segunda = await statusOf(() =>
          subsController.handle(
            stripeReq(
              'aula-e2.test',
              STRIPE[E2]!.webhookSecret,
              'payment_method.attached',
              object,
              id,
            ),
          ),
        );
        // Y Stripe reintenta: tampoco entonces.
        const reintento = await statusOf(() =>
          subsController.handle(
            stripeReq(
              'aula-e2.test',
              STRIPE[E2]!.webhookSecret,
              'payment_method.attached',
              object,
              id,
            ),
          ),
        );

        expect([primera, segunda, reintento]).toEqual([200, 200, 200]);
        const archived = await eventRows(id);
        expect(archived.subs.map((e) => e.tenantId)).toEqual([E1]);
        expect(archived.billing.map((e) => e.tenantId)).toEqual([E1]);
      });

      it('lo mismo por el endpoint de billing', async () => {
        const id = `evt_compartido_billing_${stamp}`;
        const object = { id: 'pm_2', object: 'payment_method' };
        const a = await statusOf(() =>
          billingController.handle(
            stripeReq(
              'aula-e2.test',
              STRIPE[E2]!.webhookSecret,
              'payment_method.attached',
              object,
              id,
            ),
          ),
        );
        const b = await statusOf(() =>
          billingController.handle(
            stripeReq(
              'aula-e1.test',
              STRIPE[E1]!.webhookSecret,
              'payment_method.attached',
              object,
              id,
            ),
          ),
        );
        expect([a, b]).toEqual([200, 200]);
        expect((await eventRows(id)).billing.map((e) => e.tenantId)).toEqual([E2]);
      });

      it('un evento de E1 que llega primero al endpoint de E2 se procesa para E1, una sola vez', async () => {
        const id = `evt_de_e1_${stamp}`;
        const object = { id: `sub_de_E1_${stamp}`, object: 'subscription', status: 'canceled' };

        const porE2 = await statusOf(() =>
          subsController.handle(
            stripeReq(
              'aula-e2.test',
              STRIPE[E2]!.webhookSecret,
              'customer.subscription.deleted',
              object,
              id,
            ),
          ),
        );
        const porE1 = await statusOf(() =>
          subsController.handle(
            stripeReq(
              'aula-e1.test',
              STRIPE[E1]!.webhookSecret,
              'customer.subscription.deleted',
              object,
              id,
            ),
          ),
        );

        expect([porE2, porE1]).toEqual([200, 200]);
        expect(
          (await admin.modSubscriptionsSubscription.findUniqueOrThrow({ where: { id: ids.subE1 } }))
            .status,
        ).toBe('CANCELED');
        expect((await eventRows(id)).subs.map((e) => e.tenantId)).toEqual([E1]);
        expect(published.filter((e) => e.name === 'subscriptions.subscription.canceled')).toEqual([
          { tenantId: E1, name: 'subscriptions.subscription.canceled' },
        ]);
      });
    });
  });

  // ══════════════════════════ ZOOM ══════════════════════════

  describe('Zoom', () => {
    const started = (meetingId: string, eventTs: number) => ({
      event: 'meeting.started',
      event_ts: eventTs,
      payload: { account_id: 'acc', object: { id: meetingId, uuid: 'uuid==' } },
    });

    it('aviso de una reunión CONOCIDA del aula → 200, la clase pasa a STARTED y el aviso se archiva a su nombre', async () => {
      const body = started(MEETING_B, stamp + 1);
      const res = await zoomController.handle(zoomReq('aula-b.test', ZOOM_SECRET[B]!, body));

      expect(res).toEqual({ result: 'OK', sessionId: ids.zoomB });
      expect(
        (await admin.modZoomSession.findUniqueOrThrow({ where: { id: ids.zoomB } })).status,
      ).toBe('STARTED');
      const events = await admin.modZoomWebhookEvent.findMany({ where: { meetingId: MEETING_B } });
      expect(events.map((e) => [e.tenantId, e.sessionId, e.result])).toEqual([
        [B, ids.zoomB, 'OK'],
      ]);

      // Reentrega: duplicado, sin 500.
      expect(await zoomController.handle(zoomReq('aula-b.test', ZOOM_SECRET[B]!, body))).toEqual({
        result: 'DUPLICATE',
      });
    });

    it('aviso de una reunión DESCONOCIDA → 200 IGNORED, archivado en el aula del dominio (era un 500 con RLS)', async () => {
      const desconocida = `99${stamp}`.slice(0, 11);
      const res = await zoomController.handle(
        zoomReq('aula-b.test', ZOOM_SECRET[B]!, started(desconocida, stamp + 2)),
      );

      expect(res).toEqual({ result: 'IGNORED' });
      const events = await admin.modZoomWebhookEvent.findMany({
        where: { meetingId: desconocida },
      });
      expect(events.map((e) => [e.tenantId, e.sessionId, e.result])).toEqual([
        [B, null, 'IGNORED'],
      ]);
    });

    it('ATAQUE: aviso firmado por B con la reunión de una clase de A → 403, la clase no cambia y no se archiva nada', async () => {
      const status = await statusOf(() =>
        zoomController.handle(
          zoomReq('aula-b.test', ZOOM_SECRET[B]!, started(MEETING_A, stamp + 3)),
        ),
      );

      expect(status).toBe(403);
      expect(
        (await admin.modZoomSession.findUniqueOrThrow({ where: { id: ids.zoomA } })).status,
      ).toBe('SCHEDULED');
      expect(await admin.modZoomWebhookEvent.count({ where: { meetingId: MEETING_A } })).toBe(0);
      const audit = await admin.auditLog.findMany({
        where: {
          action: 'security.webhook.tenant_mismatch',
          resourceType: 'zoom_webhook',
          tenantId: B,
        },
      });
      expect(audit.length).toBeGreaterThanOrEqual(1);
    });

    it('firma inválida → 401', async () => {
      const status = await statusOf(() =>
        zoomController.handle(
          zoomReq('aula-b.test', 'otro-secreto', started(MEETING_B, stamp + 4)),
        ),
      );
      expect(status).toBe(401);
    });
  });
});
