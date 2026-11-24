// @vitest-environment jsdom

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * «Cambiar de plan» pintado de verdad (react-dom, catálogos reales): solo se
 * sustituye la red. Fija las opciones agrupadas por nivel, lo que se explica
 * en cada caso (subir cobra hoy, bajar deja saldo, la prueba gratis no cobra),
 * lo que se manda a la API, que una tarjeta rechazada no cambia nada y que en
 * portugués e inglés no se cuela español.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/en';
import es from '@/i18n/messages/es';
import pt from '@/i18n/messages/pt';
import type { PlanChangeOptions, PlanChangePreview } from '@/modules/subscriptions';
import { ChangePlanDialog, groupByTier } from './change-plan-dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
      planId: 'p-basic-y',
      planName: 'Básico anual',
      tierId: 'tier-basic',
      tierName: 'Básico',
      intervalMonths: 12,
      amountCents: 19000,
      currency: 'eur',
      compareAtCents: 22800,
      isFeatured: true,
      direction: 'downgrade',
    },
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
  freeTier: null,
};

/** Alguien en Pro que puede bajar a Básico. */
const FROM_PRO: PlanChangeOptions = {
  ...OPTIONS,
  subscription: {
    ...OPTIONS.subscription!,
    planId: 'p-pro-m',
    planName: 'Pro mensual',
    tierId: 'tier-pro',
    tierName: 'Pro',
    amountCents: 4900,
  },
  options: [
    {
      planId: 'p-basic-m',
      planName: 'Básico mensual',
      tierId: 'tier-basic',
      tierName: 'Básico',
      intervalMonths: 1,
      amountCents: 1900,
      currency: 'eur',
      compareAtCents: null,
      isFeatured: false,
      direction: 'downgrade',
    },
  ],
};

const CATALOGS = { es, en, pt } as const;
const LOCALES = { es: 'es-ES', en: 'en-US', pt: 'pt-BR' } as const;
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
let previewed: string[] = [];
let changed: string[] = [];

function stubApi(preview: Omit<PlanChangePreview, 'planId'>, change: 'ok' | 'card_declined') {
  previewed = [];
  changed = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as { planId: string }) : null;
      if (url.endsWith('/me/membership/change-preview') && init?.method === 'POST') {
        previewed.push(body!.planId);
        return new Response(JSON.stringify({ ...preview, planId: body!.planId }), {
          status: 200,
        });
      }
      if (url.endsWith('/me/membership/change') && init?.method === 'POST') {
        changed.push(body!.planId);
        if (change === 'card_declined') {
          return new Response(
            JSON.stringify({
              code: 'MEMBERSHIP_PLAN_CHANGE_PAYMENT_FAILED',
              message: 'card declined',
            }),
            { status: 402 },
          );
        }
        return new Response(
          JSON.stringify({
            subscription: { id: 'sub-1', planId: body!.planId, status: 'ACTIVE' },
            direction: preview.direction,
            charged:
              preview.amountDueNow > 0
                ? { amountCents: preview.amountDueNow, currency: preview.currency }
                : null,
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    }),
  );
}

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render(locale: keyof typeof CATALOGS, options = OPTIONS, onDone = vi.fn()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <NextIntlClientProvider
        locale={LOCALES[locale]}
        messages={CATALOGS[locale] as never}
        timeZone="UTC"
      >
        <ChangePlanDialog options={options} open onOpenChange={() => undefined} onDone={onDone} />
      </NextIntlClientProvider>,
    );
  });
  await settle();
  return onDone;
}

const q = (sel: string) => document.body.querySelector<HTMLElement>(sel);
const byTestId = (id: string) => q(`[data-testid="${id}"]`);
async function click(id: string) {
  const el = byTestId(id);
  if (!el) throw new Error(`no está ${id}`);
  await act(async () => el.click());
  await settle();
}

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

describe('groupByTier', () => {
  it('agrupa por nivel conservando el orden de la API', () => {
    expect(
      groupByTier(OPTIONS.options).map((g) => [g.tierName, g.options.map((o) => o.planId)]),
    ).toEqual([
      ['Básico', ['p-basic-y']],
      ['Pro', ['p-pro-m']],
    ]);
  });
});

