/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { describe, expect, it } from 'vitest';
import { bpsToPercent, estimateTakeHome, type PriceFees } from './price-estimate';

/** Lo que manda la API por defecto: tarjeta 1,5 % + 0,25 € y Didacta 5 % (500 bps). */
const CLOUD: PriceFees = {
  platformFeeBps: 500,
  operatorName: 'Didacta',
  cardFeeBps: 150,
  cardFeeFixed: 25,
};

describe('estimateTakeHome', () => {
  it('con 1 € te llegan 0,68 € (el ejemplo de la venta real)', () => {
    // Tarjeta: 1,5 % de 1 € = 0,015 → 0,02 + 0,25 = 0,27 €; Didacta: 0,05 €.
    expect(estimateTakeHome(100, CLOUD)).toEqual({
      amount: 100,
      cardFee: 27,
      platformFee: 5,
      net: 68,
    });
  });

  it('con 49 €: tarjeta 0,99 €, Didacta 2,45 €, te llegan 45,56 €', () => {
    expect(estimateTakeHome(4900, CLOUD)).toEqual({
      amount: 4900,
      cardFee: 99,
      platformFee: 245,
      net: 4556,
    });
  });

  it('redondea cada comisión con el medio hacia arriba, como el reparto real', () => {
    // 11971 al 5 % = 598,55 → 599 (mismo caso que `computePlatformFee`).
    expect(estimateTakeHome(11971, CLOUD)!.platformFee).toBe(599);
  });

  it('con claves propias no hay comisión del operador, solo la de la tarjeta', () => {
    const propias: PriceFees = { ...CLOUD, platformFeeBps: null, operatorName: null };
    expect(estimateTakeHome(4900, propias)).toMatchObject({ platformFee: 0, net: 4801 });
  });

  it('la comisión que manda la API, no una constante: con 10 % el neto baja', () => {
    expect(estimateTakeHome(4900, { ...CLOUD, platformFeeBps: 1000 })!.platformFee).toBe(490);
  });

  it('sin precio, nada; y nunca un neto negativo', () => {
    expect(estimateTakeHome(0, CLOUD)).toBeNull();
    expect(estimateTakeHome(Number.NaN, CLOUD)).toBeNull();
    expect(estimateTakeHome(10, CLOUD)!.net).toBe(0);
  });

  it('porcentajes legibles en el idioma', () => {
    expect(bpsToPercent(150, 'es-ES')).toBe('1,5');
    expect(bpsToPercent(500, 'en-US')).toBe('5');
  });
});
