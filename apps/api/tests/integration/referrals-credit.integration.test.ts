/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Descuento en la cuota por referidos, contra Postgres REAL conectando como
 * `didacta_app` (NOSUPERUSER, NOBYPASSRLS): el alumno canjea lo ganado como
 * abono en el saldo de cliente de Stripe de su membresía.
 *
 * - Solo comisiones APPROVED sin liquidar; quedan PAID con la liquidación
 *   CREDIT y el `cbtxn_…` como referencia.
 * - Idempotencia: cinco canjes a la vez → un abono; Stripe caído → la
 *   liquidación queda PENDING y el reintento usa la misma clave e importe; el
 *   índice parcial de la migración impide una segunda PENDING.
 * - Aislamiento entre aulas: el canje del aula A no toca nada del aula B, la
 *   membresía de A no vale en B y B no ve la liquidación de A.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import {
  ReferralsCreditFailedError,
  ReferralsCreditNothingError,
  ReferralsMembershipRequiredError,
  ReferralsService,
  creditIdempotencyKey,
  type ReferralsCreditPort,
} from '@didacta/mod-referrals';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runAsTenant } from '../../src/tenancy/tenant-context.storage';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

/** El índice parcial de la migración `20261114130000_referrals_descuento_cuota` (db push no lo crea). */
const ONE_PENDING_CREDIT_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS "mod_referrals_payout_one_pending_credit"
  ON "mod_referrals_payout" ("tenant_id", "referrer_user_id")
  WHERE "method" = 'CREDIT' AND "status" = 'PENDING'`;

/** Doble del saldo de cliente de Stripe: idempotente por clave, como Stripe. */
function stripeBalances() {
  const balances = new Map<string, number>();
  const byKey = new Map<string, string>();
  const calls: Array<{ tenantId: string; customerId: string; amountCents: number; key: string }> =
    [];
  let failNext = 0;
  let seq = 0;
  const port: ReferralsCreditPort = {
    retrieveBalance: async (_tenantId, customerId) => ({
      balanceCents: balances.get(customerId) ?? 0,
      currency: 'eur',
    }),
    credit: async (tenantId, p) => {
      calls.push({
        tenantId,
        customerId: p.customerId,
        amountCents: p.amountCents,
        key: p.idempotencyKey,
      });
      if (failNext > 0) {
        failNext -= 1;
        throw new Error('Stripe 503');
      }
      const existing = byKey.get(p.idempotencyKey);
      if (existing) return { id: existing };
      seq += 1;
      const id = `cbtxn_int_${seq}`;
      byKey.set(p.idempotencyKey, id);
      balances.set(p.customerId, (balances.get(p.customerId) ?? 0) - p.amountCents);
      return { id };
    },
  };
  return {
    port,
    calls,
    balances,
    byKey,
    failOnce: () => {
      failNext = 1;
    },
  };
}

describeWithDb('Referidos: descuento en la cuota — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let stripe: ReturnType<typeof stripeBalances>;
  let referrals: ReferralsService;
  const stamp = Date.now();
  const ids = {
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    referrerA: '',
    buyerA: '',
    referrerB: '',
    buyerB: '',
    referralA: '',
    referralB: '',
  };

  beforeAll(async () => {
    const prepared = await prepareDidactaAppRole();
    admin = prepared.admin;
    await admin.$executeRawUnsafe(ONE_PENDING_CREDIT_INDEX);
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
        data: { id: ids[key], slug: `credit-${slug}-${stamp}`, name: `credit-${slug}-${stamp}` },
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

    // Config SIN el campo nuevo: el default de la columna lo deja encendido.
    await admin.modReferralsConfig.createMany({
      data: [
        { tenantId: ids.tenantA, active: true },
        { tenantId: ids.tenantB, active: true },
      ],
    });
    ids.referralA = (
      await admin.modReferralsReferral.create({
        data: {
          tenantId: ids.tenantA,
          referrerUserId: ids.referrerA,
          referredUserId: ids.buyerA,
          code: `codea${stamp}`.slice(0, 16),
        },
      })
    ).id;
    ids.referralB = (
      await admin.modReferralsReferral.create({
        data: {
          tenantId: ids.tenantB,
          referrerUserId: ids.referrerB,
          referredUserId: ids.buyerB,
          code: `codeb${stamp}`.slice(0, 16),
        },
      })
    ).id;
    // Membresía viva de 30 € del referidor en cada aula, cada una con su cliente.
    await admin.modSubscriptionsSubscription.createMany({
      data: [
        {
          tenantId: ids.tenantA,
          userId: ids.referrerA,
          planId: randomUUID(),
          stripeCustomerId: `cus_a_${stamp}`,
          stripePriceId: 'price_a',
          status: 'ACTIVE',
          unitAmount: 3000,
          currency: 'eur',
          interval: 'month',
        },
        {
          tenantId: ids.tenantB,
          userId: ids.referrerB,
          planId: randomUUID(),
          stripeCustomerId: `cus_b_${stamp}`,
          stripePriceId: 'price_b',
          status: 'ACTIVE',
          unitAmount: 3000,
          currency: 'eur',
          interval: 'month',
        },
      ],
    });
  });

  let invoiceSeq = 0;
  async function commission(
    tenant: 'A' | 'B',
    amountCents: number,
    status: 'PENDING' | 'APPROVED',
  ): Promise<string> {
    invoiceSeq += 1;
    const row = await admin.modReferralsCommission.create({
      data: {
        tenantId: tenant === 'A' ? ids.tenantA : ids.tenantB,
        referralId: tenant === 'A' ? ids.referralA : ids.referralB,
        referrerUserId: tenant === 'A' ? ids.referrerA : ids.referrerB,
        stripeInvoiceId: `in_credit_${stamp}_${invoiceSeq}`,
        baseAmountCents: amountCents * 3,
        amountCents,
        currency: 'eur',
        commissionBps: 3000,
        status,
        approveAfter: new Date(),
        approvedAt: status === 'APPROVED' ? new Date() : null,
      },
    });
    return row.id;
  }

  beforeEach(async () => {
    for (const tenantId of [ids.tenantA, ids.tenantB]) {
      await admin.modReferralsCommission.deleteMany({ where: { tenantId } });
      await admin.modReferralsPayout.deleteMany({ where: { tenantId } });
    }
    stripe = stripeBalances();
    referrals = new ReferralsService(
      prisma as never,
      { publish: async () => undefined },
      async () => null,
      stripe.port,
    );
  });

  afterAll(async () => {
    for (const tenantId of [ids.tenantA, ids.tenantB]) {
      await admin.modReferralsCommission.deleteMany({ where: { tenantId } });
      await admin.modReferralsPayout.deleteMany({ where: { tenantId } });
      await admin.modReferralsReferral.deleteMany({ where: { tenantId } });
      await admin.modReferralsConfig.deleteMany({ where: { tenantId } });
      await admin.modSubscriptionsSubscription.deleteMany({ where: { tenantId } });
      await admin.user.deleteMany({ where: { tenantId } });
      await admin.tenant.delete({ where: { id: tenantId } });
    }
    await closeModule?.();
    await admin?.$disconnect();
  });

  it('la opción nace encendida por el default de la columna', async () => {
    const config = await runAsTenant(ids.tenantA, () => referrals.getConfig(ids.tenantA));
    expect(config.allowCreditRedemption).toBe(true);
  });

  it('canjea solo las APPROVED del aula A; nada del aula B se mueve', async () => {
    const a1 = await commission('A', 900, 'APPROVED');
    const a2 = await commission('A', 300, 'APPROVED');
    const aPending = await commission('A', 500, 'PENDING');
    const b1 = await commission('B', 700, 'APPROVED');

    const stats = await runAsTenant(ids.tenantA, () =>
      referrals.memberStats(ids.tenantA, ids.referrerA),
    );
    expect(stats.credit).toEqual({
      enabled: true,
      availableCents: 1200,
      currency: 'eur',
      maxCents: 2400,
      pending: false,
    });

    const result = await runAsTenant(ids.tenantA, () =>
      referrals.redeemAsCredit(ids.tenantA, ids.referrerA),
    );
    expect(result).toMatchObject({ totalCents: 1200, count: 2, currency: 'eur' });
    expect(stripe.calls).toEqual([
      {
        tenantId: ids.tenantA,
        customerId: `cus_a_${stamp}`,
        amountCents: 1200,
        key: creditIdempotencyKey(result.payoutId),
      },
    ]);

    const payout = await admin.modReferralsPayout.findUniqueOrThrow({
      where: { id: result.payoutId },
    });
    expect(payout).toMatchObject({
      tenantId: ids.tenantA,
      method: 'CREDIT',
      status: 'DONE',
      externalReference: result.stripeBalanceTransactionId,
      stripeCustomerId: `cus_a_${stamp}`,
      totalCents: 1200,
    });
    const rows = await admin.modReferralsCommission.findMany({
      where: { id: { in: [a1, a2, aPending, b1] } },
      select: { id: true, status: true, payoutId: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(a1)).toMatchObject({ status: 'PAID', payoutId: result.payoutId });
    expect(byId.get(a2)).toMatchObject({ status: 'PAID', payoutId: result.payoutId });
    expect(byId.get(aPending)).toMatchObject({ status: 'PENDING', payoutId: null });
    expect(byId.get(b1)).toMatchObject({ status: 'APPROVED', payoutId: null });

    // El aula B no ve la liquidación de A (RLS + filtro por tenant).
    const seenFromB = await runAsTenant(ids.tenantB, () =>
      prisma.modReferralsPayout.findMany({ where: { id: result.payoutId } }),
    );
    expect(seenFromB).toEqual([]);
  });

  it('la membresía del aula A no vale para canjear en el aula B', async () => {
    await commission('A', 900, 'APPROVED');
    await expect(
      runAsTenant(ids.tenantB, () => referrals.redeemAsCredit(ids.tenantB, ids.referrerA)),
    ).rejects.toBeInstanceOf(ReferralsMembershipRequiredError);
    // Y desde el aula A, pidiendo como si fuera B, RLS no deja leer la sub de B.
    await commission('B', 700, 'APPROVED');
    await expect(
      runAsTenant(ids.tenantA, () => referrals.redeemAsCredit(ids.tenantB, ids.referrerB)),
    ).rejects.toBeInstanceOf(ReferralsMembershipRequiredError);
    expect(stripe.calls).toEqual([]);
    expect(await admin.modReferralsPayout.count({ where: { method: 'CREDIT' } })).toBe(0);
  });

  it('cinco canjes a la vez → un abono y una liquidación', async () => {
    await commission('A', 900, 'APPROVED');
    await commission('A', 300, 'APPROVED');
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        runAsTenant(ids.tenantA, () => referrals.redeemAsCredit(ids.tenantA, ids.referrerA)),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const ko = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    const payouts = await admin.modReferralsPayout.findMany({
      where: { tenantId: ids.tenantA, method: 'CREDIT' },
    });
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({ status: 'DONE', totalCents: 1200 });
    // Uno abona; los que llegan con la liquidación a medias la terminan con la
    // MISMA clave (Stripe no abona dos veces); el resto no encuentra nada.
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of ko) expect(r.reason).toBeInstanceOf(ReferralsCreditNothingError);
    expect(new Set(stripe.calls.map((c) => c.key))).toEqual(
      new Set([creditIdempotencyKey(payouts[0]!.id)]),
    );
    expect(stripe.byKey.size).toBe(1);
    expect(stripe.balances.get(`cus_a_${stamp}`)).toBe(-1200);
  });

  it('Stripe caído: PENDING; el reintento repite la misma clave; no cabe una segunda PENDING', async () => {
    await commission('A', 900, 'APPROVED');
    stripe.failOnce();
    await expect(
      runAsTenant(ids.tenantA, () => referrals.redeemAsCredit(ids.tenantA, ids.referrerA)),
    ).rejects.toBeInstanceOf(ReferralsCreditFailedError);
    const pending = await admin.modReferralsPayout.findFirstOrThrow({
      where: { tenantId: ids.tenantA, method: 'CREDIT' },
    });
    expect(pending.status).toBe('PENDING');

    // El índice parcial: una segunda PENDING del mismo alumno y aula no entra.
    await expect(
      admin.modReferralsPayout.create({
        data: {
          tenantId: ids.tenantA,
          referrerUserId: ids.referrerA,
          totalCents: 1,
          currency: 'eur',
          externalReference: 'pendiente',
          createdByUserId: ids.referrerA,
          method: 'CREDIT',
          status: 'PENDING',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // Entretanto se aprueba otra: el reintento termina SOLO el abono a medias.
    await commission('A', 400, 'APPROVED');
    const retried = await runAsTenant(ids.tenantA, () =>
      referrals.redeemAsCredit(ids.tenantA, ids.referrerA),
    );
    expect(retried).toMatchObject({ payoutId: pending.id, totalCents: 900 });
    expect(stripe.calls.map((c) => [c.key, c.amountCents])).toEqual([
      [creditIdempotencyKey(pending.id), 900],
      [creditIdempotencyKey(pending.id), 900],
    ]);
    expect(
      await admin.modReferralsPayout.findUniqueOrThrow({ where: { id: pending.id } }),
    ).toMatchObject({ status: 'DONE', externalReference: retried.stripeBalanceTransactionId });

    // La de 400 sigue disponible y cabe en el tope (2400 − 900 a favor).
    const next = await runAsTenant(ids.tenantA, () =>
      referrals.redeemAsCredit(ids.tenantA, ids.referrerA),
    );
    expect(next.totalCents).toBe(400);
    expect(stripe.balances.get(`cus_a_${stamp}`)).toBe(-1300);
  });

  it('con el creador apagando la opción, el alumno no ve el botón', async () => {
    await commission('A', 900, 'APPROVED');
    await runAsTenant(ids.tenantA, () =>
      referrals.updateConfig(ids.tenantA, { allowCreditRedemption: false }),
    );
    try {
      const stats = await runAsTenant(ids.tenantA, () =>
        referrals.memberStats(ids.tenantA, ids.referrerA),
      );
      expect(stats.credit.enabled).toBe(false);
    } finally {
      await runAsTenant(ids.tenantA, () =>
        referrals.updateConfig(ids.tenantA, { allowCreditRedemption: true }),
      );
    }
  });
});
