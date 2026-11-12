/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * «Tus invitados» (GET /modules/referrals/me/invitees) contra Postgres REAL
 * conectando como `didacta_app` (NOSUPERUSER, NOBYPASSRLS):
 *  - el estado de cada invitado sale de filas reales de referidos,
 *    suscripciones y comisiones;
 *  - un alumno solo ve SUS invitados y solo de su aula (ni los de otro
 *    alumno ni los del aula B, ni siquiera pidiendo el tenant de B);
 *  - la respuesta no lleva correo ni nombre completo, solo iniciales.
 */

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@didacta/database';
import { ReferralsService } from '@didacta/mod-referrals';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { runAsTenant } from '../../src/tenancy/tenant-context.storage';
import { ADMIN_DATABASE_URL, prepareDidactaAppRole } from './helpers/didacta-app-db';

const describeWithDb = ADMIN_DATABASE_URL ? describe : describe.skip;

type SubStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'UNPAID' | 'CANCELED' | 'PENDING';

describeWithDb('Tus invitados — Postgres real como didacta_app (RLS forzada)', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let closeModule: () => Promise<void>;
  let service: ReferralsService;
  let tenantA: string;
  let tenantB: string;
  const stamp = Date.now();
  const users: Record<string, string> = {};
  const referralIds: Record<string, string> = {};

  async function createUser(tenantId: string, key: string, name: string | null) {
    const u = await admin.user.create({
      data: {
        tenantId,
        email: `${key}-${stamp}@example.test`,
        name,
        status: 'ACTIVE',
      },
    });
    users[key] = u.id;
    return u.id;
  }

  async function refer(
    tenantId: string,
    referrerKey: string,
    referredKey: string,
    opts: { attributedAt: string; orderId?: string } = { attributedAt: '2026-10-01' },
  ) {
    const r = await admin.modReferralsReferral.create({
      data: {
        tenantId,
        referrerUserId: users[referrerKey]!,
        referredUserId: users[referredKey]!,
        code: `c-${referrerKey}-${stamp}`,
        orderId: opts.orderId ?? null,
        attributedAt: new Date(opts.attributedAt),
      },
    });
    referralIds[referredKey] = r.id;
    return r.id;
  }

  async function subscribe(
    tenantId: string,
    userKey: string,
    status: SubStatus,
    createdAt: string,
  ) {
    await admin.modSubscriptionsSubscription.create({
      data: {
        tenantId,
        userId: users[userKey]!,
        planId: randomUUID(),
        stripeCustomerId: `cus_${userKey}`,
        stripePriceId: 'price_test',
        status,
        unitAmount: 2900,
        currency: 'eur',
        interval: 'month',
        createdAt: new Date(createdAt),
      },
    });
  }

  async function commission(
    tenantId: string,
    referrerKey: string,
    referredKey: string,
    amountCents: number,
    status: 'PENDING' | 'APPROVED' | 'PAID' | 'REVOKED',
    invoice: string,
  ) {
    await admin.modReferralsCommission.create({
      data: {
        tenantId,
        referralId: referralIds[referredKey]!,
        referrerUserId: users[referrerKey]!,
        stripeInvoiceId: `${invoice}-${stamp}`,
        baseAmountCents: amountCents * 5,
        amountCents,
        currency: 'eur',
        commissionBps: 2000,
        status,
        approveAfter: new Date('2026-12-01'),
      },
    });
  }

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

    tenantA = (
      await admin.tenant.create({
        data: { id: randomUUID(), slug: `invitados-a-${stamp}`, name: `invitados-a-${stamp}` },
      })
    ).id;
    tenantB = (
      await admin.tenant.create({
        data: { id: randomUUID(), slug: `invitados-b-${stamp}`, name: `invitados-b-${stamp}` },
      })
    ).id;

    // Aula A: la alumna «ana» invita a cinco personas; «otro» invita a una.
    await createUser(tenantA, 'ana', 'Ana Alumna');
    await createUser(tenantA, 'otro', 'Otro Alumno');
    await createUser(tenantA, 'paga', 'María Pérez Gil');
    await createUser(tenantA, 'prueba', 'jorge ruiz');
    await createUser(tenantA, 'curso', 'Álvaro Sanz');
    await createUser(tenantA, 'baja', 'Carmen López');
    await createUser(tenantA, 'nada', null);
    await createUser(tenantA, 'deOtro', 'Lucía Martín');
    // Aula B: otra alumna con su invitado.
    await createUser(tenantB, 'anaB', 'Beatriz Alumna');
    await createUser(tenantB, 'invB', 'Bruno Bravo');

    // Pagando: se dio de baja una vez y volvió (manda la más reciente).
    await refer(tenantA, 'ana', 'paga', { attributedAt: '2026-10-03' });
    await subscribe(tenantA, 'paga', 'CANCELED', '2026-08-01');
    await subscribe(tenantA, 'paga', 'ACTIVE', '2026-10-03');
    await commission(tenantA, 'ana', 'paga', 580, 'APPROVED', 'in_paga_1');
    await commission(tenantA, 'ana', 'paga', 580, 'PENDING', 'in_paga_2');
    await commission(tenantA, 'ana', 'paga', 300, 'REVOKED', 'in_paga_3');

    // En prueba: sin cobros todavía.
    await refer(tenantA, 'ana', 'prueba', { attributedAt: '2026-11-09' });
    await subscribe(tenantA, 'prueba', 'TRIALING', '2026-11-09');

    // Compró un curso suelto.
    await refer(tenantA, 'ana', 'curso', { attributedAt: '2026-10-20', orderId: randomUUID() });
    await commission(tenantA, 'ana', 'curso', 980, 'PENDING', 'order:curso');

    // Se dio de baja.
    await refer(tenantA, 'ana', 'baja', { attributedAt: '2026-09-02' });
    await subscribe(tenantA, 'baja', 'CANCELED', '2026-09-02');
    await commission(tenantA, 'ana', 'baja', 1820, 'PAID', 'in_baja_1');

    // Sin nombre y sin nada vivo (una suscripción que nunca se cerró).
    await refer(tenantA, 'ana', 'nada', { attributedAt: '2026-11-10' });
    await subscribe(tenantA, 'nada', 'PENDING', '2026-11-10');

    // De otro alumno del mismo aula.
    await refer(tenantA, 'otro', 'deOtro', { attributedAt: '2026-10-05' });
    await subscribe(tenantA, 'deOtro', 'ACTIVE', '2026-10-05');

    // Aula B.
    await refer(tenantB, 'anaB', 'invB', { attributedAt: '2026-10-07' });
    await subscribe(tenantB, 'invB', 'ACTIVE', '2026-10-07');

    // Servicio público real del módulo sobre el PrismaService de la app (RLS).
    service = new ReferralsService(
      prisma as never,
      { publish: async () => undefined } as never,
      (async () => null) as never,
    );
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      await admin.modReferralsCommission.deleteMany({ where: { tenantId: t } });
      await admin.modReferralsReferral.deleteMany({ where: { tenantId: t } });
      await admin.modSubscriptionsSubscription.deleteMany({ where: { tenantId: t } });
      await admin.user.deleteMany({ where: { tenantId: t } });
      await admin.tenant.delete({ where: { id: t } }).catch(() => undefined);
    }
    await admin?.$disconnect();
    await closeModule?.();
  });

  it('cada invitado con su estado, sus iniciales y lo que ha generado (sin anuladas)', async () => {
    const res = await runAsTenant(tenantA, () => service.memberInvitees(tenantA, users['ana']!));

    expect(res.payingNow).toBe(1);
    // Más reciente primero.
    expect(res.invitees.map((i) => [i.initials, i.state, i.generatedCents])).toEqual([
      ['·', 'joined', 0],
      ['JR', 'trial', 0],
      ['ÁS', 'bought_course', 980],
      ['MP', 'paying', 1160],
      ['CL', 'cancelled', 1820],
    ]);
    expect(res.invitees[1]!.joinedAt.toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(res.invitees.every((i) => i.currency === 'eur')).toBe(true);
  });

  it('nunca devuelve correo ni nombre completo', async () => {
    const res = await runAsTenant(tenantA, () => service.memberInvitees(tenantA, users['ana']!));
    const json = JSON.stringify(res);
    expect(json).not.toContain('@');
    expect(json).not.toContain('example.test');
    for (const name of ['María', 'Pérez', 'jorge', 'ruiz', 'Álvaro', 'Sanz', 'Carmen', 'López']) {
      expect(json).not.toContain(name);
    }
    // Ni ids de usuario del invitado.
    for (const key of ['paga', 'prueba', 'curso', 'baja', 'nada']) {
      expect(json).not.toContain(users[key]!);
    }
    expect(Object.keys(res.invitees[0]!).sort()).toEqual(
      ['currency', 'generatedCents', 'id', 'initials', 'joinedAt', 'state'].sort(),
    );
  });

  it('otro alumno del mismo aula solo ve los suyos', async () => {
    const res = await runAsTenant(tenantA, () => service.memberInvitees(tenantA, users['otro']!));
    expect(res.payingNow).toBe(1);
    expect(res.invitees.map((i) => i.initials)).toEqual(['LM']);
  });

  it('desde el aula A no se ve nada del aula B, ni pidiendo su tenant', async () => {
    const mismoTenant = await runAsTenant(tenantA, () =>
      service.memberInvitees(tenantA, users['anaB']!),
    );
    expect(mismoTenant).toEqual({ payingNow: 0, invitees: [] });

    // La RLS filtra aunque el código pidiera el tenant de B con el contexto de A.
    const cruzado = await runAsTenant(tenantA, () =>
      service.memberInvitees(tenantB, users['anaB']!),
    );
    expect(cruzado).toEqual({ payingNow: 0, invitees: [] });

    const enB = await runAsTenant(tenantB, () => service.memberInvitees(tenantB, users['anaB']!));
    expect(enB.invitees.map((i) => [i.initials, i.state])).toEqual([['BB', 'paying']]);
  });
});
