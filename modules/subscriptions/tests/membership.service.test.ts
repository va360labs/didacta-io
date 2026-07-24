/**
 * Tests unit del MembershipService — sin red, sin DB real, sin Stripe SDK.
 *
 * Cobertura:
 *  - Planes: crear/listar; editar precio ROTA el stripePriceId (prices
 *    inmutables); editar solo el nombre lo conserva; borrar con ventas
 *    desactiva en vez de borrar.
 *  - Página pública: inactiva → error; cursos PUBLISHED con precio individual
 *    de la config; suma "por separado"; testimonial solo si cita+autor.
 *  - Checkout: sin Stripe → ConfigMissing; plan inexistente → NotFound; crea
 *    product+price perezosamente y los REUTILIZA; pasa trial y cupones.
 *  - Fulfillment: session sin metadata de membresía → null; crea user vía
 *    provisioner + sub ACTIVE con planId (sin courseId) + evento activated;
 *    IDEMPOTENTE por stripeSubscriptionId (retry de Stripe no duplica).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Stripe from 'stripe';
import { MembershipService } from '../src/membership.service.js';
import {
  MembershipPageInactiveError,
  MembershipPlanNotFoundError,
  StripeConfigMissingError,
} from '../src/errors.js';
import type {
  SubscriptionsStripeAdapter,
  CreateSubscriptionCheckoutParams,
  CreateRecurringPriceParams,
} from '../src/stripe-subscriptions.client.js';
import type { SubscriptionsEventPublisher } from '../src/subscriptions.service.js';

// ---------- Mock Prisma in-memory ----------

interface PlanRow {
  id: string;
  tenantId: string;
  name: string;
  intervalMonths: number;
  amountCents: number;
  currency: string;
  compareAtCents: number | null;
  trialDays: number;
  active: boolean;
  isFeatured: boolean;
  sortOrder: number;
  stripeProductId: string | null;
  stripePriceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ConfigRow {
  tenantId: string;
  active: boolean;
  headline: string;
  subheadline: string | null;
  accessGroupId: string | null;
  showCourses: boolean;
  coursePrices: unknown;
  testimonialQuote: string | null;
  testimonialAuthor: string | null;
  testimonialRole: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SubRow {
  id: string;
  tenantId: string;
  userId: string;
  courseId: string | null;
  planId: string | null;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string;
  stripePriceId: string;
  status: string;
  unitAmount: number;
  currency: string;
  interval: string;
}

interface CourseRow {
  id: string;
  tenantId: string;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  estimatedMinutes: number | null;
  category: string | null;
  createdById: string | null;
  modules: Array<{ title: string }>;
  status: string;
  publishedAt: Date | null;
  deletedAt: Date | null;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    const val = row[k];
    if (v === null) {
      if (val !== null && val !== undefined) return false;
    } else if (v && typeof v === 'object' && 'not' in (v as object)) {
      const notVal = (v as { not: unknown }).not;
      if (notVal === null ? val === null || val === undefined : val === notVal) return false;
    } else if (val !== v) {
      return false;
    }
  }
  return true;
}

class MockPrisma {
  plans = new Map<string, PlanRow>();
  configs = new Map<string, ConfigRow>();
  subs = new Map<string, SubRow>();
  courses: CourseRow[] = [];
  private seq = 0;

  modSubscriptionsPlan = {
    findMany: async (args: { where: Record<string, unknown> }) =>
      [...this.plans.values()]
        .filter((p) => matches(p as never, args.where))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.amountCents - b.amountCents),
    findFirst: async (args: { where: Record<string, unknown>; select?: unknown }) =>
      [...this.plans.values()].find((p) => matches(p as never, args.where)) ?? null,
    create: async (args: { data: Record<string, unknown> }) => {
      this.seq += 1;
      const row: PlanRow = {
        id: `plan_${this.seq}`,
        currency: 'eur',
        compareAtCents: null,
        trialDays: 0,
        active: true,
        isFeatured: false,
        sortOrder: 0,
        stripeProductId: null,
        stripePriceId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(args.data as object),
      } as PlanRow;
      this.plans.set(row.id, row);
      return { ...row };
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.plans.get(args.where.id);
      if (!row) throw new Error('plan not found');
      Object.assign(row, args.data, { updatedAt: new Date() });
      return { ...row };
    },
    delete: async (args: { where: { id: string } }) => {
      this.plans.delete(args.where.id);
    },
  };

  modSubscriptionsMembershipConfig = {
    upsert: async (args: {
      where: { tenantId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const existing = this.configs.get(args.where.tenantId);
      if (existing) {
        Object.assign(existing, args.update, { updatedAt: new Date() });
        return { ...existing };
      }
      const row: ConfigRow = {
        tenantId: args.where.tenantId,
        active: false,
        headline: 'Hazte miembro',
        subheadline: null,
        accessGroupId: null,
        showCourses: true,
        coursePrices: [],
        testimonialQuote: null,
        testimonialAuthor: null,
        testimonialRole: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(args.create as object),
      } as ConfigRow;
      this.configs.set(row.tenantId, row);
      return { ...row };
    },
  };

  modSubscriptionsSubscription = {
    findUnique: async (args: { where: { stripeSubscriptionId?: string } }) =>
      args.where.stripeSubscriptionId
        ? ([...this.subs.values()].find(
            (s) => s.stripeSubscriptionId === args.where.stripeSubscriptionId,
          ) ?? null)
        : null,
    count: async (args: { where: Record<string, unknown> }) =>
      [...this.subs.values()].filter((s) => matches(s as never, args.where)).length,
    create: async (args: { data: Record<string, unknown> }) => {
      this.seq += 1;
      const row = { id: `sub_${this.seq}`, ...(args.data as object) } as SubRow;
      this.subs.set(row.id, row);
      return { ...row };
    },
  };

  modCoursesCourse = {
    findMany: async (args: { where: Record<string, unknown> }) =>
      this.courses.filter((c) => matches(c as never, args.where)),
  };

  users: Array<{ id: string; tenantId: string; name: string | null; status: string }> = [];

  user = {
    count: async (args: { where: Record<string, unknown> }) =>
      this.users.filter((u) => matches(u as never, args.where)).length,
    findMany: async (args: { where: { tenantId: string; id: { in: string[] } } }) =>
      this.users.filter(
        (u) => u.tenantId === args.where.tenantId && args.where.id.in.includes(u.id),
      ),
  };
}

// ---------- Stripe adapter stub ----------

function stubStripe() {
  let productSeq = 0;
  let priceSeq = 0;
  const createProduct = vi.fn(async () => `prod_${++productSeq}`);
  const updateProduct = vi.fn(async () => {});
  const createRecurringPrice = vi.fn(
    async (_p: CreateRecurringPriceParams) => `price_${++priceSeq}`,
  );
  const createCheckoutSession = vi.fn(async (p: CreateSubscriptionCheckoutParams) => ({
    id: 'cs_test_1',
    url: `https://checkout.stripe.test/${p.priceId}`,
  }));
  const adapter: SubscriptionsStripeAdapter = {
    createCheckoutSession,
    retrievePrice: async () => {
      throw new Error('no usado');
    },
    cancelSubscription: async () => {
      throw new Error('no usado');
    },
    constructWebhookEvent: () => {
      throw new Error('no usado');
    },
    createProduct,
    updateProduct,
    createRecurringPrice,
  };
  return { adapter, createProduct, updateProduct, createRecurringPrice, createCheckoutSession };
}

function stubPublisher() {
  const events: Array<{ tenantId: string; name: string; payload: Record<string, unknown> }> = [];
  const publisher: SubscriptionsEventPublisher = {
    publish: async (tenantId, _actorId, name, payload) => {
      events.push({ tenantId, name, payload });
    },
  };
  return { publisher, events };
}

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';

function build(withStripe = true) {
  const prisma = new MockPrisma();
  const stripe = stubStripe();
  const pub = stubPublisher();
  const service = new MembershipService(
    prisma as never,
    withStripe ? stripe.adapter : null,
    pub.publisher,
  );
  return { prisma, stripe, pub, service };
}

function membershipSession(
  overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
  return {
    id: 'cs_1',
    metadata: { membership: '1', tenantId: TENANT, planId: 'plan_1' },
    subscription: 'sub_stripe_1',
    customer: 'cus_1',
    customer_email: null,
    customer_details: { email: 'buyer@x.com', name: 'Búyer' },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

// ---------- Tests ----------

describe('MembershipService · planes', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build();
  });

  it('crea y lista planes ordenados por sortOrder', async () => {
    await ctx.service.createPlan(TENANT, {
      name: 'Anual',
      intervalMonths: 12,
      amountCents: 99_900,
      sortOrder: 2,
    });
    await ctx.service.createPlan(TENANT, {
      name: 'Mensual',
      intervalMonths: 1,
      amountCents: 9_900,
      sortOrder: 1,
    });
    const plans = await ctx.service.listPlans(TENANT);
    expect(plans.map((p) => p.name)).toEqual(['Mensual', 'Anual']);
  });

  it('cambiar el PRECIO rota el stripePriceId; cambiar solo el nombre lo conserva', async () => {
    const plan = await ctx.service.createPlan(TENANT, {
      name: 'Anual',
      intervalMonths: 12,
      amountCents: 99_900,
    });
    ctx.prisma.plans.get(plan.id)!.stripePriceId = 'price_viejo';

    const renamed = await ctx.service.updatePlan(TENANT, plan.id, { name: 'Anual PRO' });
    expect(renamed.stripePriceId).toBe('price_viejo');

    const repriced = await ctx.service.updatePlan(TENANT, plan.id, { amountCents: 89_900 });
    expect(repriced.stripePriceId).toBeNull();
  });

  it('borrar un plan CON ventas lo desactiva (historial); sin ventas lo borra', async () => {
    const vendido = await ctx.service.createPlan(TENANT, {
      name: 'Anual',
      intervalMonths: 12,
      amountCents: 99_900,
    });
    const limpio = await ctx.service.createPlan(TENANT, {
      name: 'Mensual',
      intervalMonths: 1,
      amountCents: 9_900,
    });
    ctx.prisma.subs.set('s1', {
      id: 's1',
      tenantId: TENANT,
      userId: 'u1',
      courseId: null,
      planId: vendido.id,
      stripeSubscriptionId: 'sub_x',
      stripeCustomerId: 'cus',
      stripePriceId: 'price',
      status: 'ACTIVE',
      unitAmount: 99_900,
      currency: 'eur',
      interval: 'year',
    });

    await ctx.service.deletePlan(TENANT, vendido.id);
    await ctx.service.deletePlan(TENANT, limpio.id);

    expect(ctx.prisma.plans.get(vendido.id)?.active).toBe(false);
    expect(ctx.prisma.plans.has(limpio.id)).toBe(false);
  });

  it('plan de otro tenant → NotFound', async () => {
    const plan = await ctx.service.createPlan(TENANT, {
      name: 'Anual',
      intervalMonths: 12,
      amountCents: 99_900,
    });
    await expect(
      ctx.service.updatePlan('bbbbbbbb-0000-0000-0000-000000000002', plan.id, { name: 'X' }),
    ).rejects.toBeInstanceOf(MembershipPlanNotFoundError);
  });
});

describe('MembershipService · página pública', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build();
    ctx.prisma.courses = [
      {
        id: 'c1',
        tenantId: TENANT,
        title: 'Curso IA',
        description: 'desc',
        thumbnailUrl: null,
        estimatedMinutes: 120,
        category: 'IA',
        createdById: 'prof_1',
        modules: [{ title: 'Módulo 1' }, { title: 'Módulo 2' }],
        status: 'PUBLISHED',
        publishedAt: new Date(),
        deletedAt: null,
      },
      {
        id: 'c2',
        tenantId: TENANT,
        title: 'Borrador',
        description: null,
        thumbnailUrl: null,
        estimatedMinutes: null,
        category: null,
        createdById: null,
        modules: [],
        status: 'DRAFT',
        publishedAt: null,
        deletedAt: null,
      },
      {
        id: 'c3',
        tenantId: TENANT,
        title: 'Curso n8n',
        description: null,
        thumbnailUrl: null,
        estimatedMinutes: 60,
        category: 'Automatización',
        createdById: null,
        modules: [{ title: 'Intro' }],
        status: 'PUBLISHED',
        publishedAt: new Date(),
        deletedAt: null,
      },
    ];
    ctx.prisma.users = [
      { id: 'prof_1', tenantId: TENANT, name: 'Profe Real', status: 'ACTIVE' },
      { id: 'al_1', tenantId: TENANT, name: 'Alumno Uno', status: 'ACTIVE' },
      { id: 'al_2', tenantId: TENANT, name: 'Alumno Dos', status: 'PENDING' },
    ];
  });

  it('página inactiva → MembershipPageInactiveError', async () => {
    await expect(ctx.service.getPublicPage(TENANT)).rejects.toBeInstanceOf(
      MembershipPageInactiveError,
    );
  });

  it('devuelve solo cursos PUBLISHED con su precio de la config + suma "por separado"', async () => {
    await ctx.service.updateConfig(TENANT, {
      active: true,
      coursePrices: [
        { courseId: 'c1', amountCents: 19_900 },
        { courseId: 'c3', amountCents: 9_900 },
      ],
    });
    const page = await ctx.service.getPublicPage(TENANT);
    expect(page.courses.map((c) => c.id).sort()).toEqual(['c1', 'c3']);
    expect(page.courses.find((c) => c.id === 'c1')?.amountCents).toBe(19_900);
    expect(page.standaloneTotalCents).toBe(29_800);
  });

  it('expone categoría, módulos y profesor REALES de cada curso', async () => {
    await ctx.service.updateConfig(TENANT, { active: true });
    const page = await ctx.service.getPublicPage(TENANT);
    const c1 = page.courses.find((c) => c.id === 'c1')!;
    expect(c1.category).toBe('IA');
    expect(c1.moduleCount).toBe(2);
    expect(c1.moduleTitles).toEqual(['Módulo 1', 'Módulo 2']);
    expect(c1.teacherName).toBe('Profe Real');
    const c3 = page.courses.find((c) => c.id === 'c3')!;
    expect(c3.teacherName).toBeNull();
  });

  it('los tiles usan datos reales: alumnos ACTIVE y suma de minutos del catálogo', async () => {
    await ctx.service.updateConfig(TENANT, { active: true });
    const page = await ctx.service.getPublicPage(TENANT);
    // prof_1 + al_1 son ACTIVE; al_2 es PENDING y no cuenta.
    expect(page.stats.activeMembers).toBe(2);
    expect(page.stats.totalMinutes).toBe(180);
  });

  it('testimonial solo si hay cita Y autor (prohibido inventar personas)', async () => {
    await ctx.service.updateConfig(TENANT, { active: true, testimonialQuote: 'Genial' });
    let page = await ctx.service.getPublicPage(TENANT);
    expect(page.testimonial).toBeNull();

    await ctx.service.updateConfig(TENANT, { testimonialAuthor: 'Cliente Real' });
    page = await ctx.service.getPublicPage(TENANT);
    expect(page.testimonial).toEqual({ quote: 'Genial', author: 'Cliente Real', role: null });
  });

  it('las descripciones con HTML (migradas de LearnDash) llegan como texto plano', async () => {
    ctx.prisma.courses[0]!.description =
      '<p><strong>N8N</strong> es la herramienta de automatizaci&oacute;n <em>fair-code</em> m&aacute;s potente&nbsp;&amp; flexible.</p><script>alert(1)</script>';
    await ctx.service.updateConfig(TENANT, { active: true });
    const page = await ctx.service.getPublicPage(TENANT);
    const desc = page.courses.find((c) => c.id === 'c1')?.description ?? '';
    expect(desc).not.toContain('<');
    expect(desc).not.toContain('&nbsp;');
    expect(desc).not.toContain('alert');
    expect(desc).toContain('N8N es la herramienta');
    expect(desc).toContain('& flexible');
  });

  it('descripción larga se corta en extracto con elipsis; vacía queda en null', async () => {
    ctx.prisma.courses[0]!.description = `<p>${'palabra '.repeat(60)}</p>`;
    ctx.prisma.courses[2]!.description = '<p>&nbsp;</p>';
    await ctx.service.updateConfig(TENANT, { active: true });
    const page = await ctx.service.getPublicPage(TENANT);
    const larga = page.courses.find((c) => c.id === 'c1')?.description ?? '';
    expect(larga.length).toBeLessThanOrEqual(230);
    expect(larga.endsWith('…')).toBe(true);
    expect(page.courses.find((c) => c.id === 'c3')?.description).toBeNull();
  });

  it('solo lista planes ACTIVOS', async () => {
    await ctx.service.updateConfig(TENANT, { active: true });
    await ctx.service.createPlan(TENANT, { name: 'On', intervalMonths: 1, amountCents: 1000 });
    await ctx.service.createPlan(TENANT, {
      name: 'Off',
      intervalMonths: 12,
      amountCents: 2000,
      active: false,
    });
    const page = await ctx.service.getPublicPage(TENANT);
    expect(page.plans.map((p) => p.name)).toEqual(['On']);
  });
});

describe('MembershipService · checkout', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(async () => {
    ctx = build();
    await ctx.service.updateConfig(TENANT, { active: true });
  });

  it('sin Stripe configurado → StripeConfigMissingError', async () => {
    const sinStripe = build(false);
    await sinStripe.service.updateConfig(TENANT, { active: true });
    const plan = await sinStripe.service.createPlan(TENANT, {
      name: 'Anual',
      intervalMonths: 12,
      amountCents: 99_900,
    });
    await expect(
      sinStripe.service.startMembershipCheckout({
        tenantId: TENANT,
        planId: plan.id,
        successUrl: 'https://x/s',
        cancelUrl: 'https://x/c',
      }),
    ).rejects.toBeInstanceOf(StripeConfigMissingError);
  });

  it('plan inexistente o inactivo → MembershipPlanNotFoundError', async () => {
    const plan = await ctx.service.createPlan(TENANT, {
      name: 'Off',
      intervalMonths: 1,
      amountCents: 1000,
      active: false,
    });
    await expect(
      ctx.service.startMembershipCheckout({
        tenantId: TENANT,
        planId: plan.id,
        successUrl: 'https://x/s',
        cancelUrl: 'https://x/c',
      }),
    ).rejects.toBeInstanceOf(MembershipPlanNotFoundError);
  });

  it('crea product+price perezosamente, los persiste y los REUTILIZA; pasa trial y cupones', async () => {
    const plan = await ctx.service.createPlan(TENANT, {
      name: 'Anual',
      intervalMonths: 12,
      amountCents: 99_900,
      trialDays: 14,
    });

    const first = await ctx.service.startMembershipCheckout({
      tenantId: TENANT,
      planId: plan.id,
      email: 'buyer@x.com',
      successUrl: 'https://x/s',
      cancelUrl: 'https://x/c',
    });
    expect(first.url).toContain('price_1');
    expect(ctx.stripe.createProduct).toHaveBeenCalledTimes(1);
    // Un Product POR PLAN, nombrado con el nombre del plan: es lo que ve el
    // comprador en el checkout ("VA360.pro Anual"), no un nombre compartido.
    expect(ctx.stripe.createProduct).toHaveBeenCalledWith('Anual', expect.any(Object));
    expect(ctx.stripe.createRecurringPrice).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 99_900, intervalMonths: 12, nickname: 'Anual' }),
    );
    const checkoutArgs = ctx.stripe.createCheckoutSession.mock.calls[0]![0];
    expect(checkoutArgs).toMatchObject({
      trialDays: 14,
      allowPromotionCodes: true,
      customerEmail: 'buyer@x.com',
      metadata: { tenantId: TENANT, membership: '1', planId: plan.id },
    });

    // Segundo checkout: NO se crean product/price nuevos.
    await ctx.service.startMembershipCheckout({
      tenantId: TENANT,
      planId: plan.id,
      successUrl: 'https://x/s',
      cancelUrl: 'https://x/c',
    });
    expect(ctx.stripe.createProduct).toHaveBeenCalledTimes(1);
    expect(ctx.stripe.createRecurringPrice).toHaveBeenCalledTimes(1);
    expect(ctx.prisma.plans.get(plan.id)?.stripePriceId).toBe('price_1');
  });

  it('renombrar el plan renombra su Product en Stripe', async () => {
    const plan = await ctx.service.createPlan(TENANT, {
      name: 'VA360.pro Anual',
      intervalMonths: 12,
      amountCents: 39_900,
    });
    // Primer checkout materializa el Product (prod_1) y el Price.
    await ctx.service.startMembershipCheckout({
      tenantId: TENANT,
      planId: plan.id,
      successUrl: 'https://x/s',
      cancelUrl: 'https://x/c',
    });
    await ctx.service.updatePlan(TENANT, plan.id, { name: 'VA360.pro Anual (2027)' });
    expect(ctx.stripe.updateProduct).toHaveBeenCalledWith('prod_1', 'VA360.pro Anual (2027)');

    // Cambiar solo el importe NO toca el nombre del Product.
    ctx.stripe.updateProduct.mockClear();
    await ctx.service.updatePlan(TENANT, plan.id, { amountCents: 42_000 });
    expect(ctx.stripe.updateProduct).not.toHaveBeenCalled();
  });
});

describe('MembershipService · fulfillment (webhook)', () => {
  let ctx: ReturnType<typeof build>;
  let planId: string;
  beforeEach(async () => {
    ctx = build();
    await ctx.service.updateConfig(TENANT, { active: true });
    const plan = await ctx.service.createPlan(TENANT, {
      name: 'Anual',
      intervalMonths: 12,
      amountCents: 99_900,
    });
    planId = plan.id;
  });

  it('session SIN metadata de membresía → null (es un checkout de curso/billing)', async () => {
    const provision = vi.fn();
    const res = await ctx.service.fulfillMembershipCheckout(
      membershipSession({ metadata: {} as never }),
      provision,
    );
    expect(res).toBeNull();
    expect(provision).not.toHaveBeenCalled();
  });

  it('crea el user vía provisioner + sub ACTIVE con planId (sin courseId) + evento activated', async () => {
    const provision = vi.fn(async () => ({ userId: 'user_1', created: true }));
    const res = await ctx.service.fulfillMembershipCheckout(
      membershipSession({ metadata: { membership: '1', tenantId: TENANT, planId } as never }),
      provision,
    );

    expect(provision).toHaveBeenCalledWith({
      tenantId: TENANT,
      email: 'buyer@x.com',
      name: 'Búyer',
    });
    expect(res).toMatchObject({ userId: 'user_1', userCreated: true });
    const sub = [...ctx.prisma.subs.values()][0]!;
    expect(sub).toMatchObject({
      tenantId: TENANT,
      userId: 'user_1',
      courseId: null,
      planId,
      stripeSubscriptionId: 'sub_stripe_1',
      status: 'ACTIVE',
      unitAmount: 99_900,
      interval: 'year',
    });
    expect(ctx.pub.events).toEqual([
      expect.objectContaining({
        tenantId: TENANT,
        name: 'subscriptions.membership.activated',
        payload: expect.objectContaining({ userId: 'user_1', planId, userCreated: true }),
      }),
    ]);
  });

  it('IDEMPOTENTE: el mismo stripeSubscriptionId dos veces no duplica user ni sub ni evento', async () => {
    const provision = vi.fn(async () => ({ userId: 'user_1', created: true }));
    const session = membershipSession({
      metadata: { membership: '1', tenantId: TENANT, planId } as never,
    });
    await ctx.service.fulfillMembershipCheckout(session, provision);
    const again = await ctx.service.fulfillMembershipCheckout(session, provision);

    expect(provision).toHaveBeenCalledTimes(1);
    expect(ctx.prisma.subs.size).toBe(1);
    expect(ctx.pub.events).toHaveLength(1);
    expect(again).toMatchObject({ userId: 'user_1', userCreated: false });
  });

  it('email normalizado a minúsculas antes de provisionar', async () => {
    const provision = vi.fn(async () => ({ userId: 'user_1', created: true }));
    await ctx.service.fulfillMembershipCheckout(
      membershipSession({
        metadata: { membership: '1', tenantId: TENANT, planId } as never,
        customer_details: { email: ' BUYER@X.com ', name: null } as never,
      }),
      provision,
    );
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ email: 'buyer@x.com' }));
  });
});
