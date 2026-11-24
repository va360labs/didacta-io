// @vitest-environment jsdom

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Pestaña Suscripción pintada de verdad (react-dom, catálogos reales): solo
 * se sustituye la red. Fija lo que añade un aula con niveles a la tarjeta de
 * la membresía: el nombre del nivel, «Cambiar de plan» solo si la API ofrece
 * opciones y nada lo impide (si algo lo impide, por qué), y «Pasar a … (gratis)»
 * que abre la baja de siempre. Sin opciones, la tarjeta queda como estaba.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import es from '@/i18n/messages/es';
import type { PlanChangeOptions, SubscriptionRow } from '@/modules/subscriptions';
import { SubscriptionTab } from './subscription-tab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MEMBERSHIP = {
  id: 'sub-1',
  tenantId: 't1',
  userId: 'u1',
  courseId: null,
  planId: 'p-basic-m',
  planName: 'Básico mensual',
  tierId: 'tier-basic',
  tierName: 'Básico',
  stripeSubscriptionId: 'sub_123',
  stripeCustomerId: 'cus_123',
  stripePriceId: 'price_123',
  status: 'ACTIVE',
  unitAmount: 1900,
  currency: 'eur',
  interval: 'month',
  currentPeriodEnd: '2026-12-14T17:29:11.000Z',
  cancelAtPeriodEnd: false,
  gracePeriodEndsAt: null,
  canceledAt: null,
  canceledReason: null,
  trialEndsAt: null,
  createdAt: '2026-11-14T17:29:11.000Z',
  updatedAt: '2026-11-14T17:29:11.000Z',
} as SubscriptionRow;

const OPTIONS: PlanChangeOptions = {
  subscription: {
    id: 'sub-1',
    status: 'ACTIVE',
    planId: 'p-basic-m',
    planName: 'Básico mensual',
    tierId: 'tier-basic',
    tierName: 'Básico',
    amountCents: 1900,
    currency: 'eur',
    intervalMonths: 1,
  },
  blockedReason: null,
  options: [
    {
      planId: 'p-pro-m',
      planName: 'Pro mensual',
      tierId: 'tier-pro',
      tierName: 'Pro',
      intervalMonths: 1,
      amountCents: 4900,
      currency: 'eur',
      compareAtCents: null,
      isFeatured: false,
      direction: 'upgrade',
    },
  ],
  freeTier: { id: 'tier-free', name: 'Comunidad' },
};

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
let optionCalls = 0;

function stubApi(subs: SubscriptionRow[], options: PlanChangeOptions | 'error') {
  optionCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/v1/modules/subscriptions/me')) {
        return new Response(JSON.stringify({ subscriptions: subs }), { status: 200 });
      }
      if (url.endsWith('/me/membership/change-options')) {
        optionCalls += 1;
        return options === 'error'
          ? new Response('{}', { status: 500 })
          : new Response(JSON.stringify(options), { status: 200 });
      }
      if (url.includes('/me/sub-1/leave')) {
        return new Response(
          JSON.stringify({
            subscriptionId: 'sub-1',
            canLeave: true,
            reasons: [],
            accessEndsAt: '2026-12-14T17:29:11.000Z',
            pause: null,
            discount: null,
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    }),
  );
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render(subs: SubscriptionRow[], options: PlanChangeOptions | 'error') {
  stubApi(subs, options);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="es-ES" messages={es as never} timeZone="UTC">
        <SubscriptionTab />
      </NextIntlClientProvider>,
    );
  });
  await settle();
}

const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  localStorage.setItem('didacta.access_token', 'token-de-prueba');
});

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('Suscripción con niveles', () => {
  it('nivel, «Cambiar de plan» y «Pasar a gratis»', async () => {
    await render([MEMBERSHIP], OPTIONS);
    expect(byTestId('sub-nivel')!.textContent).toBe('Nivel: Básico');
    expect(byTestId('sub-cambio-bloqueado')).toBeNull();
    const cambiar = byTestId('sub-cambiar-plan')!;
    expect(cambiar.textContent).toBe('Cambiar de plan');
    await act(async () => cambiar.click());
    await settle();
    expect(byTestId('cambio-plan-dialogo')).not.toBeNull();
    expect(byTestId('cambio-plan-opcion-p-pro-m')).not.toBeNull();
  });

  it('«Pasar a … (gratis)» abre la baja de siempre', async () => {
    await render([MEMBERSHIP], OPTIONS);
    const gratis = byTestId('sub-pasar-a-gratis')!;
    expect(gratis.textContent).toBe('Pasar a Comunidad (gratis)');
    await act(async () => gratis.click());
    await settle();
    expect(byTestId('baja-dialogo')).not.toBeNull();
  });

  it('si algo lo impide, explica por qué en vez del botón', async () => {
    await render([{ ...MEMBERSHIP, status: 'PAST_DUE' }], {
      ...OPTIONS,
      blockedReason: 'not_active',
    });
    expect(byTestId('sub-cambiar-plan')).toBeNull();
    expect(byTestId('sub-cambio-bloqueado')!.textContent).toContain(
      'tu suscripción no está al día',
    );
  });

  it('con la baja programada: lo dice y no ofrece pasar a gratis', async () => {
    await render([{ ...MEMBERSHIP, cancelAtPeriodEnd: true }], {
      ...OPTIONS,
      blockedReason: 'cancel_scheduled',
    });
    expect(byTestId('sub-cambio-bloqueado')!.textContent).toContain('Tienes la baja programada');
    expect(byTestId('sub-pasar-a-gratis')).toBeNull();
  });

  it('aula sin niveles (sin opciones): la tarjeta como siempre', async () => {
    await render([{ ...MEMBERSHIP, tierId: null, tierName: null }], {
      ...OPTIONS,
      subscription: { ...OPTIONS.subscription!, tierId: null, tierName: null },
      options: [],
      freeTier: null,
    });
    expect(byTestId('sub-nivel')).toBeNull();
    expect(byTestId('sub-cambiar-plan')).toBeNull();
    expect(byTestId('sub-cambio-bloqueado')).toBeNull();
    expect(byTestId('sub-pasar-a-gratis')).toBeNull();
    expect(byTestId('sub-darme-de-baja')).not.toBeNull();
  });

  it('si la API de cambios no contesta, la tarjeta queda como siempre', async () => {
    await render([MEMBERSHIP], 'error');
    expect(byTestId('sub-nivel')!.textContent).toBe('Nivel: Básico');
    expect(byTestId('sub-cambiar-plan')).toBeNull();
    expect(byTestId('sub-darme-de-baja')).not.toBeNull();
  });

  it('sin membresía (solo cursos) no pregunta por cambios de plan', async () => {
    await render(
      [{ ...MEMBERSHIP, planId: null, planName: null, courseId: 'c1', courseTitle: 'Acuarela' }],
      OPTIONS,
    );
    expect(optionCalls).toBe(0);
    expect(byTestId('sub-cambiar-plan')).toBeNull();
  });
});
