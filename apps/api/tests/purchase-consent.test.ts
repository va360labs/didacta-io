/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Renuncia al desistimiento antes de pagar contenido digital (art. 103.m
 * TRLGDCU): el texto, que sin la casilla NO se puede pagar (ni el curso suelto
 * ni la membresía), que la prueba se guarda con texto, versión, idioma, IP y
 * sesión de pago, y la confirmación por correo con el texto aceptado, una
 * sola vez. Contra Postgres real (RLS y el trigger que congela la prueba):
 * `tests/integration/purchase-consent.integration.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import { BillingPublicController } from '../src/modules/billing/billing-public.controller';
import {
  PurchaseConsentService,
  purchaseConfirmationTexts,
} from '../src/modules/purchase-consent/purchase-consent.service';
import {
  WITHDRAWAL_WAIVER_VERSION,
  renderWithdrawalWaiver,
  waiverLang,
} from '../src/modules/purchase-consent/withdrawal-waiver';
import { MembershipPublicController } from '../src/modules/subscriptions/membership-public.controller';

const TENANT = '11111111-1111-4111-8111-111111111111';
const COURSE = '22222222-2222-4222-8222-222222222222';
const PLAN = '33333333-3333-4333-8333-333333333333';

function fakePrisma() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    tenant: {
      findUnique: vi.fn(async () => ({ name: 'Academia Luz', signupsFrozenAt: null })),
    },
    purchaseConsent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `pc_${rows.length + 1}`, paidAt: null, ...data };
        rows.push(row);
        return { id: row.id };
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const matches = rows.filter((r) =>
            Object.entries(where).every(([k, v]) => (v === null ? r[k] == null : r[k] === v)),
          );
          for (const r of matches) Object.assign(r, data);
          return { count: matches.length };
        },
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null;
      }),
    },
    modCoursesCourse: {
      findFirst: vi.fn(async () => ({ status: 'PUBLISHED', title: 'Fotografía nocturna' })),
    },
  };
}

function service(prisma: ReturnType<typeof fakePrisma>, smtp?: { send: ReturnType<typeof vi.fn> }) {
  const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() };
  return new PurchaseConsentService(
    prisma as never,
    logger as never,
    { resolveTenantWebBaseUrlForBackground: async () => 'https://luz.test' } as never,
    smtp ? ({ resolve: async () => ({ config: { from: 'aula@luz.test' } }) } as never) : undefined,
    smtp as never,
  );
}

const req = (extra: Record<string, unknown> = {}) =>
  ({
    headers: { host: 'luz.test', 'user-agent': 'Prueba/1.0', cookie: 'NEXT_LOCALE=es' },
    ip: '203.0.113.7',
    ...extra,
  }) as never;

describe('texto de la casilla', () => {
  it('español y en llano, con el vendedor; inglés para el resto de idiomas', () => {
    const es = renderWithdrawalWaiver({
      purchaseKind: 'course',
      locale: 'es',
      sellerName: ' Academia  Luz ',
    });
    expect(es).toMatchObject({
      version: WITHDRAWAL_WAIVER_VERSION,
      locale: 'es',
      statement:
        'Quiero acceder al curso ahora mismo. Entiendo que, al empezar ya, pierdo el derecho a desistir de la compra en 14 días.',
      sellerLine: 'Vende: Academia Luz.',
    });
    expect(es.text).toBe(`${es.statement} Vende: Academia Luz.`);
    const en = renderWithdrawalWaiver({
      purchaseKind: 'membership',
      locale: 'en-GB',
      sellerName: 'Luz',
    });
    expect(en.statement).toMatch(/lose my right to withdraw from this subscription within 14 days/);
    expect(en.sellerLine).toBe('Sold by Luz.');
    expect(waiverLang(undefined)).toBe('es');
    expect(waiverLang('es-419')).toBe('es');
    expect(waiverLang('pt-BR')).toBe('en');
  });

  it('el correo de confirmación repite el texto aceptado, la fecha y el vendedor', () => {
    const texts = purchaseConfirmationTexts({
      lang: 'es',
      tenantName: 'Academia Luz',
      itemName: 'Fotografía nocturna',
      purchaseKind: 'course',
      trial: false,
      acceptedAt: new Date('2026-11-12T16:05:00Z'),
      text: 'TEXTO ACEPTADO',
      version: WITHDRAWAL_WAIVER_VERSION,
      sellerLegal: 'Ana Pérez',
    });
    expect(texts.subject).toBe('Confirmación de tu compra en Academia Luz');
    expect(texts.body).toContain('«TEXTO ACEPTADO»');
    expect(texts.body).toContain('12 de noviembre de 2026');
    expect(texts.body).toContain('17:05');
    expect(texts.body).toContain('Nombre fiscal del vendedor: Ana Pérez.');
    expect(texts.body).toContain('no hay plazo de 14 días para desistir');
  });
});

describe('sin la casilla no se paga', () => {
  function publicController(prisma: ReturnType<typeof fakePrisma>) {
    const billing = {
      startCheckout: vi.fn(async () => ({
        orderId: 'ord-1',
        sessionId: 'cs_test_1',
        url: 'https://stripe/cs_test_1',
      })),
    };
    const controller = new BillingPublicController(
      { getBillingService: () => billing } as never,
      {
        resolveByHost: async () => ({ id: TENANT }),
        resolveTenantWebBaseUrl: async () => 'https://luz.test',
      } as never,
      prisma as never,
      service(prisma),
    );
    return { controller, billing };
  }

  it('curso: sin casilla → 422 y no se crea ni orden ni sesión; con un texto viejo → 409', async () => {
    const prisma = fakePrisma();
    const { controller, billing } = publicController(prisma);
    await expect(controller.checkout(req(), COURSE, {})).rejects.toMatchObject({
      status: 422,
      response: { code: 'CHECKOUT_WITHDRAWAL_WAIVER_REQUIRED' },
    });
    await expect(
      controller.checkout(req(), COURSE, {
        withdrawalWaiver: { accepted: true, version: '2020-01-01', locale: 'es' },
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'CHECKOUT_WITHDRAWAL_WAIVER_OUTDATED' },
    });
    expect(billing.startCheckout).not.toHaveBeenCalled();
    expect(prisma.rows).toHaveLength(0);
  });

  it('curso: con la casilla, la prueba guarda texto, versión, idioma, IP, navegador y la sesión de pago', async () => {
    const prisma = fakePrisma();
    const { controller, billing } = publicController(prisma);
    const result = await controller.checkout(req(), COURSE, {
      email: 'Comprador@Example.com',
      withdrawalWaiver: { accepted: true, version: WITHDRAWAL_WAIVER_VERSION, locale: 'es' },
    });
    expect(result).toEqual({ url: 'https://stripe/cs_test_1', sessionId: 'cs_test_1' });
    expect(billing.startCheckout).toHaveBeenCalledOnce();
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]).toMatchObject({
      tenantId: TENANT,
      kind: 'withdrawal_waiver',
      purchaseKind: 'course',
      itemRef: COURSE,
      itemName: 'Fotografía nocturna',
      buyerEmail: 'comprador@example.com',
      sellerName: 'Academia Luz',
      paymentMode: 'own',
      version: WITHDRAWAL_WAIVER_VERSION,
      locale: 'es',
      text: renderWithdrawalWaiver({
        purchaseKind: 'course',
        locale: 'es',
        sellerName: 'Academia Luz',
      }).text,
      ip: '203.0.113.7',
      userAgent: 'Prueba/1.0',
      stripeCheckoutSessionId: 'cs_test_1',
      orderId: 'ord-1',
    });
    expect(prisma.rows[0]!['acceptedAt']).toBeInstanceOf(Date);
  });

  it('membresía: igual (422 sin casilla; con ella, prueba con el nombre del plan)', async () => {
    const prisma = fakePrisma();
    const membership = {
      getPublicPage: async () => ({ plans: [{ id: PLAN, name: 'Plan anual' }] }),
      startMembershipCheckout: vi.fn(async () => ({
        url: 'https://stripe/cs_test_m',
        sessionId: 'cs_test_m',
      })),
    };
    const controller = new MembershipPublicController(
      { getMembershipService: () => membership } as never,
      {
        resolveByHost: async () => ({ id: TENANT }),
        resolveTenantWebBaseUrl: async () => 'https://luz.test',
      } as never,
      service(prisma),
    );
    await expect(controller.checkout(req(), { planId: PLAN })).rejects.toMatchObject({
      response: { code: 'CHECKOUT_WITHDRAWAL_WAIVER_REQUIRED' },
    });
    expect(membership.startMembershipCheckout).not.toHaveBeenCalled();
    await controller.checkout(req(), {
      planId: PLAN,
      withdrawalWaiver: { accepted: true, version: WITHDRAWAL_WAIVER_VERSION, locale: 'en' },
    });
    expect(prisma.rows[0]).toMatchObject({
      purchaseKind: 'membership',
      itemName: 'Plan anual',
      locale: 'en',
      stripeCheckoutSessionId: 'cs_test_m',
    });
    expect(String(prisma.rows[0]!['text'])).toMatch(/^I want to access the membership right now/);
  });
});

describe('confirmación por correo al pagar', () => {
  const completed = (payment_status: string) =>
    ({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_1',
          payment_status,
          customer_details: { email: 'Confirmado@Example.com' },
        },
      },
    }) as never;

  it('pagado → marca el pago y manda UNA vez el correo con el texto aceptado; sin pagar, nada', async () => {
    const prisma = fakePrisma();
    const smtp = { send: vi.fn(async () => ({ ok: true })) };
    const consents = service(prisma, smtp);
    const id = await consents.accept({
      req: req(),
      tenantId: TENANT,
      purchaseKind: 'course',
      itemRef: COURSE,
      itemName: 'Fotografía nocturna',
      waiver: { accepted: true, version: WITHDRAWAL_WAIVER_VERSION, locale: 'es' },
    });
    await consents.attachSession(TENANT, id, { sessionId: 'cs_test_1', orderId: 'ord-1' });

    await consents.confirmCheckout(TENANT, completed('unpaid'));
    expect(smtp.send).not.toHaveBeenCalled();

    await consents.confirmCheckout(TENANT, completed('paid'));
    await consents.confirmCheckout(TENANT, completed('paid'));
    expect(smtp.send).toHaveBeenCalledOnce();
    const mail = (
      smtp.send.mock.calls[0] as unknown as [unknown, { to: string; subject: string; text: string }]
    )[1];
    expect(mail.to).toBe('confirmado@example.com');
    expect(mail.subject).toBe('Confirmación de tu compra en Academia Luz');
    expect(mail.text).toContain(String(prisma.rows[0]!['text']));
    expect(prisma.rows[0]).toMatchObject({ buyerEmail: 'confirmado@example.com' });
    expect(prisma.rows[0]!['paidAt']).toBeInstanceOf(Date);
    expect(prisma.rows[0]!['confirmationSentAt']).toBeInstanceOf(Date);
  });

  it('una sesión sin consentimiento (de otro módulo o anterior a esto) no hace nada ni lanza', async () => {
    const prisma = fakePrisma();
    const smtp = { send: vi.fn(async () => ({ ok: true })) };
    await expect(
      service(prisma, smtp).confirmCheckout(TENANT, completed('paid')),
    ).resolves.toBeUndefined();
    expect(smtp.send).not.toHaveBeenCalled();
  });
});
