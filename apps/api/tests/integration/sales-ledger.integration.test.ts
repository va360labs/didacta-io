/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * «Ventas» con los datos de cada venta contra un Postgres REAL, conectando
 * como el runtime de producción: rol `didacta_app` (NOSUPERUSER, NOBYPASSRLS)
 * y RLS forzada.
 *
 * Lo que solo se ve con la base de verdad: la consulta cruda que une órdenes,
 * cuotas cobradas, el reparto de la plataforma, reclamaciones y referidos
 * (columnas, tipos, enums y zonas horarias de verdad), que un aula no ve NI UNA
 * fila de otra (RLS + filtro por `tenant_id`), y los filtros, la búsqueda y la
 * paginación sobre esas filas.
 *
 * Se siembra con el administrador (las filas que dejarían los webhooks de
 * billing, suscripciones, cobros de plataforma y referidos) y se lee con
 * `SalesLedgerService` sobre el cliente de `didacta_app`.
 *
 * REQUISITOS: los de `rls-isolation-didacta-app.integration.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SalesLedgerService } from '../../src/sales/sales-ledger.service';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

describeWithDb('«Ventas» con los datos de cada venta — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let ledger: SalesLedgerService;
  let closeModule: () => Promise<void>;

  const stamp = Date.now();
  const A = randomUUID();
  const B = randomUUID();
  const ACCOUNT_A = randomUUID();
  const ACCOUNT_B = randomUUID();
  const ANA = randomUUID();
  const BEA = randomUUID();
  const CARLOS = randomUUID();
  const INTRUSO = randomUUID();
  const COURSE = randomUUID();
  const COURSE_B = randomUUID();
  const PRODUCT = randomUUID();
  const PRODUCT_B = randomUUID();
  const PLAN = randomUUID();
  const SUB = randomUUID();
  // Órdenes de A: pagada con reparto y transferida, devuelta, retenida,
  // disputada, sin cobrar (no cuenta). Y una de B.
  const O_TRANSFERRED = randomUUID();
  const O_REFUNDED = randomUUID();
  const O_HELD = randomUUID();
  const O_DISPUTED = randomUUID();
  const O_PENDING = randomUUID();
  const O_B = randomUUID();
  const I_PAID = randomUUID();
  const I_OPEN = randomUUID();
  const I_ZERO = randomUUID();
  const P_TRANSFERRED = randomUUID();
  const P_HELD = randomUUID();
  const P_DISPUTED = randomUUID();
  const P_INVOICE = randomUUID();

  const at = (day: number, hour = 12) => new Date(Date.UTC(2026, 10, day, hour, 0, 0));

  beforeAll(async () => {
    const prepared = await prepareDidactaAppRole();
    admin = prepared.admin;
    const previous = { url: process.env['DATABASE_URL'], mode: process.env['RLS_ENFORCEMENT'] };
    process.env['DATABASE_URL'] = prepared.appUrl;
    process.env['RLS_ENFORCEMENT'] = 'on';
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [PrismaModule],
        providers: [SalesLedgerService],
      }).compile();
      await moduleRef.init();
      prisma = moduleRef.get(PrismaService);
      ledger = moduleRef.get(SalesLedgerService);
      closeModule = () => moduleRef.close();
    } finally {
      process.env['DATABASE_URL'] = previous.url;
      if (previous.mode === undefined) delete process.env['RLS_ENFORCEMENT'];
      else process.env['RLS_ENFORCEMENT'] = previous.mode;
    }

    for (const [id, slug] of [
      [A, 'a'],
      [B, 'b'],
    ] as const) {
      await admin.tenant.create({
        data: { id, slug: `ventas-${slug}-${stamp}`, name: `Aula ${slug}` },
      });
    }
    await admin.user.createMany({
      data: [
        { id: ANA, tenantId: A, email: `ana-${stamp}@example.com`, name: 'Ana Torres' },
        { id: BEA, tenantId: A, email: `bea-${stamp}@example.com`, name: 'Bea Alumna' },
        { id: CARLOS, tenantId: A, email: `carlos-${stamp}@example.com`, name: 'Carlos_100%' },
        { id: INTRUSO, tenantId: B, email: `intruso-${stamp}@example.com`, name: 'Intruso B' },
      ],
    });
    await admin.modCoursesCourse.createMany({
      data: [
        { id: COURSE, tenantId: A, slug: `torno-${stamp}`, title: 'Torno para principiantes' },
        { id: COURSE_B, tenantId: B, slug: `secreto-${stamp}`, title: 'Curso secreto de B' },
      ],
    });
    await admin.modBillingProduct.createMany({
      data: [
        {
          id: PRODUCT,
          tenantId: A,
          courseId: COURSE,
          stripeProductId: `prod_${stamp}`,
          stripePriceId: `price_${stamp}_a`,
          unitAmount: 4900,
        },
        {
          id: PRODUCT_B,
          tenantId: B,
          courseId: COURSE_B,
          stripeProductId: `prod_${stamp}_b`,
          stripePriceId: `price_${stamp}_b`,
          unitAmount: 9900,
        },
      ],
    });
    const order = (
      id: string,
      userId: string,
      status: 'COMPLETED' | 'REFUNDED' | 'PENDING',
      day: number,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      tenantId: A,
      userId,
      productId: PRODUCT,
      courseId: COURSE,
      stripeSessionId: `cs_${id}`,
      stripePaymentIntentId: `pi_${id}`,
      status,
      amountPaid: 4900,
      currency: 'eur',
      customerEmail: null,
      completedAt: status === 'PENDING' ? null : at(day),
      ...extra,
    });
    await admin.modBillingOrder.createMany({
      data: [
        order(O_TRANSFERRED, ANA, 'COMPLETED', 10, {
          customerCountry: 'PT',
          customerEmail: `ana.pago-${stamp}@example.com`,
        }),
        order(O_REFUNDED, BEA, 'REFUNDED', 11, { refundedAt: at(12), customerCountry: 'ES' }),
        order(O_HELD, CARLOS, 'COMPLETED', 12, { discountAmount: 500, amountPaid: 4400 }),
        order(O_DISPUTED, BEA, 'COMPLETED', 13),
        order(O_PENDING, ANA, 'PENDING', 14),
        {
          ...order(O_B, INTRUSO, 'COMPLETED', 14),
          tenantId: B,
          productId: PRODUCT_B,
          courseId: COURSE_B,
          amountPaid: 9900,
        },
      ],
    });
    await admin.modSubscriptionsPlan.create({
      data: { id: PLAN, tenantId: A, name: 'Club mensual', intervalMonths: 1, amountCents: 1900 },
    });
    await admin.modSubscriptionsSubscription.create({
      data: {
        id: SUB,
        tenantId: A,
        userId: ANA,
        planId: PLAN,
        stripeSubscriptionId: `sub_${stamp}`,
        stripeCustomerId: `cus_${stamp}`,
        stripePriceId: `price_plan_${stamp}`,
        status: 'ACTIVE',
        unitAmount: 1900,
        interval: 'month',
        customerCountry: 'FR',
      },
    });
    const invoice = (id: string, status: 'PAID' | 'OPEN', amount: number, day: number) => ({
      id,
      tenantId: A,
      subscriptionId: SUB,
      stripeInvoiceId: `in_${id}`,
      status,
      amount,
      currency: 'eur',
      creditAppliedCents: amount === 1400 ? 500 : 0,
      hostedInvoiceUrl: `https://invoice.stripe.com/i/${id}`,
      paidAt: status === 'PAID' ? at(day, 9) : null,
      periodStart: at(day, 0),
      periodEnd: new Date(at(day, 0).getTime() + 30 * 86_400_000),
    });
    await admin.modSubscriptionsInvoice.createMany({
      data: [
        invoice(I_PAID, 'PAID', 1400, 15),
        invoice(I_OPEN, 'OPEN', 1900, 16),
        invoice(I_ZERO, 'PAID', 0, 9),
      ],
    });

    // El reparto de la plataforma (lo que deja `mod.payouts`).
    for (const [id, tenantId, acct] of [
      [ACCOUNT_A, A, 'a'],
      [ACCOUNT_B, B, 'b'],
    ] as const) {
      await admin.modPayoutsAccount.create({
        data: {
          id,
          tenantId,
          stripeAccountId: `acct_ventas_${acct}_${stamp}`,
          country: 'ES',
          entityType: 'individual',
          status: 'READY',
          readyAt: new Date(),
        },
      });
    }
    const payout = (
      id: string,
      sourceKind: 'ORDER' | 'SUBSCRIPTION_INVOICE',
      sourceRef: string,
      status: 'TRANSFERRED' | 'HELD' | 'READY',
      day: number,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      tenantId: A,
      accountId: ACCOUNT_A,
      sourceKind,
      sourceRef,
      description: 'venta',
      stripeChargeId: `ch_${id}`,
      presentmentAmount: 4900,
      presentmentCurrency: 'eur',
      gross: 4900,
      stripeFee: 179,
      feeBpsApplied: 500,
      platformFee: 245,
      creatorNet: 4476,
      transferAmount: 4476,
      currency: 'eur',
      status,
      chargedAt: at(day),
      ...extra,
    });
    await admin.modPayoutsSale.createMany({
      data: [
        payout(P_TRANSFERRED, 'ORDER', O_TRANSFERRED, 'TRANSFERRED', 10, {
          transferredAt: at(11),
          // Con Adaptive Pricing pagó en su moneda.
          presentmentAmount: 5200,
          presentmentCurrency: 'chf',
        }),
        payout(P_HELD, 'ORDER', O_HELD, 'HELD', 12, {
          presentmentAmount: 4400,
          gross: 4400,
          lastError: 'tax_profile_incomplete',
        }),
        payout(P_DISPUTED, 'ORDER', O_DISPUTED, 'TRANSFERRED', 13),
        payout(P_INVOICE, 'SUBSCRIPTION_INVOICE', `in_${I_PAID}`, 'READY', 15, {
          presentmentAmount: 1400,
          gross: 1400,
          stripeFee: 46,
          platformFee: 95,
          creatorNet: 1259,
          transferAmount: 1259,
          customerCreditApplied: 500,
        }),
      ],
    });
    await admin.modPayoutsDispute.create({
      data: {
        tenantId: A,
        saleId: P_DISPUTED,
        stripeDisputeId: `dp_${stamp}`,
        status: 'needs_response',
        amount: 4900,
        currency: 'eur',
      },
    });

    // Bea trajo la compra de Carlos (referidos de una compra suelta).
    const referral = await admin.modReferralsReferral.create({
      data: {
        tenantId: A,
        referrerUserId: BEA,
        referredUserId: CARLOS,
        code: `bea${stamp}`,
        orderId: O_HELD,
      },
    });
    await admin.modReferralsCommission.create({
      data: {
        tenantId: A,
        referralId: referral.id,
        referrerUserId: BEA,
        stripeInvoiceId: `order:${O_HELD}`,
        baseAmountCents: 4400,
        amountCents: 1320,
        commissionBps: 3000,
        approveAfter: new Date(Date.now() + 86_400_000),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await admin?.modPayoutsAccount.updateMany({
      where: { tenantId: { in: [A, B] } },
      data: { closedAt: new Date(), status: 'DISCONNECTED' },
    });
    await closeModule?.();
    await admin?.$disconnect();
  });

  it('corre como didacta_app (sin saltarse la RLS)', async () => {
    const [who] = await prisma.$queryRaw<Array<{ u: string; bypass: boolean }>>`
      SELECT current_user AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`;
    expect(who).toEqual({ u: 'didacta_app', bypass: false });
  });

  it('todas las ventas cobradas del aula, de la más reciente a la más antigua, con sus datos', async () => {
    const page = await ledger.list(A, {}, { page: 1, pageSize: 25 });
    expect(page.items.map((s) => s.id)).toEqual([
      `invoice:${I_PAID}`,
      `order:${O_DISPUTED}`,
      `order:${O_HELD}`,
      `order:${O_REFUNDED}`,
      `order:${O_TRANSFERRED}`,
    ]);
    expect(page.total).toBe(5);
    const byId = new Map(page.items.map((s) => [s.id, s]));

    const ana = byId.get(`order:${O_TRANSFERRED}`)!;
    expect(ana.buyer).toEqual({
      userId: ANA,
      name: 'Ana Torres',
      email: `ana-${stamp}@example.com`,
      checkoutEmail: `ana.pago-${stamp}@example.com`,
      country: 'PT',
      deleted: false,
    });
    expect(ana.product).toMatchObject({
      kind: 'course',
      ref: `course:${COURSE}`,
      title: 'Torno para principiantes',
    });
    // Lo que pagó, en SU moneda; el reparto, en la de liquidación.
    expect([ana.amount, ana.currency]).toEqual([5200, 'chf']);
    expect(ana.settlement).toMatchObject({
      currency: 'eur',
      cardFee: 179,
      platformFee: 245,
      net: 4476,
    });
    expect(ana.status).toBe('transferred');

    expect(byId.get(`order:${O_REFUNDED}`)).toMatchObject({
      status: 'refunded',
      refundState: 'full',
      settlement: null,
      buyer: { name: 'Bea Alumna', country: 'ES' },
    });
    const carlos = byId.get(`order:${O_HELD}`)!;
    expect(carlos).toMatchObject({
      status: 'held',
      coupon: 500,
      referral: { referrerUserId: BEA, referrerName: 'Bea Alumna', commission: 1320 },
    });
    expect(byId.get(`order:${O_DISPUTED}`)!.status).toBe('disputed');
    const cuota = byId.get(`invoice:${I_PAID}`)!;
    expect(cuota).toMatchObject({
      kind: 'subscription',
      status: 'paid',
      amount: 1400,
      referralCredit: 500,
      buyer: { name: 'Ana Torres', country: 'FR' },
      product: {
        kind: 'membership',
        ref: `plan:${PLAN}`,
        title: 'Club mensual',
        intervalMonths: 1,
      },
    });
    // Por moneda, sin sumar francos y euros.
    expect(page.totals).toEqual(
      expect.arrayContaining([
        { currency: 'eur', count: 4, amount: 4900 + 4400 + 4900 + 1400 },
        { currency: 'chf', count: 1, amount: 5200 },
      ]),
    );
    expect(page.products.map((p) => p.ref).sort()).toEqual(
      [`course:${COURSE}`, `plan:${PLAN}`].sort(),
    );
  });

  it('un aula no ve NI UNA venta de otra (ni su curso, ni su comprador)', async () => {
    const a = await ledger.list(A, {}, { page: 1, pageSize: 100 });
    expect(a.items.some((s) => s.id === `order:${O_B}`)).toBe(false);
    expect(JSON.stringify(a)).not.toContain('Intruso B');
    expect(JSON.stringify(a)).not.toContain('Curso secreto de B');
    const b = await ledger.list(B, {}, { page: 1, pageSize: 100 });
    expect(b.items.map((s) => s.id)).toEqual([`order:${O_B}`]);
    expect(b.items[0]!.buyer.name).toBe('Intruso B');
    // El detalle de una venta ajena es un 404, igual que una que no existe.
    await expect(ledger.detail(A, `order:${O_B}`)).rejects.toMatchObject({ status: 404 });
    await expect(ledger.detail(A, `order:${randomUUID()}`)).rejects.toMatchObject({ status: 404 });
    await expect(ledger.detail(A, 'order:no-es-un-id')).rejects.toMatchObject({ status: 404 });
    // Ni exportando.
    const all = await ledger.all(A, {});
    expect(all.rows.map((r) => r.id)).not.toContain(`order:${O_B}`);
  });

  it('filtros: estado, producto, fechas y búsqueda (comodines escapados)', async () => {
    const ids = async (f: Parameters<SalesLedgerService['list']>[1]) =>
      (await ledger.list(A, f, { page: 1, pageSize: 25 })).items.map((s) => s.id);
    expect(await ids({ status: 'refunded' })).toEqual([`order:${O_REFUNDED}`]);
    expect(await ids({ status: 'held' })).toEqual([`order:${O_HELD}`]);
    expect(await ids({ status: 'disputed' })).toEqual([`order:${O_DISPUTED}`]);
    expect(await ids({ status: 'transferred' })).toEqual([`order:${O_TRANSFERRED}`]);
    expect(await ids({ status: 'paid' })).toEqual([`invoice:${I_PAID}`]);
    expect(await ids({ product: `plan:${PLAN}` })).toEqual([`invoice:${I_PAID}`]);
    expect((await ids({ product: `course:${COURSE}` })).length).toBe(4);
    expect(await ids({ from: at(11, 0), to: at(13, 0) })).toEqual([
      `order:${O_HELD}`,
      `order:${O_REFUNDED}`,
    ]);
    expect(await ids({ q: 'TORRES' })).toEqual([`invoice:${I_PAID}`, `order:${O_TRANSFERRED}`]);
    expect(await ids({ q: `bea-${stamp}@example` })).toEqual([
      `order:${O_DISPUTED}`,
      `order:${O_REFUNDED}`,
    ]);
    // Por el correo del pago (distinto del de su cuenta) también se encuentra.
    expect(await ids({ q: 'ana.pago' })).toEqual([`order:${O_TRANSFERRED}`]);
    expect(await ids({ q: 'club mensual' })).toEqual([`invoice:${I_PAID}`]);
    // «%» es un carácter, no un comodín: solo Carlos lo lleva en el nombre.
    expect(await ids({ q: '100%' })).toEqual([`order:${O_HELD}`]);
    expect(await ids({ q: '%' })).toEqual([`order:${O_HELD}`]);
    expect(await ids({ q: 'nadie-se-llama-asi' })).toEqual([]);
  });

  it('paginación con el total de lo filtrado', async () => {
    const p2 = await ledger.list(A, {}, { page: 2, pageSize: 2 });
    expect(p2.items.map((s) => s.id)).toEqual([`order:${O_HELD}`, `order:${O_REFUNDED}`]);
    expect(p2.total).toBe(5);
    const beyond = await ledger.list(A, {}, { page: 9, pageSize: 2 });
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(5);
  });

  it('detalle: la historia, la venta de «Tus ventas» y la factura de una cuota', async () => {
    const d = await ledger.detail(A, `order:${O_TRANSFERRED}`);
    expect(d.payout).toMatchObject({ id: P_TRANSFERRED, status: 'TRANSFERRED', canRefund: true });
    expect(d.events.map((e) => e.type)).toEqual(['paid', 'transferred']);
    expect(d.events[1]).toMatchObject({ amount: 4476, currency: 'eur' });

    const disputed = await ledger.detail(A, `order:${O_DISPUTED}`);
    expect(disputed.payout).toMatchObject({ disputeOpen: true, canRefund: false });
    expect(disputed.events.map((e) => e.type)).toEqual(['paid', 'dispute_opened']);

    const refunded = await ledger.detail(A, `order:${O_REFUNDED}`);
    expect(refunded.payout).toBeNull();
    expect(refunded.events.map((e) => e.type)).toEqual(['paid', 'refunded']);

    const cuota = await ledger.detail(A, `invoice:${I_PAID}`);
    expect(cuota.hostedInvoiceUrl).toBe(`https://invoice.stripe.com/i/${I_PAID}`);
    expect(cuota.period?.start).toBe(at(15, 0).toISOString());
  });
});
