/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import type { PayoutsSummaryDto } from '@/lib/payouts';
import { bpsToPercentInput, percentToBps, primaryCurrency, referralSales } from './sales-math';

function fila(currency: string, salesCount: number, gross = 0) {
  return {
    currency,
    salesCount,
    gross,
    stripeFees: 0,
    platformFees: 0,
    received: 100,
    pending: 50,
    debtNetted: 0,
    debtOutstanding: 0,
    refunded: 0,
    reversed: 0,
  };
}

describe('Ventas (modo sencillo): resumen', () => {
  it('sin ventas no hay resumen: se enseña el estado vacío', () => {
    expect(primaryCurrency(null)).toBeNull();
    expect(
      primaryCurrency({ currencies: [fila('eur', 0)] } as unknown as PayoutsSummaryDto),
    ).toBeNull();
  });

  it('manda la moneda con más ventas', () => {
    const s = {
      currencies: [fila('usd', 2, 200), fila('eur', 26, 127400)],
    } as unknown as PayoutsSummaryDto;
    expect(primaryCurrency(s)).toEqual({
      currency: 'eur',
      salesCount: 26,
      gross: 127400,
      received: 100,
      pending: 50,
    });
  });
});

describe('Ventas (modo sencillo): referidos', () => {
  it('cuenta las ventas traídas por referidos y no las anuladas', () => {
    const r = referralSales([
      { status: 'PENDING', baseAmountCents: 1200, currency: 'eur' },
      { status: 'PAID', baseAmountCents: 1200, currency: 'eur' },
      { status: 'REVOKED', baseAmountCents: 1200, currency: 'eur' },
    ]);
    expect(r).toEqual({ count: 2, byCurrency: [{ currency: 'eur', base: 2400 }] });
  });

  it('el % se escribe como persona y se guarda en puntos básicos', () => {
    expect(percentToBps('10')).toBe(1000);
    expect(percentToBps('12,5')).toBe(1250);
    expect(percentToBps('101')).toBeNull();
    expect(percentToBps('abc')).toBeNull();
    expect(bpsToPercentInput(1000)).toBe('10');
    expect(bpsToPercentInput(1250)).toBe('12,5');
  });
});
