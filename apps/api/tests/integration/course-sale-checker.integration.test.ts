/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * `buildCourseSaleChecker` contra el esquema de verdad.
 *
 * El test unitario (`tests/course-sale-checker.test.ts`) prueba el CRITERIO
 * con un doble que imita las consultas. Aquí se prueba que esas consultas
 * existen: que los modelos, los campos y la relación grupo → cursos se llaman
 * así en la base, con filas reales de los cuatro módulos que cruza
 * (billing, subscriptions, access-groups y payment-connections).
 *
 * Requiere `docker compose -f docker-compose.test.yml up -d`.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@didacta/database';
import { buildCourseSaleChecker } from '../../src/modules/course-sale-checker';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://didacta_test:didacta_test@localhost:5433/didacta_test?schema=public';

describe('buildCourseSaleChecker — contra Postgres', () => {
  let prisma: PrismaClient;
  let seVende: (courseId: string) => Promise<boolean>;
  const tenantId = randomUUID();
  const otroTenant = randomUUID();

  // Los cursos son ids lógicos (sin FK entre módulos): no hace falta la fila.
  const curso = {
    gratis: randomUUID(),
    conPrecio: randomUUID(),
    precioApagado: randomUUID(),
    conSuscripcion: randomUUID(),
    enGrupoManual: randomUUID(),
    enTierDePago: randomUUID(),
    enTierGratuito: randomUUID(),
    enTierSinCatalogo: randomUUID(),
    enGrupoBorrado: randomUUID(),
    deOtroTenant: randomUUID(),
  };

  async function grupo(data: {
    tenantId?: string;
    kind?: 'ALL_COURSES' | 'MULTI_COURSE';
    courseIds?: string[];
    linkedTierName?: string | null;
    deletedAt?: Date | null;
  }): Promise<string> {
    const id = randomUUID();
    const t = data.tenantId ?? tenantId;
    await prisma.modAccessGroup.create({
      data: {
        id,
        tenantId: t,
        slug: `g-${id.slice(0, 8)}`,
        name: `Grupo ${id.slice(0, 8)}`,
        kind: data.kind ?? 'MULTI_COURSE',
        linkedTierName: data.linkedTierName ?? null,
        deletedAt: data.deletedAt ?? null,
        courses: { create: (data.courseIds ?? []).map((courseId) => ({ tenantId: t, courseId })) },
      },
    });
    return id;
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    await prisma.$connect();
    for (const id of [tenantId, otroTenant]) {
      await prisma.tenant.create({
        data: { id, slug: `sale-${id.slice(0, 8)}`, name: 'Sale checker' },
      });
    }
    seVende = (courseId) => buildCourseSaleChecker(() => prisma)(tenantId, courseId);

    await prisma.modBillingProduct.createMany({
      data: [
        {
          tenantId,
          courseId: curso.conPrecio,
          stripeProductId: 'prod_a',
          stripePriceId: `price_${randomUUID()}`,
          unitAmount: 4900,
        },
        {
          tenantId,
          courseId: curso.precioApagado,
          stripeProductId: 'prod_b',
          stripePriceId: `price_${randomUUID()}`,
          unitAmount: 4900,
          active: false,
        },
        {
          tenantId: otroTenant,
          courseId: curso.deOtroTenant,
          stripeProductId: 'prod_c',
          stripePriceId: `price_${randomUUID()}`,
          unitAmount: 4900,
        },
      ],
    });
    await prisma.modSubscriptionsSubscription.create({
      data: {
        tenantId,
        userId: randomUUID(),
        courseId: curso.conSuscripcion,
        stripeCustomerId: 'cus_x',
        stripePriceId: 'price_x',
        unitAmount: 990,
        interval: 'month',
      },
    });
    await prisma.modPaymentConnectionsTier.createMany({
      data: [
        { tenantId, name: 'Pro', isFree: false },
        { tenantId, name: 'Free', isFree: true },
        // Mismo nombre en otro tenant, gratuito: no debe contar aquí.
        { tenantId: otroTenant, name: 'Plan anual', isFree: true },
      ],
    });
    await grupo({ courseIds: [curso.enGrupoManual] });
    await grupo({ courseIds: [curso.enTierDePago], linkedTierName: 'Pro' });
    await grupo({ courseIds: [curso.enTierGratuito], linkedTierName: 'Free' });
    await grupo({ courseIds: [curso.enTierSinCatalogo], linkedTierName: 'Plan anual' });
    await grupo({
      courseIds: [curso.enGrupoBorrado],
      linkedTierName: 'Pro',
      deletedAt: new Date(),
    });
    await grupo({ tenantId: otroTenant, kind: 'ALL_COURSES', linkedTierName: 'Pro' });
  });

  afterAll(async () => {
    for (const t of [tenantId, otroTenant]) {
      await prisma.modSubscriptionsMembershipConfig.deleteMany({ where: { tenantId: t } });
      await prisma.modAccessGroup.deleteMany({ where: { tenantId: t } });
      await prisma.modPaymentConnectionsTier.deleteMany({ where: { tenantId: t } });
      await prisma.modSubscriptionsSubscription.deleteMany({ where: { tenantId: t } });
      await prisma.modBillingProduct.deleteMany({ where: { tenantId: t } });
      await prisma.tenant.delete({ where: { id: t } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  it('precio propio, suscripción y tier de pago convierten el curso en de pago', async () => {
    expect(await seVende(curso.conPrecio)).toBe(true);
    expect(await seVende(curso.conSuscripcion)).toBe(true);
    expect(await seVende(curso.enTierDePago)).toBe(true);
    expect(await seVende(curso.enTierSinCatalogo)).toBe(true);
  });

  it('lo que no es una venta no lo convierte', async () => {
    expect(await seVende(curso.gratis)).toBe(false);
    expect(await seVende(curso.precioApagado)).toBe(false);
    expect(await seVende(curso.enGrupoManual)).toBe(false);
    expect(await seVende(curso.enTierGratuito)).toBe(false);
    expect(await seVende(curso.enGrupoBorrado)).toBe(false);
    // El ALL_COURSES de pago y el precio son de OTRO tenant.
    expect(await seVende(curso.deOtroTenant)).toBe(false);
  });

  it('membresía = todos los cursos: desde que se configura el grupo, todo es de pago', async () => {
    const socios = await grupo({ kind: 'ALL_COURSES' });
    // Un ALL_COURSES sin vínculo de pago (p. ej. «Equipo») no vende nada…
    expect(await seVende(curso.gratis)).toBe(false);

    await prisma.modSubscriptionsMembershipConfig.create({
      data: { tenantId, accessGroupId: socios },
    });

    // …hasta que es el grupo que concede la membresía.
    expect(await seVende(curso.gratis)).toBe(true);
    expect(await seVende(curso.enGrupoManual)).toBe(true);
    expect(await seVende(randomUUID())).toBe(true);
  });
});
