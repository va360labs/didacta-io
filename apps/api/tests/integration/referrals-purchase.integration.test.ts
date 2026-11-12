/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Referidos para todo, contra Postgres REAL conectando como `didacta_app`
 * (NOSUPERUSER, NOBYPASSRLS): una compra de un curso suelto con el enlace de
 * un alumno recorre la cadena entera —checkout de mod.billing con el código
 * en la metadata → webhook → `billing.order.completed` con `attribution` →
 * puente del host → comisión PENDING en mod.referrals— y el reembolso la
 * anula. La comisión del aula A nunca aparece en el aula B, y el código de un
 * alumno de A no vale en B.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type Stripe from 'stripe';
import { PrismaClient } from '@didacta/database';
import type { DomainEvent } from '@didacta/core-kernel';
import { BillingService } from '@didacta/mod-billing';
import { ReferralsService } from '@didacta/mod-referrals';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  ReferralsBillingBridge,
  type BillingOrderCompletedPayload,
  type BillingOrderRefundedPayload,
} from '../../src/modules/referrals/referrals-billing.bridge';
import { runAsTenant } from '../../src/tenancy/tenant-context.storage';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

interface Published {
  tenantId: string;
  name: string;
  payload: Record<string, unknown>;
}

describeWithDb('Referidos en compras sueltas — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let billing: BillingService;
  let referrals: ReferralsService;
  let bridge: ReferralsBillingBridge;
  const billingEvents: Published[] = [];
  const stamp = Date.now();
  const ids = {
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    referrerA: '',
    buyerA: '',
    referrerB: '',
    buyerB: '',
    courseA: randomUUID(),
    courseB: randomUUID(),
  };
  let sessionSeq = 0;

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
        data: { id: ids[key], slug: `refs-${slug}-${stamp}`, name: `refs-${slug}-${stamp}` },
      });
    }
    const user = async (tenantId: string, name: string) =>
      (
        await admin.user.create({
          data: { tenantId, email: `${name}-${stamp}@example.test`, status: 'ACTIVE' },
        })
      ).id;
    ids.referrerA = await user(ids.tenantA, 'referrer-a');
    ids.buyerA = await user(ids.tenantA, 'buyer-a');
    ids.referrerB = await user(ids.tenantB, 'referrer-b');
    ids.buyerB = await user(ids.tenantB, 'buyer-b');

    // Programa activo en las dos aulas, con el % por defecto (30 %).
    await admin.modReferralsConfig.createMany({
      data: [
        { tenantId: ids.tenantA, active: true, guaranteeDays: 14 },
        { tenantId: ids.tenantB, active: true, guaranteeDays: 14 },
      ],
    });
    // Un curso a la venta en cada aula (el producto es de mod.billing).
    await admin.modBillingProduct.createMany({
      data: [
        {
          tenantId: ids.tenantA,
          courseId: ids.courseA,
          stripeProductId: 'prod_a',
          stripePriceId: 'price_a',
          unitAmount: 4900,
          currency: 'eur',
        },
        {
          tenantId: ids.tenantB,
          courseId: ids.courseB,
          stripeProductId: 'prod_b',
          stripePriceId: 'price_b',
          unitAmount: 9900,
          currency: 'eur',
        },
      ],
    });

    // Doble de Stripe: solo crea sesiones (el cobro lo simula el webhook).
    const fakeStripe = {
      createCheckoutSession: async () => {
        sessionSeq += 1;
        return { id: `cs_ref_${stamp}_${sessionSeq}`, url: 'https://checkout.stripe.test/x' };
      },
    };
    billing = new BillingService(
      prisma as never,
      (async () => fakeStripe) as never,
      {
        publish: async (tenantId: string, _actor: string | null, name: string, payload: object) => {
          billingEvents.push({ tenantId, name, payload: payload as Record<string, unknown> });
        },
      } as never,
      { successUrl: () => '', cancelUrl: () => '' } as never,
    );
    referrals = new ReferralsService(
      prisma as never,
      { publish: async () => undefined },
      // Lookup de emails como el del host (lectura del `user` del aula).
      async (tenantId: string, userId: string) =>
        (await prisma.user.findFirst({ where: { id: userId, tenantId }, select: { email: true } }))
          ?.email ?? null,
    );
    const logger = { log: () => undefined, warn: () => undefined, error: () => undefined };
    bridge = new ReferralsBillingBridge(
      { getReferralsService: () => referrals } as never,
      { getEventBus: () => ({ subscribe: () => undefined }) } as never,
      logger as never,
    );
  });

  afterAll(async () => {
    for (const tenantId of [ids.tenantA, ids.tenantB]) {
      await admin.modReferralsCommission.deleteMany({ where: { tenantId } });
      await admin.modReferralsReferral.deleteMany({ where: { tenantId } });
      await admin.modReferralsCode.deleteMany({ where: { tenantId } });
      await admin.modReferralsConfig.deleteMany({ where: { tenantId } });
      await admin.modBillingWebhookEvent.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await admin.modBillingOrder.deleteMany({ where: { tenantId } });
      await admin.modBillingProduct.deleteMany({ where: { tenantId } });
      await admin.user.deleteMany({ where: { tenantId } });
      await admin.tenant.delete({ where: { id: tenantId } });
    }
    await closeModule?.();
    await admin?.$disconnect();
  });

  /** Compra completa de un curso en un aula: checkout + webhook pagado. */
  async function buy(
    tenantId: string,
    buyerId: string,
    courseId: string,
    referralCode: string | undefined,
  ): Promise<{ orderId: string; completed: Published }> {
    return runAsTenant(tenantId, async () => {
      const checkout = await billing.startCheckout({
        tenantId,
        userId: buyerId,
        userEmail: 'x@example.test',
        courseId,
        ...(referralCode ? { referralCode } : {}),
      });
      const order = await prisma.modBillingOrder.findFirstOrThrow({
        where: { id: checkout.orderId },
      });
      const event = {
        id: `evt_${checkout.orderId}`,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: checkout.sessionId,
            metadata: {
              orderId: checkout.orderId,
              tenantId,
              courseId,
              productId: order.productId,
              userId: buyerId,
              ...(referralCode ? { referralCode } : {}),
            },
            amount_total: courseId === ids.courseA ? 4900 : 9900,
            customer_details: { email: 'x@example.test' },
            payment_intent: `pi_${checkout.orderId}`,
            payment_status: 'paid',
            status: 'complete',
          },
        },
      } as unknown as Stripe.Event;
      await billing.handleWebhookEvent(event, {}, { tenantId });
      const completed = billingEvents.find(
        (e) => e.name === 'billing.order.completed' && e.payload['orderId'] === checkout.orderId,
      )!;
      // El bus entrega el evento al puente bajo el contexto del aula emisora.
      await bridge.onOrderCompleted({
        metadata: { tenantId },
        data: completed.payload,
      } as unknown as DomainEvent<BillingOrderCompletedPayload>);
      return { orderId: checkout.orderId, completed };
    });
  }

  it('compra de un curso suelto con enlace → comisión PENDING del referidor sobre lo cobrado', async () => {
    const { code } = await runAsTenant(ids.tenantA, () =>
      referrals.getOrCreateCode(ids.tenantA, ids.referrerA),
    );
    const { orderId, completed } = await buy(ids.tenantA, ids.buyerA, ids.courseA, code);

    expect(completed.payload['attribution']).toEqual({ referralCode: code });
    const commission = await admin.modReferralsCommission.findUniqueOrThrow({
      where: { stripeInvoiceId: `order:${orderId}` },
    });
    expect(commission).toMatchObject({
      tenantId: ids.tenantA,
      referrerUserId: ids.referrerA,
      baseAmountCents: 4900,
      amountCents: 1470, // 30 % de 49 €
      status: 'PENDING',
    });
    const referral = await admin.modReferralsReferral.findUniqueOrThrow({
      where: { id: commission.referralId },
    });
    expect(referral).toMatchObject({
      referredUserId: ids.buyerA,
      orderId,
      subscriptionId: null,
      stripeSubscriptionId: null,
    });
  });

  it('el aula B no ve nada de la comisión de A, y el código de A no vale en B', async () => {
    const enB = await runAsTenant(ids.tenantB, async () => ({
      commissions: await prisma.modReferralsCommission.findMany(),
      referrals: await prisma.modReferralsReferral.findMany(),
      listed: await referrals.listCommissions(ids.tenantB),
    }));
    expect(enB.commissions).toHaveLength(0);
    expect(enB.referrals).toHaveLength(0);
    expect(JSON.stringify(enB.listed)).not.toContain(ids.referrerA);

    const codeA = (
      await admin.modReferralsCode.findFirstOrThrow({ where: { tenantId: ids.tenantA } })
    ).code;
    const { orderId } = await buy(ids.tenantB, ids.buyerB, ids.courseB, codeA);
    expect(
      await admin.modReferralsCommission.findUnique({
        where: { stripeInvoiceId: `order:${orderId}` },
      }),
    ).toBeNull();
  });

  it('autorreferido: comprar con tu propio enlace no genera comisión', async () => {
    const { code } = await runAsTenant(ids.tenantB, () =>
      referrals.getOrCreateCode(ids.tenantB, ids.referrerB),
    );
    const { orderId } = await buy(ids.tenantB, ids.referrerB, ids.courseB, code);
    expect(
      await admin.modReferralsCommission.findUnique({
        where: { stripeInvoiceId: `order:${orderId}` },
      }),
    ).toBeNull();
  });

  it('el reembolso total de la compra anula la comisión', async () => {
    const commission = await admin.modReferralsCommission.findFirstOrThrow({
      where: { tenantId: ids.tenantA },
    });
    const orderId = commission.stripeInvoiceId.replace(/^order:/, '');
    await runAsTenant(ids.tenantA, async () => {
      const refund = {
        id: `evt_refund_${orderId}`,
        type: 'charge.refunded',
        data: {
          object: {
            id: `ch_${orderId}`,
            payment_intent: `pi_${orderId}`,
            amount: 4900,
            amount_refunded: 4900,
          },
        },
      } as unknown as Stripe.Event;
      await billing.handleWebhookEvent(refund, {}, { tenantId: ids.tenantA });
      const refunded = billingEvents.find(
        (e) => e.name === 'billing.order.refunded' && e.payload['orderId'] === orderId,
      )!;
      await bridge.onOrderRefunded({
        metadata: { tenantId: ids.tenantA },
        data: refunded.payload,
      } as unknown as DomainEvent<BillingOrderRefundedPayload>);
    });
    const after = await admin.modReferralsCommission.findUniqueOrThrow({
      where: { id: commission.id },
    });
    expect(after.status).toBe('REVOKED');
  });
});
