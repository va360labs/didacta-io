/**
 * Correos de VENTA contra un Postgres REAL conectando como el runtime de
 * producción (`didacta_app`, RLS forzada):
 *
 *  - el recibo de una compra reúne de verdad los datos del aula (curso con
 *    portada, cuenta del comprador, prueba del consentimiento, plantilla
 *    personalizada) y sale UNA vez;
 *  - el recibo de una renovación y el aviso de cobro fallido salen UNA vez por
 *    factura (y por intento) aunque Stripe reentregue el evento: el sello
 *    `sale_email_sent` es del aula, otra aula no lo ve ni lo pisa.
 *
 * REQUISITOS: los de `rls-isolation-didacta-app.integration.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PurchaseConsentService } from '../../src/modules/purchase-consent/purchase-consent.service';
import { WITHDRAWAL_WAIVER_VERSION } from '../../src/modules/purchase-consent/withdrawal-waiver';
import { SaleEmailsService } from '../../src/modules/sale-emails/sale-emails.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runAsTenant } from '../../src/tenancy/tenant-context.storage';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

describeWithDb('Correos de venta — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let emails: SaleEmailsService;
  let consents: PurchaseConsentService;
  const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
  const smtp = {
    send: vi.fn(
      async (_c: unknown, m: { to: string; subject: string; text: string; html: string }) => {
        sent.push(m);
        return { ok: true };
      },
    ),
  };
  const passwordReset = { request: vi.fn(async () => ({ rawToken: 'token-de-prueba' })) };
  const A = randomUUID();
  const B = randomUUID();
  const stamp = Date.now();
  const COURSE = randomUUID();
  const PLAN = randomUUID();
  const SUB = `sub_integ_${stamp}`;
  const buyer = `comprador-${stamp}@example.com`;
  const member = `socia-${stamp}@example.com`;

  beforeAll(async () => {
    const prepared = await prepareDidactaAppRole();
    admin = prepared.admin;
    const previous = { url: process.env['DATABASE_URL'], mode: process.env['RLS_ENFORCEMENT'] };
    process.env['DATABASE_URL'] = prepared.appUrl;
    process.env['RLS_ENFORCEMENT'] = 'on';
    try {
      const moduleRef = await Test.createTestingModule({ imports: [PrismaModule] }).compile();
      await moduleRef.init();
      prisma = moduleRef.get(PrismaService);
      closeModule = () => moduleRef.close();
      for (const [id, name] of [
        [A, 'Primer Sorbo'],
        [B, 'Otra Aula'],
      ] as const) {
        await admin.tenant.create({ data: { id, slug: `ce-${id.slice(0, 8)}-${stamp}`, name } });
      }
      await admin.modCoursesCourse.create({
        data: {
          id: COURSE,
          tenantId: A,
          slug: `cafe-${stamp}`,
          title: 'Iniciación al café de especialidad',
          thumbnailUrl: 'https://cdn.example.com/cafe.jpg',
          status: 'PUBLISHED',
        },
      });
      await admin.user.create({
        data: { tenantId: A, email: buyer, name: 'Ana García', status: 'ACTIVE', locale: 'es-ES' },
      });
      const socia = await admin.user.create({
        data: {
          tenantId: A,
          email: member,
          name: 'Beatriz Souza',
          status: 'ACTIVE',
          locale: 'pt-BR',
          lastLoginAt: new Date(),
        },
      });
      await admin.modSubscriptionsPlan.create({
        data: {
          id: PLAN,
          tenantId: A,
          name: 'Clube do café',
          intervalMonths: 1,
          amountCents: 1900,
          currency: 'eur',
        },
      });
      await admin.modSubscriptionsSubscription.create({
        data: {
          tenantId: A,
          userId: socia.id,
          planId: PLAN,
          stripeSubscriptionId: SUB,
          stripeCustomerId: `cus_integ_${stamp}`,
          stripePriceId: `price_integ_${stamp}`,
          status: 'ACTIVE',
          unitAmount: 1900,
          currency: 'eur',
          interval: 'month',
          currentPeriodEnd: new Date('2027-01-14T09:30:00Z'),
          gracePeriodEndsAt: new Date('2026-12-17T09:30:00Z'),
        },
      });
      // Lo que la creadora escribió para el recibo (en español).
      await admin.notificationTemplate.create({
        data: {
          tenantId: A,
          key: 'purchase.receipt',
          channel: 'EMAIL',
          locale: 'es-ES',
          subject: 'Ya eres de {academia}, {nombre}',
          body: 'Gracias por apoyar {academia}.',
        },
      });
      const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() } as never;
      emails = new SaleEmailsService(
        prisma,
        logger,
        {
          resolveTenantWebBaseUrlForBackground: async () => 'https://primersorbo.example.com',
        } as never,
        {
          resolve: async () => ({
            config: {
              from: 'aulas@didacta.example.com',
              sender: { replyTo: 'hola@primersorbo.example.com' },
            },
            source: 'global',
          }),
        } as never,
        smtp as never,
        passwordReset as never,
      );
      consents = new PurchaseConsentService(prisma, logger, undefined, emails);
    } finally {
      process.env['DATABASE_URL'] = previous.url;
      if (previous.mode === undefined) delete process.env['RLS_ENFORCEMENT'];
      else process.env['RLS_ENFORCEMENT'] = previous.mode;
    }
  }, 90_000);

  afterAll(async () => {
    await closeModule?.();
    await admin?.$disconnect();
  });

  it('el recibo de una compra: datos reales del aula, la plantilla de la creadora y el acceso, una vez', async () => {
    const req = {
      headers: { host: 'a.test', 'user-agent': 'Integracion/1.0' },
      ip: '198.51.100.4',
    } as never;
    const id = await runAsTenant(A, () =>
      consents.accept({
        req,
        tenantId: A,
        purchaseKind: 'course',
        itemRef: COURSE,
        itemName: 'Iniciación al café de especialidad',
        buyerEmail: buyer,
        waiver: { accepted: true, version: WITHDRAWAL_WAIVER_VERSION, locale: 'es' },
      }),
    );
    const orderId = randomUUID();
    const sessionId = `cs_test_ce_${stamp}`;
    await runAsTenant(A, () => consents.attachSession(A, id, { sessionId, orderId }));
    const event = {
      id: `evt_ce_${stamp}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          mode: 'payment',
          payment_status: 'paid',
          amount_subtotal: 4900,
          amount_total: 4900,
          currency: 'eur',
          total_details: { amount_discount: 0, amount_tax: 0 },
          customer_details: { email: buyer, name: 'Ana García' },
          created: Math.floor(Date.now() / 1000),
        },
      },
    } as never;
    expect(await consents.receiptPending(A, event)).toBe(true);
    await consents.afterStripeEvent(A, event);
    await consents.afterStripeEvent(A, event);
    expect(await consents.receiptPending(A, event)).toBe(false);
    const toBuyer = sent.filter((m) => m.to === buyer);
    expect(toBuyer).toHaveLength(1);
    const mail = toBuyer[0]!;
    const ref = orderId.replace(/-/g, '').slice(-8).toUpperCase();
    expect(mail.subject).toBe('Ya eres de Primer Sorbo, Ana');
    expect(mail.text).toContain('Gracias por apoyar Primer Sorbo.');
    expect(mail.text).toContain(`Pedido: ${ref}`);
    expect(mail.text).toContain('Iniciación al café de especialidad');
    expect(mail.text).toContain('Contacto: hola@primersorbo.example.com');
    expect(mail.text).toContain(
      `Elige tu contraseña y entra: https://primersorbo.example.com/reset-password?token=token-de-prueba&next=%2Fcourses%2Fcafe-${stamp}`,
    );
    expect(mail.html).toContain('src="https://cdn.example.com/cafe.jpg"');
    // La prueba quedó marcada como confirmada por correo.
    const row = await admin.purchaseConsent.findUniqueOrThrow({ where: { id } });
    expect(row.confirmationSentAt).toBeInstanceOf(Date);
  });

  const invoice = (type: string, attempt: number) =>
    ({
      id: `evt_inv_${type}_${attempt}_${stamp}`,
      type,
      created: Math.floor(new Date('2026-12-14T09:30:00Z').getTime() / 1000),
      data: {
        object: {
          id: `in_integ_${stamp}`,
          billing_reason: 'subscription_cycle',
          subscription: SUB,
          currency: 'eur',
          amount_paid: type === 'invoice.paid' ? 1900 : 0,
          amount_due: 1900,
          subtotal: 1900,
          total: 1900,
          attempt_count: attempt,
          lines: {
            data: [
              { period: { end: Math.floor(new Date('2027-01-14T09:30:00Z').getTime() / 1000) } },
            ],
          },
        },
      },
    }) as never;

  it('renovación y cobro fallido: en el idioma de la socia, una vez por factura e intento, sellado en SU aula', async () => {
    await emails.onInvoiceEvent(A, invoice('invoice.payment_failed', 1));
    await emails.onInvoiceEvent(A, invoice('invoice.payment_failed', 1));
    await emails.onInvoiceEvent(A, invoice('invoice.paid', 1));
    await emails.onInvoiceEvent(A, invoice('invoice.paid', 1));
    const toMember = sent.filter((m) => m.to === member);
    expect(toMember.map((m) => m.subject)).toEqual([
      'Não conseguimos cobrar sua assinatura de “Clube do café”',
      'Recibo da sua assinatura de “Clube do café”',
    ]);
    expect(toMember[0]!.text).toContain('antes de 17 de dezembro de 2026');
    expect(toMember[1]!.text).toContain('Próxima renovação: 14 de janeiro de 2027.');

    // Los sellos son del aula A: desde B no se ven…
    const seenFromB = await runAsTenant(B, () =>
      prisma.saleEmailSent.findMany({ where: { ref: { startsWith: `in_integ_${stamp}` } } }),
    );
    expect(seenFromB).toEqual([]);
    const all = await admin.saleEmailSent.findMany({
      where: { ref: { startsWith: `in_integ_${stamp}` } },
      orderBy: { kind: 'asc' },
    });
    expect(all.map((r) => [r.tenantId, r.kind, r.ref])).toEqual([
      [A, 'payment_failed', `in_integ_${stamp}:1`],
      [A, 'renewal_receipt', `in_integ_${stamp}`],
    ]);
    // …y el mismo id de factura en B (sin su suscripción) no escribe nada a nadie.
    const before = sent.length;
    await emails.onInvoiceEvent(B, invoice('invoice.paid', 1));
    expect(sent.length).toBe(before);
  });
});
