/**
 * Precios en modo plataforma (cobros de plataforma, E8 + multidivisa §9):
 *
 *  - `PATCH /modules/billing/products/:id` con `amountCents` (y moneda y
 *    precios por mercado) pasa por `upsertCoursePrice`, que rota el Price y
 *    mantiene el Product (eso lo prueba `modules/billing/tests`).
 *  - En modo plataforma la moneda es una de la lista, el importe se puede
 *    cobrar en ella, y no se pega un `price_…`; con claves propias, nada cambia.
 *  - Los planes de la membresía, igual.
 *  - `PlatformCheckoutGate.pricePolicy`: la moneda de liquidación del creador.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PayoutsPriceCurrencyError } from '@didacta/mod-payouts';
import { describe, expect, it, vi } from 'vitest';
import { BillingAdminController } from '../src/modules/billing/billing-admin.controller';
import { PlatformCheckoutGate } from '../src/modules/payouts/platform-checkout-gate';
import { MembershipAdminController } from '../src/modules/subscriptions/membership-admin.controller';

const TENANT = '11111111-1111-4111-8111-111111111111';
const COURSE = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '33333333-3333-4333-8333-333333333333';
const admin = { sub: 'admin', tenantId: TENANT, roles: ['tenant_admin'] } as never;

function gate(
  mode: 'platform' | 'own',
  account: { country: string; defaultCurrency: string | null } | null,
) {
  return new PlatformCheckoutGate({
    mode: {
      resolve: async () =>
        mode === 'own'
          ? { mode: 'own', credentials: {} }
          : { mode: 'platform', ready: true, reason: null },
    },
    accounts: { getAccount: async () => account },
  } as never);
}

function billingController(g: PlatformCheckoutGate | undefined) {
  const product = {
    id: PRODUCT,
    courseId: COURSE,
    name: '',
    unitAmount: 4900,
    currency: 'eur',
    currencyOptions: null,
    compareAtAmount: null,
    externalRef: null,
    active: true,
    stripeProductId: 'prod_1',
    stripePriceId: 'price_1',
  };
  const billing = {
    listProducts: vi.fn(async () => [product]),
    createProduct: vi.fn(async (input: unknown) => ({ ...product, input })),
    updateProduct: vi.fn(async (input: { patch: Record<string, unknown> }) => ({
      ...product,
      ...input.patch,
    })),
    upsertCoursePrice: vi.fn(async (input: Record<string, unknown>) => ({
      product: { ...product, ...input, stripePriceId: 'price_2' },
      accion: 'actualizado' as const,
    })),
  };
  const prisma = {
    modCoursesCourse: {
      findFirst: async () => ({ title: 'Curso de torno', status: 'PUBLISHED' }),
    },
  };
  const ctrl = new BillingAdminController(
    { getBillingService: () => billing } as never,
    prisma as never,
    g,
  );
  return { ctrl, billing };
}

const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof PayoutsPriceCurrencyError) return ['price', err.reason, err.detail];
    if (err instanceof BadRequestException) {
      return ['bad', (err.getResponse() as { code?: string }).code];
    }
    throw err;
  }
  return null;
};

describe('PATCH /modules/billing/products/:id — precio por importe', () => {
  it('con amountCents: upsertCoursePrice con el curso y la opción de la fila (Price nuevo, mismo Product)', async () => {
    const { ctrl, billing } = billingController(
      gate('platform', { country: 'ES', defaultCurrency: 'eur' }),
    );
    const res = await ctrl.update(PRODUCT, { amountCents: 5900 }, admin);
    expect(billing.upsertCoursePrice).toHaveBeenCalledWith({
      tenantId: TENANT,
      courseId: COURSE,
      optionName: '',
      unitAmount: 5900,
      currency: 'eur',
      currencyOptions: undefined,
      compareAtAmount: null,
      name: 'Curso de torno',
      externalRef: null,
    });
    expect(billing.updateProduct).not.toHaveBeenCalled();
    expect(res.product).toMatchObject({ stripePriceId: 'price_2', stripeProductId: 'prod_1' });
  });

  it('cambiar la moneda y los precios por mercado también va por upsertCoursePrice', async () => {
    const { ctrl, billing } = billingController(
      gate('platform', { country: 'CH', defaultCurrency: null }),
    );
    await ctrl.update(
      PRODUCT,
      { amountCents: 10_000, currency: 'chf', currencyOptions: { mxn: 199_900 } },
      admin,
    );
    expect(billing.upsertCoursePrice).toHaveBeenCalledWith(
      expect.objectContaining({
        unitAmount: 10_000,
        currency: 'chf',
        currencyOptions: { mxn: 199_900 },
      }),
    );
  });

  it('solo active: el camino de siempre, sin tocar el precio', async () => {
    const { ctrl, billing } = billingController(gate('platform', null));
    await ctrl.update(PRODUCT, { active: false }, admin);
    expect(billing.updateProduct).toHaveBeenCalledWith({
      tenantId: TENANT,
      productId: PRODUCT,
      patch: { active: false, stripePriceId: undefined },
    });
    expect(billing.upsertCoursePrice).not.toHaveBeenCalled();
  });

  it('opción de otra organización → 404', async () => {
    const { ctrl } = billingController(gate('platform', null));
    await expect(
      ctrl.update('44444444-4444-4444-8444-444444444444', { amountCents: 100 }, admin),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('monedas en modo plataforma (§9) — cursos', () => {
  it('moneda fuera de la lista → 422 y no se toca Stripe; la del creador u otra de la lista, sí', async () => {
    const { ctrl, billing } = billingController(
      gate('platform', { country: 'ES', defaultCurrency: 'eur' }),
    );
    expect(
      await rejection(ctrl.update(PRODUCT, { amountCents: 99_900, currency: 'mxn' }, admin)),
    ).toEqual(['price', 'currency_not_supported', 'MXN']);
    expect(billing.upsertCoursePrice).not.toHaveBeenCalled();
    await ctrl.update(PRODUCT, { amountCents: 3_990_000, currency: 'huf' }, admin);
    await ctrl.update(PRODUCT, { amountCents: 10_000, currency: 'usd' }, admin);
    expect(billing.upsertCoursePrice).toHaveBeenCalledTimes(2);
  });

  it('precio por mercado en ISK con fracción → 422; pegar un price_ → 400', async () => {
    const { ctrl } = billingController(gate('platform', { country: 'ES', defaultCurrency: 'eur' }));
    expect(
      await rejection(
        ctrl.update(PRODUCT, { amountCents: 4900, currencyOptions: { isk: 795_050 } }, admin),
      ),
    ).toEqual(['price', 'invalid_currency_option', 'ISK']);
    expect(await rejection(ctrl.update(PRODUCT, { stripePriceId: 'price_9' }, admin))).toEqual([
      'bad',
      'BILLING_PRICE_ID_NOT_ALLOWED',
    ]);
    expect(
      await rejection(ctrl.create({ courseId: COURSE, stripePriceId: 'price_9' }, admin)),
    ).toEqual(['bad', 'BILLING_PRICE_ID_NOT_ALLOWED']);
  });

  it('crear con importe en CHF y precio fijo en MXN: pasa y llega al servicio', async () => {
    const { ctrl, billing } = billingController(
      gate('platform', { country: 'CH', defaultCurrency: null }),
    );
    await ctrl.create(
      { courseId: COURSE, amountCents: 10_000, currency: 'chf', currencyOptions: { mxn: 199_900 } },
      admin,
    );
    expect(billing.createProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        unitAmount: 10_000,
        currency: 'chf',
        currencyOptions: { mxn: 199_900 },
      }),
    );
  });

  it('claves propias (own): las monedas y el price_ de siempre, sin validar nada nuevo', async () => {
    const { ctrl, billing } = billingController(gate('own', null));
    await ctrl.update(PRODUCT, { amountCents: 99_900, currency: 'mxn' }, admin);
    await ctrl.update(PRODUCT, { stripePriceId: 'price_9' }, admin);
    expect(billing.upsertCoursePrice).toHaveBeenCalledTimes(1);
    expect(billing.updateProduct).toHaveBeenCalledTimes(1);
  });

  it('sin cobros de plataforma (Community): sin puerta, nada cambia', async () => {
    const { ctrl, billing } = billingController(undefined);
    await ctrl.create({ courseId: COURSE, stripePriceId: 'price_9' }, admin);
    expect(billing.createProduct).toHaveBeenCalledTimes(1);
  });
});

describe('monedas en modo plataforma (§9) — planes de la membresía', () => {
  function membershipController(g: PlatformCheckoutGate | undefined) {
    const plan = {
      id: PRODUCT,
      amountCents: 2900,
      compareAtCents: null,
      currency: 'eur',
      currencyOptions: null,
    };
    const membership = {
      createPlan: vi.fn(async () => plan),
      updatePlan: vi.fn(async () => plan),
      listPlans: vi.fn(async () => [plan]),
    };
    const ctrl = new MembershipAdminController(
      { getMembershipService: () => membership } as never,
      g,
    );
    return { ctrl, membership };
  }

  it('plan en MXN en modo plataforma → 422 sin crear nada; en CHF, sí', async () => {
    const { ctrl, membership } = membershipController(
      gate('platform', { country: 'CH', defaultCurrency: 'chf' }),
    );
    expect(
      await rejection(
        ctrl.createPlan(admin, {
          name: 'Mensual',
          intervalMonths: 1,
          amountCents: 59_900,
          currency: 'mxn',
        }),
      ),
    ).toEqual(['price', 'currency_not_supported', 'MXN']);
    expect(membership.createPlan).not.toHaveBeenCalled();
    await ctrl.createPlan(admin, {
      name: 'Mensual',
      intervalMonths: 1,
      amountCents: 2_900,
      currency: 'chf',
    });
    expect(membership.createPlan).toHaveBeenCalledTimes(1);
  });

  it('editar solo el precio por mercado valida con la moneda guardada del plan', async () => {
    const { ctrl, membership } = membershipController(
      gate('platform', { country: 'ES', defaultCurrency: 'eur' }),
    );
    expect(
      await rejection(ctrl.updatePlan(admin, PRODUCT, { currencyOptions: { eur: 3000 } })),
    ).toEqual(['price', 'invalid_currency_option', 'EUR']);
    await ctrl.updatePlan(admin, PRODUCT, { currencyOptions: { mxn: 59_900 } });
    expect(membership.updatePlan).toHaveBeenCalledTimes(1);
  });

  it('claves propias: el plan en MXN de siempre', async () => {
    const { ctrl, membership } = membershipController(gate('own', null));
    await ctrl.createPlan(admin, {
      name: 'Mensual',
      intervalMonths: 1,
      amountCents: 59_900,
      currency: 'mxn',
    });
    expect(membership.createPlan).toHaveBeenCalledTimes(1);
  });
});

describe('PlatformCheckoutGate.pricePolicy', () => {
  it('own → null; plataforma → moneda de liquidación del creador (la de su cuenta o su país)', async () => {
    expect(await gate('own', null).pricePolicy(TENANT)).toBeNull();
    expect(await gate('platform', null).pricePolicy(TENANT)).toMatchObject({
      settlementCurrency: null,
    });
    expect(
      await gate('platform', { country: 'CH', defaultCurrency: null }).pricePolicy(TENANT),
    ).toMatchObject({ settlementCurrency: 'chf' });
    const policy = await gate('platform', { country: 'HU', defaultCurrency: 'huf' }).pricePolicy(
      TENANT,
    );
    expect(policy?.settlementCurrency).toBe('huf');
    expect(policy?.currencies).toContain('eur');
  });
});
