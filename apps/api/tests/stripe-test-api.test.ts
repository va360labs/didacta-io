/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { withStripeTestApi } from '../src/modules/stripe-test-api';

class FakeStripe {
  constructor(
    readonly key: string,
    readonly opts?: Record<string, unknown>,
  ) {}
}

describe('doble de Stripe (STRIPE_TEST_API_URL)', () => {
  it('sin la variable, el constructor es el de siempre', () => {
    expect(withStripeTestApi(FakeStripe, {})).toBe(FakeStripe);
  });

  it('con clave de prueba, apunta al doble', () => {
    const C = withStripeTestApi(FakeStripe, { STRIPE_TEST_API_URL: 'http://127.0.0.1:12111' });
    const s = new C('sk_test_x', { timeout: 10 });
    expect(s.opts).toEqual({ timeout: 10, host: '127.0.0.1', port: 12111, protocol: 'http' });
  });

  it('control: con clave real NUNCA sale hacia el doble', () => {
    const C = withStripeTestApi(FakeStripe, { STRIPE_TEST_API_URL: 'http://127.0.0.1:12111' });
    const s = new C('sk_live_x', { timeout: 10 });
    expect(s.opts).toEqual({ timeout: 10 });
  });
});
