/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Puntos legales del programa de referidos (ADR-057, decididos el 13-nov),
 * contra Postgres REAL conectando como `didacta_app` (NOSUPERUSER,
 * NOBYPASSRLS). Cada bloque prueba un punto y que el aula B no ve nada del
 * aula A.
 */

import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  REFERRAL_TERMS_VERSION,
  ReferralsPayeeInvalidError,
  ReferralsPayoutAlreadyRequestedError,
  ReferralsPayoutNotFoundError,
  ReferralsPayoutValidationError,
  ReferralsService,
  ReferralsTermsRequiredError,
  ReferralsCreditFailedError,
  uncreditIdempotencyKey,
  type ReferralsCreditPort,
} from '@didacta/mod-referrals';
import { SecretCipherService } from '../../src/modules/secret-cipher.service';
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
      null,
      new SecretCipherService(randomBytes(32).toString('hex')),
    );
  }, 120_000);

  afterAll(async () => {
    for (const tenantId of [ids.tenantA, ids.tenantB]) {
      await admin.modReferralsCommission.deleteMany({ where: { tenantId } });
      await admin.modReferralsPayout.deleteMany({ where: { tenantId } });
      await admin.modSubscriptionsSubscription.deleteMany({ where: { tenantId } });
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

  /** Referido y comisiones APPROVED sin liquidar del alumno A (lo que ya ha ganado). */
  async function approved(...amounts: number[]): Promise<string[]> {
    let referral = await admin.modReferralsReferral.findFirst({
      where: { tenantId: ids.tenantA, referrerUserId: ids.referrerA },
    });
    referral ??= await admin.modReferralsReferral.create({
      data: {
        tenantId: ids.tenantA,
        referrerUserId: ids.referrerA,
        referredUserId: ids.buyerA,
        code: `legal${stamp}`.slice(0, 12),
      },
    });
    const out: string[] = [];
    for (const amountCents of amounts) {
      const row = await admin.modReferralsCommission.create({
        data: {
          tenantId: ids.tenantA,
          referralId: referral.id,
          referrerUserId: ids.referrerA,
          stripeInvoiceId: `legal:${randomUUID()}`,
          baseAmountCents: amountCents * 3,
          amountCents,
          currency: 'eur',
          commissionBps: 3000,
          status: 'APPROVED',
          approveAfter: new Date(),
          approvedAt: new Date(),
        },
      });
      out.push(row.id);
    }
    return out;
  }

  describe('2. datos para cobrar en dinero', () => {
    const datos = {
      fullName: 'Lucía Pérez Gil',
      country: 'ES',
      taxId: '12345678Z',
      iban: 'ES91 2100 0418 4502 0005 1332',
    };

    it('valida el formato y guarda los datos CIFRADOS; el alumno los ve enmascarados', async () => {
      await expect(
        runAsTenant(ids.tenantA, () =>
          referrals.savePayee(ids.tenantA, ids.referrerA, { ...datos, iban: 'ES00 1234' }),
        ),
      ).rejects.toBeInstanceOf(ReferralsPayeeInvalidError);

      const masked = await runAsTenant(ids.tenantA, () =>
        referrals.savePayee(ids.tenantA, ids.referrerA, datos),
      );
      expect(masked).toMatchObject({
        fullName: 'Lucía Pérez Gil',
        taxIdMasked: '•••••678Z',
        ibanMasked: 'ES•• •••• 1332',
      });
      // En la base no hay ni rastro en claro.
      const raw = await admin.$queryRawUnsafe<Array<{ txt: string }>>(
        `SELECT encode(payee_cipher, 'escape') AS txt FROM mod_referrals_member WHERE tenant_id = '${ids.tenantA}'::uuid AND user_id = '${ids.referrerA}'::uuid`,
      );
      expect(raw[0]!.txt).not.toContain('12345678Z');
      expect(raw[0]!.txt).not.toContain('ES9121000418450200051332');
      expect(raw[0]!.txt).not.toContain('Lucía');
    });

    it('pide el cobro (mínimo del aula), reserva lo confirmado y el creador lo marca pagado; B no ve nada', async () => {
      await approved(600);
      // 6 € no llegan al mínimo de 10 €.
      await expect(
        runAsTenant(ids.tenantA, () => referrals.requestCashPayout(ids.tenantA, ids.referrerA)),
      ).rejects.toBeInstanceOf(ReferralsPayoutValidationError);
      await approved(700);
      const req = await runAsTenant(ids.tenantA, () =>
        referrals.requestCashPayout(ids.tenantA, ids.referrerA),
      );
      expect(req).toMatchObject({ totalCents: 1300, currency: 'eur', count: 2 });
      await expect(
        runAsTenant(ids.tenantA, () => referrals.requestCashPayout(ids.tenantA, ids.referrerA)),
      ).rejects.toBeInstanceOf(ReferralsPayoutAlreadyRequestedError);
      // Reservadas: siguen APPROVED pero ya con su liquidación.
      expect(
        await admin.modReferralsCommission.count({
          where: { tenantId: ids.tenantA, payoutId: req.payoutId, status: 'APPROVED' },
        }),
      ).toBe(2);

      // El creador ve lo necesario para pagar, en claro.
      const list = await runAsTenant(ids.tenantA, () => referrals.listCashPayouts(ids.tenantA));
      expect(list[0]).toMatchObject({
        id: req.payoutId,
        status: 'REQUESTED',
        payee: {
          fullName: 'Lucía Pérez Gil',
          taxId: '12345678Z',
          iban: 'ES9121000418450200051332',
        },
      });
      // Aislamiento: el aula B no ve el cobro ni los datos de A.
      expect(await runAsTenant(ids.tenantB, () => referrals.listCashPayouts(ids.tenantB))).toEqual(
        [],
      );
      await expect(
        runAsTenant(ids.tenantB, () =>
          referrals.markCashPayoutPaid(ids.tenantB, req.payoutId, {
            externalReference: 'TRF-B',
            actorId: ids.referrerB,
          }),
        ),
      ).rejects.toBeInstanceOf(ReferralsPayoutNotFoundError);

      await runAsTenant(ids.tenantA, () =>
        referrals.markCashPayoutPaid(ids.tenantA, req.payoutId, {
          externalReference: 'TRF-2026-0001',
          actorId: ids.referrerA,
        }),
      );
      const done = await admin.modReferralsPayout.findUniqueOrThrow({
        where: { id: req.payoutId },
      });
      expect(done).toMatchObject({ status: 'DONE', externalReference: 'TRF-2026-0001' });
      expect(done.paidAt).toBeInstanceOf(Date);
      expect(
        await admin.modReferralsCommission.count({
          where: { tenantId: ids.tenantA, payoutId: req.payoutId, status: 'PAID' },
        }),
      ).toBe(2);
    });
  });

  describe('3. justificante en PDF', () => {
    it('cada cobro pagado lleva número correlativo por aula, receptor congelado y PDF descargable solo por los suyos', async () => {
      // El cobro del punto 2 ya está pagado: es el nº 1 del aula A.
      const first = await admin.modReferralsPayout.findFirstOrThrow({
        where: { tenantId: ids.tenantA, method: 'CASH', status: 'DONE' },
      });
      expect(first.receiptNumber).toBe(1);
      expect(first.payeeSnapshotCipher).not.toBeNull();

      // El alumno cambia luego su IBAN: el justificante ya emitido no cambia.
      await runAsTenant(ids.tenantA, () =>
        referrals.savePayee(ids.tenantA, ids.referrerA, {
          fullName: 'Lucía Pérez Gil',
          country: 'ES',
          taxId: '12345678Z',
          iban: 'DE89 3704 0044 0532 0130 00',
        }),
      );
      const list = await runAsTenant(ids.tenantA, () => referrals.listCashPayouts(ids.tenantA));
      expect(list.find((r) => r.id === first.id)?.payee?.iban).toBe('ES9121000418450200051332');

      // Segundo cobro: nº 2.
      await approved(1500);
      const req = await runAsTenant(ids.tenantA, () =>
        referrals.requestCashPayout(ids.tenantA, ids.referrerA),
      );
      await runAsTenant(ids.tenantA, () =>
        referrals.markCashPayoutPaid(ids.tenantA, req.payoutId, {
          externalReference: 'TRF-2026-0002',
          actorId: ids.referrerA,
        }),
      );
      expect(
        (await admin.modReferralsPayout.findUniqueOrThrow({ where: { id: req.payoutId } }))
          .receiptNumber,
      ).toBe(2);

      // PDF: el alumno descarga el suyo; otro usuario no; el creador sí.
      const mine = await runAsTenant(ids.tenantA, () =>
        referrals.receiptPdf(ids.tenantA, first.id, { referrerUserId: ids.referrerA }),
      );
      expect(mine.filename).toBe('justificante-0001.pdf');
      expect(mine.pdf.subarray(0, 5).toString()).toBe('%PDF-');
      await expect(
        runAsTenant(ids.tenantA, () =>
          referrals.receiptPdf(ids.tenantA, first.id, { referrerUserId: ids.buyerA }),
        ),
      ).rejects.toBeInstanceOf(ReferralsPayoutNotFoundError);
      const creator = await runAsTenant(ids.tenantA, () =>
        referrals.receiptPdf(ids.tenantA, first.id),
      );
      expect(creator.pdf.length).toBeGreaterThan(1000);
      // Aislamiento: desde el aula B no existe.
      await expect(
        runAsTenant(ids.tenantB, () => referrals.receiptPdf(ids.tenantB, first.id)),
      ).rejects.toBeInstanceOf(ReferralsPayoutNotFoundError);
    });

    it('quien cobra con el perfil en pt-BR lo recibe también en portugués (idioma leído bajo RLS)', async () => {
      const first = await admin.modReferralsPayout.findFirstOrThrow({
        where: { tenantId: ids.tenantA, method: 'CASH', status: 'DONE', receiptNumber: 1 },
      });
      const decoder = new TextDecoder('windows-1252');
      const { inflateSync } = await import('node:zlib');
      const texto = (pdf: Buffer) =>
        [...pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
          .map((m) => {
            try {
              return inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1');
            } catch {
              return '';
            }
          })
          .flatMap((c) => [...c.matchAll(/\[([^\]]*)\]\s*TJ/g)])
          .map((tj) =>
            decoder.decode(
              Buffer.from(
                [...tj[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1]).join(''),
                'hex',
              ),
            ),
          )
          .join(' ');

      // Control: con el perfil por defecto (español) y receptor en España, solo español.
      const antes = await runAsTenant(ids.tenantA, () =>
        referrals.receiptPdf(ids.tenantA, first.id),
      );
      expect(texto(antes.pdf)).toContain('Justificante de pago');
      expect(texto(antes.pdf)).not.toContain('Comprovante');

      await admin.user.update({ where: { id: ids.referrerA }, data: { locale: 'pt-BR' } });
      try {
        const pt = await runAsTenant(ids.tenantA, () =>
          referrals.receiptPdf(ids.tenantA, first.id),
        );
        expect(texto(pt.pdf)).toContain('Justificante de pago / Comprovante de pagamento');
        expect(texto(pt.pdf)).toContain('Comissão de');
      } finally {
        await admin.user.update({ where: { id: ids.referrerA }, data: { locale: 'es-ES' } });
      }
    });
  });

  describe('6. baja con saldo de referidos sin usar', () => {
    /** Saldo de cliente de Stripe en memoria, idempotente por clave como Stripe. */
    function stripeBalances() {
      const balances = new Map<string, number>();
      const byKey = new Map<string, string>();
      const debits: Array<{ customerId: string; amountCents: number; key: string }> = [];
      let failNext = 0;
      let seq = 0;
      const apply = (customerId: string, delta: number, key: string) => {
        const done = byKey.get(key);
        if (done) return { id: done };
        seq += 1;
        const id = `cbtxn_baja_${seq}`;
        byKey.set(key, id);
        balances.set(customerId, (balances.get(customerId) ?? 0) + delta);
        return { id };
      };
      const port: ReferralsCreditPort = {
        retrieveBalance: async (_t, customerId) => ({
          balanceCents: balances.get(customerId) ?? 0,
          currency: 'eur',
        }),
        credit: async (_t, p) => apply(p.customerId, -p.amountCents, p.idempotencyKey),
        debit: async (_t, p) => {
          debits.push({
            customerId: p.customerId,
            amountCents: p.amountCents,
            key: p.idempotencyKey,
          });
          if (failNext > 0) {
            failNext -= 1;
            throw new Error('Stripe 503');
          }
          return apply(p.customerId, p.amountCents, p.idempotencyKey);
        },
      };
      return { port, balances, debits, failOnce: () => (failNext = 1) };
    }

    it('al cancelar, el saldo sin usar se retira de Stripe una sola vez y vuelve a la cartera; B no lo ve', async () => {
      const stripe = stripeBalances();
      const withPort = new ReferralsService(
        prisma as never,
        { publish: async () => undefined },
        async () => null,
        stripe.port,
      );
      const customer = `cus_baja_${stamp}`;
      const sub = await admin.modSubscriptionsSubscription.create({
        data: {
          tenantId: ids.tenantA,
          userId: ids.referrerA,
          planId: randomUUID(),
          stripeCustomerId: customer,
          stripePriceId: 'price_baja',
          status: 'ACTIVE',
          unitAmount: 3000,
          currency: 'eur',
          interval: 'month',
        },
      });
      await approved(600, 400);
      const redeemed = await runAsTenant(ids.tenantA, () =>
        withPort.redeemAsCredit(ids.tenantA, ids.referrerA),
      );
      expect(redeemed.totalCents).toBe(1000);
      // La siguiente cuota gastó 3 € del saldo: quedan 7 € a favor.
      stripe.balances.set(customer, -700);
      // Se da de baja.
      await admin.modSubscriptionsSubscription.update({
        where: { id: sub.id },
        data: { status: 'CANCELED', canceledAt: new Date() },
      });

      // Aislamiento: desde el aula B, la suscripción de A no existe.
      expect(
        await runAsTenant(ids.tenantB, () =>
          withPort.returnUnusedCredit(ids.tenantB, {
            userId: ids.referrerA,
            subscriptionId: sub.id,
          }),
        ),
      ).toEqual({ returned: false, reason: 'no_customer' });

      // Stripe falla la primera vez: la retirada queda PENDING.
      stripe.failOnce();
      await expect(
        runAsTenant(ids.tenantA, () =>
          withPort.returnUnusedCredit(ids.tenantA, {
            userId: ids.referrerA,
            subscriptionId: sub.id,
          }),
        ),
      ).rejects.toBeInstanceOf(ReferralsCreditFailedError);
      const pending = await admin.modReferralsPayout.findFirstOrThrow({
        where: { tenantId: ids.tenantA, method: 'CREDIT_REVERSAL' },
      });
      expect(pending).toMatchObject({ status: 'PENDING', totalCents: -700 });

      // El reintento repite la MISMA llamada y termina.
      const done = await runAsTenant(ids.tenantA, () =>
        withPort.returnUnusedCredit(ids.tenantA, { userId: ids.referrerA, subscriptionId: sub.id }),
      );
      expect(done).toMatchObject({ returned: true, amountCents: 700, payoutId: pending.id });
      expect(stripe.debits.map((d) => d.key)).toEqual([
        uncreditIdempotencyKey(pending.id),
        uncreditIdempotencyKey(pending.id),
      ]);
      expect(stripe.balances.get(customer)).toBe(0);

      // Rastro en el ledger de referidos: la retirada DONE y la fila de cartera.
      expect(
        await admin.modReferralsPayout.findUniqueOrThrow({ where: { id: pending.id } }),
      ).toMatchObject({ status: 'DONE', externalReference: 'cbtxn_baja_2' });
      const back = await admin.modReferralsCommission.findFirstOrThrow({
        where: { tenantId: ids.tenantA, kind: 'CREDIT_RETURN' },
      });
      expect(back).toMatchObject({ status: 'APPROVED', amountCents: 700, payoutId: null });

      // Otra vez: nada que devolver (el saldo ya está a cero).
      expect(
        await runAsTenant(ids.tenantA, () =>
          withPort.returnUnusedCredit(ids.tenantA, {
            userId: ids.referrerA,
            subscriptionId: sub.id,
          }),
        ),
      ).toEqual({ returned: false, reason: 'nothing_to_return' });

      // Lo devuelto se puede cobrar en dinero, pero no cuenta como «ganado» otra vez.
      const stats = await runAsTenant(ids.tenantA, () =>
        withPort.memberStats(ids.tenantA, ids.referrerA),
      );
      expect(stats.availableCents).toBeGreaterThanOrEqual(700);
      expect(stats.commissions.find((c) => c.kind === 'CREDIT_RETURN')?.amountCents).toBe(700);
      // B no ve nada de esto.
      expect(
        await runAsTenant(ids.tenantB, async () =>
          prisma.modReferralsCommission.count({ where: { kind: 'CREDIT_RETURN' } }),
        ),
      ).toBe(0);
    });
  });

  describe('7. ventas devueltas después de cobrar', () => {
    it('ajuste negativo que se descuenta de lo siguiente; reembolso parcial en proporción; B no lo ve', async () => {
      // Una alumna nueva del aula A, con sus condiciones y datos de cobro.
      const alumna = (
        await admin.user.create({
          data: { tenantId: ids.tenantA, email: `ajustes-${stamp}@example.test`, status: 'ACTIVE' },
        })
      ).id;
      await runAsTenant(ids.tenantA, async () => {
        await referrals.acceptTerms(ids.tenantA, alumna, {
          version: REFERRAL_TERMS_VERSION,
          adult: true,
        });
        await referrals.savePayee(ids.tenantA, alumna, {
          fullName: 'Marta Gil Soto',
          country: 'ES',
          taxId: 'X1234567L',
          iban: 'ES91 2100 0418 4502 0005 1332',
        });
      });
      const referral = await admin.modReferralsReferral.create({
        data: {
          tenantId: ids.tenantA,
          referrerUserId: alumna,
          referredUserId: (
            await admin.user.create({
              data: {
                tenantId: ids.tenantA,
                email: `comprador-aj-${stamp}@example.test`,
                status: 'ACTIVE',
              },
            })
          ).id,
          code: `ajus${stamp}`.slice(0, 12),
        },
      });
      const commission = (
        ref: string,
        amountCents: number,
        status: 'PENDING' | 'APPROVED' | 'PAID',
      ) =>
        admin.modReferralsCommission.create({
          data: {
            tenantId: ids.tenantA,
            referralId: referral.id,
            referrerUserId: alumna,
            stripeInvoiceId: ref,
            baseAmountCents: Math.round(amountCents / 0.3),
            amountCents,
            currency: 'eur',
            commissionBps: 3000,
            status,
            approveAfter: new Date(),
            approvedAt: status === 'PENDING' ? null : new Date(),
          },
        });

      // a) Reembolso PARCIAL de una venta aún sin cobrar: recorte proporcional.
      const order = randomUUID();
      await commission(`order:${order}`, 1470, 'PENDING'); // venta de 49 €
      const parcial = await runAsTenant(ids.tenantA, () =>
        referrals.applyRefund(
          ids.tenantA,
          `order:${order}`,
          { refundedCents: 1225, totalCents: 4900 },
          'Devolución parcial',
        ),
      );
      // Se devuelve una cuarta parte: 36,75 € × 30 % = 11,03 €.
      expect(parcial).toMatchObject({ action: 'reduced', amountCents: 1103 });

      // b) Venta YA cobrada que se devuelve entera: ajuste negativo.
      const paidOrder = randomUUID();
      const paid = await commission(`order:${paidOrder}`, 1470, 'PAID');
      const total = await runAsTenant(ids.tenantA, () =>
        referrals.revokeCommissionByInvoice(ids.tenantA, `order:${paidOrder}`, 'Reembolso'),
      );
      expect(total).toMatchObject({ revoked: false, reason: 'already_paid' });
      const adj = await admin.modReferralsCommission.findFirstOrThrow({
        where: { tenantId: ids.tenantA, adjustsCommissionId: paid.id },
      });
      expect(adj).toMatchObject({ kind: 'ADJUSTMENT', amountCents: -1470, status: 'APPROVED' });

      // c) Con 10 € confirmados el ajuste (−14,70 €) no cabe: se cobran los 10 €
      //    y el ajuste espera. Nunca se le reclama nada.
      await commission(`legal:${randomUUID()}`, 1000, 'APPROVED');
      const first = await runAsTenant(ids.tenantA, () =>
        referrals.requestCashPayout(ids.tenantA, alumna),
      );
      expect(first.totalCents).toBe(1000);
      expect(
        (await admin.modReferralsCommission.findUniqueOrThrow({ where: { id: adj.id } })).payoutId,
      ).toBeNull();
      await runAsTenant(ids.tenantA, () =>
        referrals.markCashPayoutPaid(ids.tenantA, first.payoutId, {
          externalReference: 'TRF-AJ-1',
          actorId: alumna,
        }),
      );

      // d) Lo siguiente que gana (30 €) absorbe el ajuste: cobra 15,30 €.
      await commission(`legal:${randomUUID()}`, 3000, 'APPROVED');
      const second = await runAsTenant(ids.tenantA, () =>
        referrals.requestCashPayout(ids.tenantA, alumna),
      );
      expect(second.totalCents).toBe(1530);
      expect(
        (await admin.modReferralsCommission.findUniqueOrThrow({ where: { id: adj.id } })).payoutId,
      ).toBe(second.payoutId);

      // «Lo que has ganado» lo muestra como ajuste (negativo).
      const stats = await runAsTenant(ids.tenantA, () =>
        referrals.memberStats(ids.tenantA, alumna),
      );
      expect(stats.commissions.find((c) => c.kind === 'ADJUSTMENT')?.amountCents).toBe(-1470);
      // Aislamiento.
      expect(
        await runAsTenant(ids.tenantB, async () =>
          prisma.modReferralsCommission.count({ where: { kind: 'ADJUSTMENT' } }),
        ),
      ).toBe(0);
    });
  });
});
