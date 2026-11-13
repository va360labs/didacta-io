/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { couponsAtCheckout, showLocalCurrencyNote } from './checkout-hints';

describe('showLocalCurrencyNote', () => {
  it('sí, cuando el servidor dice que el pago lo enseña en la moneda del alumno', () => {
    expect(showLocalCurrencyNote({ localCurrencyAtCheckout: true })).toBe(true);
  });

  it('no, con el precio en otra moneda o con claves propias (false)', () => {
    expect(showLocalCurrencyNote({ localCurrencyAtCheckout: false })).toBe(false);
  });

  it('no, sin el campo (Community o servidor anterior) ni sin precio elegido', () => {
    expect(showLocalCurrencyNote({})).toBe(false);
    expect(showLocalCurrencyNote(null)).toBe(false);
    expect(showLocalCurrencyNote(undefined)).toBe(false);
  });
});

describe('couponsAtCheckout', () => {
  it('cobro por la plataforma: no se promete ningún cupón', () => {
    expect(couponsAtCheckout({ couponsAtCheckout: false })).toBe(false);
  });

  it('claves propias: cupones como siempre', () => {
    expect(couponsAtCheckout({ couponsAtCheckout: true })).toBe(true);
  });

  it('sin el campo (Community o servidor anterior): como siempre', () => {
    expect(couponsAtCheckout({})).toBe(true);
  });
});