describe('«Cambiar de plan»', () => {
  it('subir: dice lo que se cobra hoy, lo cobra y avisa con lo cobrado', async () => {
    stubApi(
      {
        direction: 'upgrade',
        trialing: false,
        amountDueNow: 1500,
        creditCents: 0,
        currency: 'eur',
      },
      'ok',
    );
    const onDone = await render('es');
    const dialog = byTestId('cambio-plan-dialogo')!;
    expect(dialog.textContent).toMatch(/Ahora estás en Básico y pagas 19,00\s€\/mes/);
    // Las opciones, agrupadas por nivel; el suyo, señalado.
    expect(dialog.textContent).toContain('(tu nivel ahora)');
    expect(byTestId('cambio-plan-opcion-p-basic-y')!.textContent).toContain('Pagas menos al mes');
    expect(byTestId('cambio-plan-opcion-p-basic-y')!.textContent).toContain('Recomendado');
    expect(byTestId('cambio-plan-opcion-p-pro-m')!.textContent).toContain('Pagas más al mes');
    // Sin elegir, no se puede confirmar.
    expect((byTestId('cambio-plan-confirmar') as HTMLButtonElement).disabled).toBe(true);

    await click('cambio-plan-opcion-p-pro-m');
    expect(previewed).toEqual(['p-pro-m']);
    const resumen = byTestId('cambio-plan-resumen')!.textContent ?? '';
    expect(resumen).toMatch(/Hoy se te cobrarán 15,00\s€/);
    expect(resumen).toMatch(/Después pagarás 49,00\s€\/mes/);
    expect(resumen).toContain('desde hoy tienes todo lo que incluye Pro');
    expect(byTestId('cambio-plan-confirmar')!.textContent).toMatch(/Pagar 15,00\s€ y cambiar/);

    await click('cambio-plan-confirmar');
    expect(changed).toEqual(['p-pro-m']);
    const ok = byTestId('cambio-plan-ok')!.textContent ?? '';
    expect(ok).toMatch(/Hecho: ahora tienes Pro por 49,00\s€\/mes/);
    expect(ok).toMatch(/Hoy se te han cobrado 15,00\s€/);
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'upgrade' }),
      expect.objectContaining({ planId: 'p-pro-m' }),
    );
  });

  it('bajar: hoy no se cobra nada y la próxima factura baja', async () => {
    stubApi(
      {
        direction: 'downgrade',
        trialing: false,
        amountDueNow: 0,
        creditCents: 2000,
        currency: 'eur',
      },
      'ok',
    );
    await render('es', FROM_PRO);
    await click('cambio-plan-opcion-p-basic-m');
    const resumen = byTestId('cambio-plan-resumen')!.textContent ?? '';
    expect(resumen).toContain('Hoy no se te cobra nada.');
    expect(resumen).toMatch(/Tu próxima factura bajará 20,00\s€/);
    expect(resumen).toContain('Y dejas de tener lo que solo incluye Pro.');
    expect(byTestId('cambio-plan-confirmar')!.textContent).toBe('Confirmar el cambio');
    await click('cambio-plan-confirmar');
    expect(byTestId('cambio-plan-ok')!.textContent).not.toContain('cobrado');
  });

  it('en la prueba gratis: no se cobra nada y se paga el plan nuevo al acabar', async () => {
    stubApi(
      { direction: 'upgrade', trialing: true, amountDueNow: 0, creditCents: 0, currency: 'eur' },
      'ok',
    );
    await render('es');
    await click('cambio-plan-opcion-p-pro-m');
    expect(byTestId('cambio-plan-resumen')!.textContent).toMatch(
      /Sigues en tu prueba gratis: hoy no se te cobra nada\. Cuando termine, pagarás 49,00\s€\/mes/,
    );
    expect(byTestId('cambio-plan-confirmar')!.textContent).toBe('Confirmar el cambio');
  });

  it('si la tarjeta falla al subir, lo dice y el plan no cambia', async () => {
    stubApi(
      {
        direction: 'upgrade',
        trialing: false,
        amountDueNow: 1500,
        creditCents: 0,
        currency: 'eur',
      },
      'card_declined',
    );
    const onDone = await render('es');
    await click('cambio-plan-opcion-p-pro-m');
    await click('cambio-plan-confirmar');
    expect(byTestId('cambio-plan-ok')).toBeNull();
    expect(q('[role="alert"]')!.textContent).toContain('Tu plan no ha cambiado');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('en portugués y en inglés no se cuela español', async () => {
    for (const locale of ['pt', 'en'] as const) {
      stubApi(
        {
          direction: 'upgrade',
          trialing: false,
          amountDueNow: 1500,
          creditCents: 0,
          currency: 'eur',
        },
        'ok',
      );
      await render(locale);
      await click('cambio-plan-opcion-p-pro-m');
      const text = byTestId('cambio-plan-dialogo')!.textContent ?? '';
      expect(text).not.toMatch(/Ahora estás|Pagas más|se te cobra|Después|Confirmar el|\/mes\b/);
      for (const { root, container } of mounted.splice(0)) {
        await act(async () => root.unmount());
        container.remove();
      }
    }
  });
});
