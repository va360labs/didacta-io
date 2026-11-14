// @vitest-environment jsdom

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * El botón de compra con el precio que el alumno tiene delante (venta real del
 * 14-nov-2026: la página enseñaba 29 € y se cobró 1 €). Si el precio cambió con
 * la página abierta, la API responde 409 BILLING_PRICE_CHANGED: el botón NO
 * redirige al pago, avisa y pide a la pantalla que refresque el precio.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import es from '@/i18n/messages/es';
import { ApiHttpError } from '@/lib/api-client';

const startCheckout = vi.fn();

vi.mock('@/modules/billing', () => ({ billingApi: { startCheckout } }));
vi.mock('@/lib/auth-storage', () => ({ authStorage: { getAccessToken: () => 'jwt' } }));
vi.mock('@/lib/referrals', () => ({ getStoredReferralCode: () => null }));
vi.mock('@/components/withdrawal-waiver-checkbox', () => ({
  WithdrawalWaiverCheckbox: () => null,
  useWithdrawalWaiver: () => ({
    waiver: null,
    failed: false,
    checked: true,
    setChecked: () => undefined,
    reload: () => undefined,
    acceptance: { version: 'v1', textHash: 'h' },
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  startCheckout.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(onPriceChanged: () => void) {
  const { BuyCourseButton } = await import('./buy-course-button');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="es-ES" messages={es}>
        <BuyCourseButton
          courseId="curso-1"
          optionId="opcion-1"
          expectedPrice={{ unitAmount: 2900, currency: 'eur' }}
          onPriceChanged={onPriceChanged}
        />
      </NextIntlClientProvider>,
    );
  });
}

async function click() {
  const button = container.querySelector('button')!;
  await act(async () => {
    button.click();
  });
}

describe('BuyCourseButton — el precio cambió con la página abierta', () => {
  it('manda el precio que ve el alumno', async () => {
    startCheckout.mockReturnValue(new Promise(() => undefined));
    await render(vi.fn());
    await click();
    expect(startCheckout).toHaveBeenCalledWith(
      'curso-1',
      'jwt',
      'opcion-1',
      { version: 'v1', textHash: 'h' },
      undefined,
      { unitAmount: 2900, currency: 'eur' },
    );
  });

  it('409 BILLING_PRICE_CHANGED: avisa, no redirige y pide refrescar el precio', async () => {
    startCheckout.mockRejectedValue(
      new ApiHttpError({
        status: 409,
        code: 'BILLING_PRICE_CHANGED',
        message: 'El precio de este curso ha cambiado',
      }),
    );
    const onPriceChanged = vi.fn();
    await render(onPriceChanged);
    await click();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      es.playersContenido.buyCourse.errors.BILLING_PRICE_CHANGED,
    );
    expect(onPriceChanged).toHaveBeenCalledTimes(1);
    // Se puede volver a pulsar (ya con el precio nuevo en pantalla).
    expect(container.querySelector('button')!.disabled).toBe(false);
  });

  it('control: otro error no pide refrescar el precio', async () => {
    startCheckout.mockRejectedValue(
      new ApiHttpError({ status: 502, code: 'BILLING_STRIPE_API_ERROR', message: 'x' }),
    );
    const onPriceChanged = vi.fn();
    await render(onPriceChanged);
    await click();
    expect(onPriceChanged).not.toHaveBeenCalled();
  });
});
