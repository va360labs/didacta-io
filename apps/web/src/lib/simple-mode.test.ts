/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import {
  canPublish,
  currentStep,
  saleState,
  startHereHeadline,
  type StartHereView,
} from './simple-mode';

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

describe('cobros conectados sin datos fiscales (ensayo general)', () => {
  const pasos = (hechos: string[]) =>
    (['academy', 'course', 'price', 'payments', 'publish', 'invite'] as const).map((id) => ({
      id,
      done: hechos.includes(id),
    }));

  it('el paso de cobros sigue pendiente, pero lo publicado SÍ se puede comprar', () => {
    // La API marca «payments» sin hacer y `taxProfilePending`: el dinero se
    // retendría, pero el alumno puede pagar.
    expect(
      saleState({
        salePath: '/catalog/x',
        steps: pasos(['academy', 'course', 'price', 'publish']),
        taxProfilePending: true,
      }),
    ).toBe('on-sale');
    // Control: sin cuenta de cobros (sin la marca) nadie puede pagar.
    expect(
      saleState({ salePath: '/catalog/x', steps: pasos(['academy', 'course', 'price']) }),
    ).toBe('not-purchasable');
  });

  it('se puede publicar ya (web #39): el paso abierto es «Publica», no «Conecta tus cobros»', () => {
    const vista = { steps: pasos(['academy', 'course', 'price']), taxProfilePending: true };
    expect(currentStep(vista)).toBe('publish');
    expect(canPublish(vista)).toBe(true);
    // Control: sin cuenta de cobros lista, ni se abre «Publica» ni se puede publicar.
    const sinCuenta = { steps: pasos(['academy', 'course', 'price']) };
    expect(currentStep(sinCuenta)).toBe('payments');
    expect(canPublish(sinCuenta)).toBe(false);
    // Publicado con los fiscales pendientes: lo siguiente es invitar.
    expect(
      currentStep({
        steps: pasos(['academy', 'course', 'price', 'publish']),
        taxProfilePending: true,
      }),
    ).toBe('invite');
    // Y sin curso con lección no se publica aunque la cuenta pueda cobrar.
    expect(canPublish({ steps: pasos(['academy', 'price']), taxProfilePending: true })).toBe(false);
  });
});
