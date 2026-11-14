/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import {
  canPublish,
  currentStep,
  priceToConfirm,
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

describe('precio de partida del alta (venta real: se publicó a un precio que nadie miró)', () => {
  const pasos = (hechos: string[]) =>
    (['academy', 'course', 'price', 'payments', 'publish', 'invite'] as const).map((id) => ({
      id,
      done: hechos.includes(id),
    }));
  const oferta = (amountCents: number) => ({
    kind: 'course' as const,
    courseId: 'c1',
    planId: null,
    amountCents,
    currency: 'eur',
    courseTitle: 'Curso',
    courseSlug: 'curso',
    courseCoverUrl: null,
  });

  it('sin confirmar, el paso «Precio» queda pendiente pero no bloquea: se abre «Publica»', () => {
    const vista = {
      steps: pasos(['academy', 'course', 'payments']),
      offer: oferta(2900),
      priceConfirmed: false,
    };
    expect(priceToConfirm(vista)).toBe(true);
    expect(currentStep(vista)).toBe('publish');
    expect(canPublish(vista)).toBe(true);
  });

  it('control: sin precio no hay nada que confirmar y el paso «Precio» manda', () => {
    const vista = {
      steps: pasos(['academy', 'course', 'payments']),
      offer: oferta(0),
      priceConfirmed: false,
    };
    expect(priceToConfirm(vista)).toBe(false);
    expect(currentStep(vista)).toBe('price');
    expect(canPublish(vista)).toBe(false);
  });

  it('confirmado (o una API anterior, sin el campo) no hay nada pendiente', () => {
    const hecho = pasos(['academy', 'course', 'price', 'payments']);
    expect(priceToConfirm({ steps: hecho, offer: oferta(2900), priceConfirmed: true })).toBe(false);
    expect(priceToConfirm({ steps: hecho, offer: oferta(2900) })).toBe(false);
    expect(currentStep({ steps: hecho, offer: oferta(2900) })).toBe('publish');
  });
});
