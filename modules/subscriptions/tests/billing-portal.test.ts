/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * `SubscriptionsService.createBillingPortalSession`: qué suscripción (y por
 * tanto qué cliente de Stripe) abre el portal de un alumno, y que nunca abre el
 * de otro.
 */

import { describe, expect, it, vi } from 'vitest';
import { SubscriptionNotFoundError } from '../src/errors.js';
import type { SubscriptionsStripeAdapter } from '../src/stripe-subscriptions.client.js';
import { SubscriptionsService } from '../src/subscriptions.service.js';

const T = '11111111-1111-4111-8111-111111111111';
const OTRO_T = '22222222-2222-4222-8222-222222222222';

type Row = Record<string, unknown>;

function cumple(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === 'object') {
      if ('in' in cond) return (cond as { in: unknown[] }).in.includes(value);
      if ('not' in cond) return value !== (cond as { not: unknown }).not;
    }
    return value === cond;
  });
}

function build(rows: Row[]) {
  const prisma = {
    modSubscriptionsSubscription: {
      findFirst: async (args: { where: Row; orderBy?: unknown }) =>
        rows
          .filter((r) => cumple(r, args.where))
          .sort(
            (a, b) => (b['createdAt'] as Date).getTime() - (a['createdAt'] as Date).getTime(),
          )[0] ?? null,
    },
  };
  const createPortalSession = vi.fn(async (p: { customerId: string }) => ({
    url: `https://billing.stripe.test/${p.customerId}`,
  }));
  const service = new SubscriptionsService(
    prisma as never,
    async () => ({ createPortalSession }) as unknown as SubscriptionsStripeAdapter,
    { publish: async () => undefined },
    { successUrl: () => '', cancelUrl: () => '' },
  );
  return { service, createPortalSession };
}

const at = (day: number) => new Date(Date.UTC(2026, 10, day));
const sub = (over: Row): Row => ({
  tenantId: T,
  userId: 'alumna',
  planId: null,
  courseId: null,
  status: 'ACTIVE',
  stripeCustomerId: 'cus_x',
  createdAt: at(1),
  ...over,
});

describe('SubscriptionsService.createBillingPortalSession', () => {
  it('sin id: la membresía viva más reciente, aunque haya una suscripción a un curso más nueva', async () => {
    const { service, createPortalSession } = build([
      sub({
        id: 's-vieja',
        planId: 'p',
        status: 'CANCELED',
        stripeCustomerId: 'cus_vieja',
        createdAt: at(1),
      }),
      sub({
        id: 's-viva',
        planId: 'p',
        status: 'TRIALING',
        stripeCustomerId: 'cus_viva',
        createdAt: at(2),
      }),
      sub({ id: 's-curso', courseId: 'c', stripeCustomerId: 'cus_curso', createdAt: at(3) }),
    ]);
    const result = await service.createBillingPortalSession(T, 'alumna', {
      returnUrl: 'https://aula.test/cuenta?tab=suscripcion',
    });
    expect(result).toEqual({
      url: 'https://billing.stripe.test/cus_viva',
      subscriptionId: 's-viva',
    });
    expect(createPortalSession).toHaveBeenCalledWith({
      customerId: 'cus_viva',
      returnUrl: 'https://aula.test/cuenta?tab=suscripcion',
    });
  });

  it('sin membresía viva: su suscripción más reciente con cliente de Stripe', async () => {
    const { service } = build([
      sub({ id: 's-pendiente', stripeCustomerId: '', status: 'PENDING', createdAt: at(5) }),
      sub({ id: 's-curso', courseId: 'c', stripeCustomerId: 'cus_curso', createdAt: at(3) }),
    ]);
    const result = await service.createBillingPortalSession(T, 'alumna', {
      returnUrl: 'https://x',
    });
    expect(result.subscriptionId).toBe('s-curso');
  });

  it('con id: solo la suya; la de otra persona o de otra aula responde «no encontrada»', async () => {
    const { service, createPortalSession } = build([
      sub({ id: 's-suya', stripeCustomerId: 'cus_suya' }),
      sub({ id: 's-ajena', userId: 'otra', stripeCustomerId: 'cus_ajena' }),
      sub({ id: 's-otra-aula', tenantId: OTRO_T, stripeCustomerId: 'cus_otra_aula' }),
    ]);
    expect(
      (
        await service.createBillingPortalSession(T, 'alumna', {
          subscriptionId: 's-suya',
          returnUrl: 'x',
        })
      ).subscriptionId,
    ).toBe('s-suya');
    for (const subscriptionId of ['s-ajena', 's-otra-aula', 'no-existe']) {
      await expect(
        service.createBillingPortalSession(T, 'alumna', { subscriptionId, returnUrl: 'x' }),
      ).rejects.toBeInstanceOf(SubscriptionNotFoundError);
    }
    expect(createPortalSession).toHaveBeenCalledTimes(1);
  });

  it('sin ninguna suscripción con cliente de Stripe → «no encontrada», sin llamar a Stripe', async () => {
    const { service, createPortalSession } = build([
      sub({ id: 's-pendiente', stripeCustomerId: '', status: 'PENDING' }),
    ]);
    await expect(
      service.createBillingPortalSession(T, 'alumna', { returnUrl: 'x' }),
    ).rejects.toBeInstanceOf(SubscriptionNotFoundError);
    expect(createPortalSession).not.toHaveBeenCalled();
  });
});
