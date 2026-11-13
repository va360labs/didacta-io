/**
 * Prueba de la renuncia al desistimiento contra un Postgres REAL, como el
 * runtime de producción (`didacta_app`, RLS forzada): se guarda en el aula
 * del comprador y nadie más la ve; el texto aceptado, la versión, la fecha y
 * la IP NO se pueden reescribir (trigger de `rls.sql`); la sesión de pago se
 * asocia una sola vez; y la confirmación marca el pago una sola vez.
 *
 * REQUISITOS: los de `rls-isolation-didacta-app.integration.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PurchaseConsentService } from '../../src/modules/purchase-consent/purchase-consent.service';
import { WITHDRAWAL_WAIVER_VERSION } from '../../src/modules/purchase-consent/withdrawal-waiver';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runAsTenant } from '../../src/tenancy/tenant-context.storage';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

describeWithDb('Renuncia al desistimiento — Postgres real como didacta_app', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let consents: PurchaseConsentService;
  const smtp = { send: vi.fn(async () => ({ ok: true })) };
  const A = randomUUID();
  const B = randomUUID();
  const stamp = Date.now();

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
        [A, 'Academia A'],
        [B, 'Academia B'],
      ] as const) {
        await admin.tenant.create({ data: { id, slug: `pc-${id.slice(0, 8)}-${stamp}`, name } });
      }
      consents = new PurchaseConsentService(
        prisma,
        { warn: vi.fn(), log: vi.fn(), error: vi.fn() } as never,
        { resolveTenantWebBaseUrlForBackground: async () => 'https://a.test' } as never,
        { resolve: async () => ({ config: { from: 'aula@a.test' } }) } as never,
        smtp as never,
      );
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

  const req = {
    headers: { host: 'a.test', 'user-agent': 'Integracion/1.0' },
    ip: '198.51.100.4',
  } as never;

  it('se guarda en el aula del comprador, solo ella la ve, y la prueba no se puede reescribir', async () => {
    const id = await runAsTenant(A, () =>
      consents.accept({
        req,
        tenantId: A,
        purchaseKind: 'course',
        itemRef: randomUUID(),
        itemName: 'Curso de prueba',
        waiver: { accepted: true, version: WITHDRAWAL_WAIVER_VERSION, locale: 'es' },
      }),
    );
    const sessionId = `cs_test_pc_${stamp}`;
    await consents.attachSession(A, id, { sessionId, orderId: randomUUID() });

    const row = await admin.purchaseConsent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      tenantId: A,
      sellerName: 'Academia A',
      ip: '198.51.100.4',
      userAgent: 'Integracion/1.0',
      stripeCheckoutSessionId: sessionId,
      locale: 'es',
    });
    expect(row.text).toMatch(/^Quiero acceder al curso ahora mismo\./);

    // RLS: desde el aula B no existe.
    const fromB = await runAsTenant(B, () => prisma.purchaseConsent.findMany({ where: { id } }));
    expect(fromB).toEqual([]);

    // La prueba está congelada, incluso para el dueño de la tabla.
    await expect(
      admin.purchaseConsent.update({ where: { id }, data: { text: 'otro texto' } }),
    ).rejects.toThrow(/no se puede reescribir/);
    await expect(
      admin.purchaseConsent.update({ where: { id }, data: { acceptedAt: new Date(0) } }),
    ).rejects.toThrow(/no se puede reescribir/);
    await expect(
      admin.purchaseConsent.update({
        where: { id },
        data: { stripeCheckoutSessionId: 'cs_test_otra' },
      }),
    ).rejects.toThrow(/ya estaba asociada/);

    // El pago se marca y se confirma una sola vez.
    const event = {
      id: `evt_pc_${stamp}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          payment_status: 'paid',
          customer_details: { email: 'alumna@example.test' },
        },
      },
    } as never;
    await consents.confirmCheckout(A, event);
    await consents.confirmCheckout(A, event);
    expect(smtp.send).toHaveBeenCalledTimes(1);
    const after = await admin.purchaseConsent.findUniqueOrThrow({ where: { id } });
    expect(after.paidAt).toBeInstanceOf(Date);
    expect(after.confirmationSentAt).toBeInstanceOf(Date);
    expect(after.buyerEmail).toBe('alumna@example.test');

    // El webhook de OTRA aula con esa sesión no la toca (RLS).
    await consents.confirmCheckout(B, { ...(event as object), id: 'evt_otro' } as never);
    expect(smtp.send).toHaveBeenCalledTimes(1);
  });
});
