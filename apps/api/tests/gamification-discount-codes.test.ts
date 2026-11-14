/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { discountCodesAllowedFor } from '../src/modules/gamification/discount-codes-allowed';
import type { PaymentMode } from '../src/modules/payment-mode.resolver';

describe('premio «código de descuento» según el modo de cobro del aula', () => {
  it('modo plataforma (Didacta Cloud): no, esté o no lista la cuenta conectada', () => {
    const ready: PaymentMode = {
      mode: 'platform',
      ready: true,
      stripeAccountId: 'acct_1',
      country: 'ES',
      feeBps: 500,
    };
    const notReady: PaymentMode = { mode: 'platform', ready: false, reason: 'not_connected' };
    expect(discountCodesAllowedFor(ready)).toBe(false);
    expect(discountCodesAllowedFor(notReady)).toBe(false);
  });

  it('claves propias: sí (el checkout del aula acepta sus códigos promocionales)', () => {
    const own = { mode: 'own', credentials: {} } as unknown as PaymentMode;
    expect(discountCodesAllowedFor(own)).toBe(true);
  });

  it('sin cobros configurados: sí (funcionarán cuando conecte sus claves)', () => {
    expect(discountCodesAllowedFor({ mode: 'none' })).toBe(true);
  });
});
