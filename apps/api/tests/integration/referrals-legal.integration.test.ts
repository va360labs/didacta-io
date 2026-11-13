/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Puntos legales del programa de referidos (ADR-057, decididos el 13-nov),
 * contra Postgres REAL conectando como `didacta_app` (NOSUPERUSER,
 * NOBYPASSRLS). Cada bloque prueba un punto y que el aula B no ve nada del
 * aula A.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import {
  REFERRAL_TERMS_VERSION,
  ReferralsService,
  ReferralsTermsRequiredError,
} from '@didacta/mod-referrals';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runAsTenant } from '../../src/tenancy/tenant-context.storage';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

describeWithDb('Referidos — puntos legales, Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let referrals: ReferralsService;
  const stamp = Date.now();
  const ids = {
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    referrerA: '',
    buyerA: '',
    referrerB: '',
  };

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
        data: { id: ids[key], slug: `legal-${slug}-${stamp}`, name: `Aula ${slug.toUpperCase()}` },
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
    await admin.modReferralsConfig.createMany({
      data: [
        { tenantId: ids.tenantA, active: true, minPayoutCents: 1000 },
        { tenantId: ids.tenantB, active: true, minPayoutCents: 1000 },
      ],
    });
    referrals = new ReferralsService(
      prisma as never,
      { publish: async () => undefined },
      async (tenantId, userId) => {
        const u = await admin.user.findFirst({ where: { id: userId, tenantId } });
        return u?.email ?? null;
      },
    );
  }, 120_000);

  afterAll(async () => {
    for (const tenantId of [ids.tenantA, ids.tenantB]) {
      await admin.modReferralsCommission.deleteMany({ where: { tenantId } });
      await admin.modReferralsPayout.deleteMany({ where: { tenantId } });
      await admin.modReferralsReferral.deleteMany({ where: { tenantId } });
      await admin.modReferralsCode.deleteMany({ where: { tenantId } });
      await admin.modReferralsMember.deleteMany({ where: { tenantId } });
      await admin.modReferralsConfig.deleteMany({ where: { tenantId } });
      await admin.user.deleteMany({ where: { tenantId } });
      await admin.tenant.delete({ where: { id: tenantId } });
    }
    await admin?.$disconnect();
    await closeModule?.();
  });

  describe('1. mayores de 18 y condiciones', () => {
    it('sin la casilla no hay enlace; al aceptar se guardan versión y fecha, y B no lo ve', async () => {
      await expect(
        runAsTenant(ids.tenantA, () => referrals.getOrCreateCode(ids.tenantA, ids.referrerA)),
      ).rejects.toBeInstanceOf(ReferralsTermsRequiredError);

      await runAsTenant(ids.tenantA, () =>
        referrals.acceptTerms(ids.tenantA, ids.referrerA, {
          version: REFERRAL_TERMS_VERSION,
          adult: true,
        }),
      );
      const row = await admin.modReferralsMember.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId: ids.tenantA, userId: ids.referrerA } },
      });
      expect(row.termsVersion).toBe(REFERRAL_TERMS_VERSION);
      expect(row.termsAcceptedAt).toBeInstanceOf(Date);
      const { code } = await runAsTenant(ids.tenantA, () =>
        referrals.getOrCreateCode(ids.tenantA, ids.referrerA),
      );
      expect(code).toMatch(/^[a-z2-9]{8}$/);

      // Aislamiento: desde B no se ve la aceptación de A.
      expect(
        await runAsTenant(ids.tenantB, async () =>
          prisma.modReferralsMember.count({ where: { tenantId: ids.tenantA } }),
        ),
      ).toBe(0);
    });

    it('el enlace de quien nunca aceptó no atribuye una compra', async () => {
      // Código antiguo creado antes de existir la casilla.
      await admin.modReferralsCode.create({
        data: { tenantId: ids.tenantB, userId: ids.referrerB, code: `viejo${stamp}`.slice(0, 12) },
      });
      const buyerB = (
        await admin.user.create({
          data: { tenantId: ids.tenantB, email: `buyer-b-${stamp}@example.test`, status: 'ACTIVE' },
        })
      ).id;
      const result = await runAsTenant(ids.tenantB, () =>
        referrals.recordPurchase({
          tenantId: ids.tenantB,
          referralCode: `viejo${stamp}`.slice(0, 12),
          buyerUserId: buyerB,
          orderId: randomUUID(),
          amountCents: 4900,
          currency: 'eur',
        }),
      );
      expect(result).toEqual({ accrued: false, reason: 'terms_not_accepted' });
      expect(await admin.modReferralsCommission.count({ where: { tenantId: ids.tenantB } })).toBe(
        0,
      );
    });
  });
});
