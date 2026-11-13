/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { startHereHeadline, type StartHereView } from './simple-mode';

type Vista = Pick<StartHereView, 'salePath' | 'steps' | 'sales'>;

function vista(hechos: string[], opts: { salePath?: string | null; ventas?: number } = {}): Vista {
  const ids = ['academy', 'course', 'price', 'payments', 'publish', 'invite'] as const;
  return {
    salePath: opts.salePath ?? null,
    steps: ids.map((id) => ({ id, done: hechos.includes(id) })),
    sales: { count: opts.ventas ?? 0, firstSaleAt: null },
  };
}

describe('startHereHeadline', () => {
  it('sin publicar: «casi lista para vender»', () => {
    expect(startHereHeadline(vista(['academy', 'course', 'price']))).toBe('casi');
  });

  it('publicada pero sin cobros: sigue «casi» (nadie puede pagar aún)', () => {
    expect(
      startHereHeadline(vista(['academy', 'course', 'price'], { salePath: '/catalog/x' })),
    ).toBe('casi');
  });

  it('a la venta aunque falte invitar: «ya está a la venta»', () => {
    expect(
      startHereHeadline(
        vista(['academy', 'course', 'price', 'payments', 'publish'], { salePath: '/catalog/x' }),
      ),
    ).toBe('listo');
  });

  it('con todos los pasos hechos: «ya está a la venta»', () => {
    expect(
      startHereHeadline(
        vista(['academy', 'course', 'price', 'payments', 'publish', 'invite'], {
          salePath: '/catalog/x',
        }),
      ),
    ).toBe('listo');
  });

  it('tras la primera venta: la celebración', () => {
    expect(
      startHereHeadline(
        vista(['academy', 'course', 'price', 'payments', 'publish', 'invite'], {
          salePath: '/catalog/x',
          ventas: 1,
        }),
      ),
    ).toBe('celebra');
  });
});
