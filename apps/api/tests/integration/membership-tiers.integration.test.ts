/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Niveles de la membresía contra el esquema de verdad (Postgres).
 *
 * Las unitarias del módulo prueban el criterio con dobles; aquí se prueba que
 * las consultas existen y hacen lo que dicen con filas reales: el nombre único
 * sin distinguir mayúsculas, la tabla nueva y la columna `tier_id`, la página
 * pública con los cursos del grupo de cada nivel, el compare-and-swap del
 * cambio de plan (cuenta + webhook = un aviso), el borrado protegido y que el
 * comprobador de venta de cursos cuenta los niveles de pago y no el gratis.
 *
 * Requiere un Postgres de pruebas (`TEST_DATABASE_URL`).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@didacta/database';
import {
  MembershipService,
  MembershipTiersService,
  SubscriptionsService,
  type SubscriptionsStripeAdapter,
} from '@didacta/mod-subscriptions';
import { buildCourseSaleChecker } from '../../src/modules/course-sale-checker';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://didacta_test:didacta_test@localhost:5433/didacta_test?schema=public';

describe('niveles de la membresía — contra Postgres', () => {
  let prisma: PrismaClient;
  let tiers: MembershipTiersService;
  let membership: MembershipService;
  let subscriptions: SubscriptionsService;
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const tenantId = randomUUID();
  const userId = randomUUID();
  const stamp = Date.now().toString(36);
  const cursos: Record<'a' | 'b' | 'l' | 'suelto', string> = {
    a: '',
    b: '',
    l: '',
    suelto: '',
  };
  const grupos = { basico: randomUUID(), pro: randomUUID(), gratis: randomUUID() };
  let changes = 0;

  const stripe = {
    createProduct: async () => `prod_${stamp}`,
    createRecurringPrice: async (p: { metadata: Record<string, string> }) =>
      `price_${p.metadata['planId']}`,
    changeSubscriptionPrice: async (p: { subscriptionId: string; priceId: string }) => {
      changes += 1;
      return {
        id: p.subscriptionId,
        status: 'active',
        currentPeriodEnd: 1_900_000_000,
        priceId: p.priceId,
        latestInvoice: null,
      };
    },
  } as unknown as SubscriptionsStripeAdapter;
  const publisher = {
    publish: async (
      _t: string,
      _a: string | null,
      name: string,
      payload: Record<string, unknown>,
    ) => {
      events.push({ name, payload });
    },
  };

  async function grupo(id: string, courseIds: string[], kind: 'ALL_COURSES' | 'MULTI_COURSE') {
    await prisma.modAccessGroup.create({
      data: {
        id,
        tenantId,
        slug: `g-${id.slice(0, 8)}`,
        name: `Grupo ${id.slice(0, 8)}`,
        kind,
        courses: { create: courseIds.map((courseId) => ({ tenantId, courseId })) },
      },
    });
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    await prisma.$connect();
    await prisma.tenant.create({
      data: { id: tenantId, slug: `niveles-${stamp}`, name: 'Niveles' },
    });
    for (const k of Object.keys(cursos) as Array<keyof typeof cursos>) {
      const c = await prisma.modCoursesCourse.create({
        data: {
          tenantId,
          slug: `curso-${k}-${stamp}`,
          title: `Curso ${k}`,
          status: 'PUBLISHED',
          publishedAt: new Date(),
        },
      });
      cursos[k] = c.id;
    }
    await grupo(grupos.basico, [cursos.a], 'MULTI_COURSE');
    await grupo(grupos.pro, [], 'ALL_COURSES');
    await grupo(grupos.gratis, [cursos.l], 'MULTI_COURSE');
    tiers = new MembershipTiersService(prisma);
    membership = new MembershipService(prisma, async () => stripe, publisher);
    subscriptions = new SubscriptionsService(prisma, async () => stripe, publisher, {
      successUrl: () => '',
      cancelUrl: () => '',
    });
    await membership.updateConfig(tenantId, { active: true });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  let basico: { id: string };
  let pro: { id: string };
  let gratis: { id: string };
  let planBasico: { id: string };
  let planPro: { id: string };

  it('crea niveles con su grupo; el nombre es único sin distinguir mayúsculas y hay un solo gratis', async () => {
    basico = await tiers.createTier(tenantId, { name: 'Básico', accessGroupId: grupos.basico });
    pro = await tiers.createTier(tenantId, { name: 'Pro', accessGroupId: grupos.pro });
    gratis = await tiers.createTier(tenantId, {
      name: 'Gratis',
      isFree: true,
      accessGroupId: grupos.gratis,
    });
    await expect(
      tiers.createTier(tenantId, { name: '  pro ', accessGroupId: null }),
    ).rejects.toMatchObject({ code: 'MEMBERSHIP_TIER_INVALID', detail: 'name_taken' });
    await expect(
      tiers.createTier(tenantId, { name: 'Otro gratis', isFree: true, accessGroupId: null }),
    ).rejects.toMatchObject({ detail: 'free_exists' });

    expect((await tiers.listTiers(tenantId)).map((t) => [t.name, t.sortOrder])).toEqual([
      ['Básico', 0],
      ['Pro', 1],
      ['Gratis', 2],
    ]);
    expect(await tiers.listTierSummaries(tenantId)).toEqual([
      { id: basico.id, name: 'Básico', accessGroupId: grupos.basico, isFree: false },
      { id: pro.id, name: 'Pro', accessGroupId: grupos.pro, isFree: false },
      { id: gratis.id, name: 'Gratis', accessGroupId: grupos.gratis, isFree: true },
    ]);
    expect((await tiers.paidMembershipGroupIds(tenantId)).sort()).toEqual(
      [grupos.basico, grupos.pro].sort(),
    );
  });

  it('planes: con niveles, cada plan va en un nivel de pago y su nombre es único en el aula', async () => {
    await expect(
      membership.createPlan(tenantId, { name: 'Suelto', intervalMonths: 1, amountCents: 900 }),
    ).rejects.toMatchObject({ code: 'MEMBERSHIP_TIER_INVALID', detail: 'tier_required' });
    await expect(
      membership.createPlan(tenantId, {
        name: 'Gratis · Mensual',
        tierId: gratis.id,
        intervalMonths: 1,
        amountCents: 0,
      }),
    ).rejects.toMatchObject({ code: 'MEMBERSHIP_TIER_IS_FREE' });
    planBasico = await membership.createPlan(tenantId, {
      name: 'Básico · Mensual',
      tierId: basico.id,
      intervalMonths: 1,
      amountCents: 1000,
    });
    planPro = await membership.createPlan(tenantId, {
      name: 'Pro · Mensual',
      tierId: pro.id,
      intervalMonths: 1,
      amountCents: 3000,
    });
    await expect(
      membership.createPlan(tenantId, {
        name: 'Pro · Mensual',
        tierId: pro.id,
        intervalMonths: 1,
        amountCents: 3500,
      }),
    ).rejects.toMatchObject({ code: 'MEMBERSHIP_PLAN_NAME_TAKEN' });
    expect(await tiers.accessGroupForPlan(tenantId, planPro.id)).toBe(grupos.pro);
  });

  it('página pública: cada nivel con los cursos de su grupo y sus planes', async () => {
    const page = await membership.getPublicPage(tenantId);
    const byId = new Map(page.tiers.map((t) => [t.id, t]));
    expect(byId.get(basico.id)!.includes).toEqual({
      allCourses: false,
      courses: [expect.objectContaining({ id: cursos.a })],
    });
    expect(byId.get(pro.id)!.includes.allCourses).toBe(true);
    expect(
      byId
        .get(pro.id)!
        .includes.courses.map((c) => c.id)
        .sort(),
    ).toEqual(Object.values(cursos).sort());
    expect(byId.get(gratis.id)!.includes.courses.map((c) => c.id)).toEqual([cursos.l]);
    expect(byId.get(gratis.id)!.planIds).toEqual([]);
    expect(page.plans.map((p) => [p.id, p.tierId])).toEqual([
      [planBasico.id, basico.id],
      [planPro.id, pro.id],
    ]);

    // Un nivel apagado no se vende (ni su tarjeta ni sus planes).
    await tiers.updateTier(tenantId, pro.id, { active: false });
    const apagado = await membership.getPublicPage(tenantId);
    expect(apagado.tiers.map((t) => t.id)).not.toContain(pro.id);
    expect(apagado.plans.map((p) => p.id)).toEqual([planBasico.id]);
    await tiers.updateTier(tenantId, pro.id, { active: true });
  });

  it('cambio de plan: el compare-and-swap deja UN aviso aunque el webhook llegue después', async () => {
    const stripeSubscriptionId = `sub_int_${stamp}`;
    const sub = await prisma.modSubscriptionsSubscription.create({
      data: {
        tenantId,
        userId,
        planId: planBasico.id,
        stripeSubscriptionId,
        stripeCustomerId: `cus_int_${stamp}`,
        stripePriceId: 'price_basico',
        status: 'ACTIVE',
        unitAmount: 1000,
        currency: 'eur',
        interval: 'month',
      },
    });
    const res = await membership.changePlan(tenantId, userId, planPro.id);
    expect(res.subscription).toMatchObject({ planId: planPro.id, unitAmount: 3000 });
    expect(changes).toBe(1);

    await subscriptions.handleWebhookEvent(
      {
        id: `evt_int_${stamp}`,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: stripeSubscriptionId,
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1_900_000_000,
            trial_end: null,
            metadata: { membership: '1', tenantId, planId: planPro.id },
            items: { data: [{ price: { id: `price_${planPro.id}` } }] },
          },
        },
      } as never,
      {},
      { tenantId },
    );
    const changed = events.filter(
      (e) =>
        e.name === 'subscriptions.membership.plan_changed' &&
        e.payload['subscriptionId'] === sub.id,
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]!.payload).toMatchObject({
      fromTierId: basico.id,
      toTierId: pro.id,
      via: 'account',
    });
    const options = await membership.getPlanChangeOptions(tenantId, userId);
    expect(options.subscription).toMatchObject({ tierName: 'Pro', planId: planPro.id });
    expect(options.options.map((o) => o.planId)).toEqual([planBasico.id]);
    expect(options.freeTier).toEqual({ id: gratis.id, name: 'Gratis' });
  });

  it('un nivel con planes vendidos no se borra; uno sin ventas sí (con sus planes)', async () => {
    await expect(tiers.deleteTier(tenantId, pro.id)).rejects.toMatchObject({
      code: 'MEMBERSHIP_TIER_IN_USE',
    });
    const vacio = await tiers.createTier(tenantId, { name: 'Vacío', accessGroupId: null });
    const plan = await membership.createPlan(tenantId, {
      name: 'Vacío · Mensual',
      tierId: vacio.id,
      intervalMonths: 1,
      amountCents: 500,
    });
    await tiers.deleteTier(tenantId, vacio.id);
    expect(await prisma.modSubscriptionsPlan.findUnique({ where: { id: plan.id } })).toBeNull();
    expect(await prisma.modSubscriptionsTier.findUnique({ where: { id: vacio.id } })).toBeNull();
  });

  it('cursos a la venta: los de un nivel de pago sí; los solo del gratis y los sueltos no', async () => {
    // Pro da TODOS los cursos: con él encendido, todos se venden.
    const seVende = (courseId: string) => buildCourseSaleChecker(() => prisma)(tenantId, courseId);
    expect(await seVende(cursos.a)).toBe(true);
    expect(await seVende(cursos.l)).toBe(true);
    // Sin el «todos» de Pro, el gratis y el suelto dejan de venderse.
    await prisma.modSubscriptionsTier.update({
      where: { id: pro.id },
      data: { accessGroupId: null },
    });
    expect(await seVende(cursos.a)).toBe(true);
    expect(await seVende(cursos.l)).toBe(false);
    expect(await seVende(cursos.suelto)).toBe(false);
  });
});
