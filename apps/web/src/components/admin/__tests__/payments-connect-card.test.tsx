// @vitest-environment jsdom

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Tarjeta de cobros pintada de verdad (react-dom a pelo, como
 * `start-here.test.tsx`), con los catálogos reales y el estado inyectado.
 *
 * Lo que fallaba: en un ensayo general, una creadora que en el alta de Cloud
 * dijo tener el banco en «Otro país» abría «Ventas» y la tarjeta le
 * preseleccionaba España. Ahora manda lo que DECLARÓ (`declaredCountry`), por
 * detrás solo de su cuenta: «Otro país» o su país, con el aviso a la vista y el
 * botón apagado mientras el país elegido no se admita.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/en';
import es from '@/i18n/messages/es';
import pt from '@/i18n/messages/pt';
import type { PayoutsAccountDto, PayoutsStatusDto, payoutsApi } from '@/lib/payouts';
import { PaymentsConnectCard } from '../payments-connect-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CATALOGS = { es, en, pt } as const;
const LOCALES = { es: 'es-ES', en: 'en-US', pt: 'pt-BR' } as const;

function status(over: Partial<PayoutsStatusDto> = {}): PayoutsStatusDto {
  return {
    platform: true,
    operatorName: 'Didacta',
    mode: 'platform',
    ready: false,
    reason: 'not_connected',
    account: null,
    supportedCountries: ['ES', 'FR', 'DE', 'PT', 'GB', 'US'],
    declaredCountry: null,
    feeBps: 500,
    ...over,
  };
}

function disconnected(country: string): PayoutsAccountDto {
  return {
    status: 'DISCONNECTED',
    stripeAccountId: 'acct_1',
    country,
    entityType: 'individual',
    defaultCurrency: null,
    payoutsEnabled: false,
    pendingRequirement: null,
    requirementsDeadline: null,
    disabledReason: null,
    payoutSchedule: null,
    readyAt: null,
    lastSyncedAt: null,
  };
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

async function render(
  locale: keyof typeof CATALOGS,
  initial: PayoutsStatusDto,
  browserLanguage: string = LOCALES[locale],
) {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(browserLanguage);
  const connect = vi.fn();
  const api = { status: vi.fn(async () => initial), connect } as unknown as typeof payoutsApi;
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
        <PaymentsConnectCard api={api} initialStatus={initial} />
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  const select = container.querySelector<HTMLSelectElement>('#payouts-country')!;
  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const warning = () =>
    container.querySelector('[data-testid="payouts-country-unsupported"]')?.textContent ?? null;
  async function choose(code: string) {
    await act(async () => {
      select.value = code;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  return { container, select, submit, warning, choose, connect };
}

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

describe('tarjeta de cobros: el país que el creador declaró en el alta', () => {
  it('declaró «Otro país» (es): «Otro país» elegido, su aviso y el botón apagado; con España, se enciende', async () => {
    const c = await render('es', status({ declaredCountry: 'OTHER' }), 'es-ES');
    expect(c.select.value).toBe('OTHER');
    expect(c.select.selectedOptions[0]?.textContent).toBe('Otro país');
    expect(c.warning()).toBe(
      'Al darte de alta nos dijiste que tu banco está en otro país. Todavía no podemos pagar a creadores con el banco fuera de los países admitidos; si ahora lo tienes en uno de ellos, elígelo en la lista. Mientras tanto puedes montar tu academia y tu comunidad.',
    );
    expect(c.submit.disabled).toBe(true);

    await c.choose('ES');
    expect(c.warning()).toBeNull();
    expect(c.submit.disabled).toBe(false);
  });

  it('declaró Brasil (pt-BR): Brasil elegido, aviso sin «contas de Brasil» y botón apagado', async () => {
    const c = await render('pt', status({ declaredCountry: 'BR' }), 'en-US');
    expect(c.select.value).toBe('BR');
    expect(c.warning()).toBe(
      'Ainda não conseguimos fazer pagamentos para contas no país que você informou (Brasil). Enquanto isso, você pode montar sua escola e sua comunidade.',
    );
    expect(c.submit.disabled).toBe(true);
  });

  it('declaró un país que no está en ninguna lista (Japón): se añade, elegido y no admitido', async () => {
    const c = await render('en', status({ declaredCountry: 'JP' }), 'en-US');
    expect(c.select.value).toBe('JP');
    expect(c.select.selectedOptions[0]?.textContent).toBe('Japan');
    expect(c.warning()).toBe(
      "We can't pay out to accounts in Japan yet. In the meantime you can set up your academy and your community.",
    );
    expect(c.submit.disabled).toBe(true);
  });

  it('lo declarado pasa por encima del navegador: declaró España con el navegador en pt-BR', async () => {
    const c = await render('es', status({ declaredCountry: 'ES' }), 'pt-BR');
    expect(c.select.value).toBe('ES');
    expect(c.warning()).toBeNull();
    expect(c.submit.disabled).toBe(false);
  });

  it('su cuenta pasa por encima de lo declarado: cuenta desconectada en Francia', async () => {
    const c = await render('es', status({ declaredCountry: 'BR', account: disconnected('FR') }));
    expect(c.select.value).toBe('FR');
    expect(c.submit.disabled).toBe(false);
  });

  it('sin nada declarado (una API anterior), el navegador, como antes', async () => {
    const { declaredCountry: _omitido, ...antiguo } = status();
    const c = await render('es', antiguo as PayoutsStatusDto, 'es-MX');
    expect(c.select.value).toBe('MX');
    expect(c.submit.disabled).toBe(true);
    expect([...c.select.options].some((o) => o.value === 'OTHER')).toBe(false);
  });
});
