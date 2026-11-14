/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Oferta al darse de baja contra Postgres REAL conectando como `didacta_app`
 * (NOSUPERUSER, NOBYPASSRLS), como el runtime de producción:
 *
 * - El valor nuevo `PAUSED` del enum, las columnas de la pausa y las dos
 *   tablas nuevas funcionan con la RLS forzada.
 * - Descuento una vez por persona con cinco clics A LA VEZ: el único
 *   (tenant_id, discounted_user_id) deja una fila y un solo cupón.
 * - Aislamiento entre aulas: el aula B no ve ni la configuración, ni las
 *   salidas, ni las suscripciones del aula A; el barrido de pausas de A
 *   ejecutado con el contexto de B no toca nada.
 * - El webhook de la renovación pone la suscripción PAUSED y el cobro tras la
 *   pausa la devuelve a ACTIVE.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import {
  RetentionAlreadyUsedError,
  RetentionService,
  SubscriptionNotFoundError,
  SubscriptionsService,
  type StripeSubscriptionDetails,
  type SubscriptionsStripeAdapter,
} from '@didacta/mod-subscriptions';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runAsTenant, runSanctionedGlobalAccess } from '../../src/tenancy/tenant-context.storage';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

const DAY = 86_400;

describeWithDb('Oferta al darse de baja — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let retention: RetentionService;
  let subscriptions: SubscriptionsService;
  const events: Array<{ tenantId: string; name: string }> = [];
  const stripeCalls: string[] = [];
  const now = Math.floor(Date.now() / 1000);
  const periodEnd = now + 20 * DAY;
  const stamp = Date.now();
  const ids = {
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    userA1: '',
    userA2: '',
    userB: '',
    subA1: '',
    subA2: '',
    subB: '',
  };

  const details = (id: string): StripeSubscriptionDetails => ({
    id,
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodStart: now - 10 * DAY,
    currentPeriodEnd: periodEnd,
    intervalMonths: 1,
    pauseCollection: null,
    hasDiscount: false,
  });

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

    for (const [key, slug] of [
      ['tenantA', 'a'],
      ['tenantB', 'b'],
    ] as const) {
      await admin.tenant.create({
        data: { id: ids[key], slug: `baja-${slug}-${stamp}`, name: `baja-${slug}-${stamp}` },
      });
    }
    const user = async (tenantId: string, name: string) =>
      (
        await admin.user.create({
          data: { tenantId, email: `${name}-${stamp}@example.com`, name, status: 'ACTIVE' },
        })
      ).id;
    ids.userA1 = await user(ids.tenantA, 'lucia');
    ids.userA2 = await user(ids.tenantA, 'marcos');
    ids.userB = await user(ids.tenantB, 'elena');
    const sub = async (tenantId: string, userId: string, n: string) =>
      (
        await admin.modSubscriptionsSubscription.create({
          data: {
            tenantId,
            userId,
            planId: randomUUID(),
            stripeSubscriptionId: `sub_int_${stamp}_${n}`,
            stripeCustomerId: `cus_int_${stamp}_${n}`,
            stripePriceId: 'price_int',
            status: 'ACTIVE',
            unitAmount: 2900,
            currency: 'eur',
            interval: 'month',
            currentPeriodEnd: new Date(periodEnd * 1000),
          },
        })
      ).id;
    ids.subA1 = await sub(ids.tenantA, ids.userA1, 'a1');
    ids.subA2 = await sub(ids.tenantA, ids.userA2, 'a2');
    ids.subB = await sub(ids.tenantB, ids.userB, 'b');

    const adapter = {
      retrieveSubscription: async (id: string) => {
        stripeCalls.push(`retrieve:${id}`);
        return details(id);
      },
      pauseCollection: async (p: { subscriptionId: string }) => {
        stripeCalls.push(`pause:${p.subscriptionId}`);
        return details(p.subscriptionId);
      },
      applyRetentionDiscount: async (p: { subscriptionId: string }) => {
        stripeCalls.push(`discount:${p.subscriptionId}`);
        // Stripe tarda: así los cinco clics llegan a la vez a la base.
        await new Promise((r) => setTimeout(r, 30));
        return { couponId: `coupon_${stamp}`, discountEnd: periodEnd + 90 * DAY };
      },
      cancelSubscription: async (id: string) => ({
        id,
        status: 'active',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: periodEnd,
        canceledAt: null,
      }),
    } as unknown as SubscriptionsStripeAdapter;
    const publisher = {
      publish: async (tenantId: string, _a: string | null, name: string) => {
        events.push({ tenantId, name });
      },
    };
    subscriptions = new SubscriptionsService(prisma as never, async () => adapter, publisher, {
      successUrl: () => 'x',
      cancelUrl: () => 'x',
    });
    retention = new RetentionService(
      prisma as never,
      async () => adapter,
      publisher,
      (tenantId, userId, subscriptionId) =>
        subscriptions.cancelSubscription(tenantId, userId, subscriptionId),
    );
    await runAsTenant(ids.tenantA, () =>
      retention.updateConfig(ids.tenantA, {
        pauseEnabled: true,
        pauseMaxMonths: 3,
        discountEnabled: true,
        discountPercent: 30,
        discountMonths: 3,
      }),
    );
  });

  afterAll(async () => {
    await closeModule?.();
    await admin?.$disconnect();
  });

  it('la configuración de A no la ve B (B sigue con todo apagado)', async () => {
    const a = await runAsTenant(ids.tenantA, () => retention.getConfig(ids.tenantA));
    expect(a).toMatchObject({ pauseEnabled: true, discountPercent: 30 });
    // Con el contexto de B, leer la fila de A no devuelve nada.
    const asB = await runAsTenant(ids.tenantB, () => retention.getConfig(ids.tenantA));
    expect(asB).toMatchObject({ pauseEnabled: false, discountEnabled: false });
  });

  it('cinco clics a la vez en el descuento: una fila y un cupón; el resto «ya usado»', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        runAsTenant(ids.tenantA, () =>
          retention.leave(ids.tenantA, ids.userA2, ids.subA2, {
            reason: 'too_expensive',
            choice: 'discount',
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(RetentionAlreadyUsedError);
    }
    const rows = await admin.modSubscriptionsExit.findMany({
      where: { tenantId: ids.tenantA, outcome: 'DISCOUNTED' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      discountedUserId: ids.userA2,
      stripeCouponId: `coupon_${stamp}`,
      discountPercent: 30,
    });
    expect(stripeCalls.filter((c) => c.startsWith('discount:'))).toHaveLength(1);
  });

  it('pausa: ventana en la fila; B no ve ni la salida ni la suscripción de A', async () => {
    const r = await runAsTenant(ids.tenantA, () =>
      retention.leave(ids.tenantA, ids.userA1, ids.subA1, {
        reason: 'no_time',
        choice: 'pause',
        pauseMonths: 2,
      }),
    );
    expect(r.outcome).toBe('PAUSED');
    expect(r.subscription.pauseStartsAt?.getTime()).toBe(periodEnd * 1000);
    const fromB = await runAsTenant(ids.tenantB, () => retention.summary(ids.tenantA));
    expect(fromB.total).toBe(0);
    await expect(
      runAsTenant(ids.tenantB, () => retention.getOffer(ids.tenantA, ids.userA1, ids.subA1)),
    ).rejects.toBeInstanceOf(SubscriptionNotFoundError);
    const fromA = await runAsTenant(ids.tenantA, () => retention.summary(ids.tenantA));
    expect(fromA).toMatchObject({ total: 2, stayed: 2, paused: 0 + 1, discounted: 1 });
  });

  it('barrido: encuentra A (acceso sancionado); con el contexto de B no toca la de A', async () => {
    const later = new Date((periodEnd + DAY) * 1000);
    const tenants = await runSanctionedGlobalAccess(() =>
      retention.findTenantsWithDuePauses(later),
    );
    expect(tenants).toContain(ids.tenantA);
    expect(tenants).not.toContain(ids.tenantB);
    const wrong = await runAsTenant(ids.tenantB, () =>
      retention.startDuePausesForTenant(ids.tenantA, later),
    );
    expect(wrong).toHaveLength(0);
    const right = await runAsTenant(ids.tenantA, () =>
      retention.startDuePausesForTenant(ids.tenantA, later),
    );
    expect(right.map((s) => s.id)).toEqual([ids.subA1]);
    const row = await admin.modSubscriptionsSubscription.findUnique({ where: { id: ids.subA1 } });
    expect(row?.status).toBe('PAUSED');
    expect(events.filter((e) => e.name === 'subscriptions.subscription.paused')).toEqual([
      { tenantId: ids.tenantA, name: 'subscriptions.subscription.paused' },
    ]);
  });

  it('el cobro tras la pausa (webhook) la devuelve a ACTIVE y limpia la ventana', async () => {
    const pauseEnds = (await admin.modSubscriptionsSubscription.findUnique({
      where: { id: ids.subA1 },
    }))!.pauseEndsAt!;
    await runAsTenant(ids.tenantA, () =>
      subscriptions.handleWebhookEvent(
        {
          id: `evt_int_${stamp}_paid`,
          type: 'invoice.paid',
          data: {
            object: {
              id: `in_int_${stamp}_vuelta`,
              subscription: `sub_int_${stamp}_a1`,
              amount_paid: 2900,
              amount_due: 2900,
              currency: 'eur',
              created: Math.floor(pauseEnds.getTime() / 1000),
              billing_reason: 'subscription_cycle',
              period_start: periodEnd,
              period_end: Math.floor(pauseEnds.getTime() / 1000),
            },
          },
        } as unknown as Stripe.Event,
        {},
        { tenantId: ids.tenantA },
      ),
    );
    const row = await admin.modSubscriptionsSubscription.findUnique({ where: { id: ids.subA1 } });
    expect(row).toMatchObject({ status: 'ACTIVE', pauseStartsAt: null, pauseEndsAt: null });
  });

  it('la baja con motivo en B no se mezcla con A', async () => {
    const r = await runAsTenant(ids.tenantB, () =>
      retention.leave(ids.tenantB, ids.userB, ids.subB, {
        reason: 'missing_topics',
        reasonText: 'Falta latte art',
        choice: 'cancel',
      }),
    );
    expect(r.outcome).toBe('CANCELED');
    expect(r.exit).toMatchObject({ offeredPause: false, offeredDiscount: false });
    const b = await runAsTenant(ids.tenantB, () => retention.summary(ids.tenantB));
    expect(b).toMatchObject({ total: 1, canceled: 1 });
    expect(b.recent[0]).toMatchObject({ reasonText: 'Falta latte art', userName: 'elena' });
    const a = await runAsTenant(ids.tenantA, () => retention.summary(ids.tenantA));
    expect(a.canceled).toBe(0);
  });
});
