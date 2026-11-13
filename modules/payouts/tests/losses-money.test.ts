/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Aritmética de las devoluciones (E6): de qué bolsillo sale cada céntimo de un
 * reembolso o una disputa, con redondeo sobre lo ACUMULADO.
 */

import { describe, expect, it } from 'vitest';
import { PayoutsInvalidAmountError } from '../src/errors.js';
import { chargeToSettlement, computeSplit, sharesOfGross } from '../src/money.js';
import { isSettlementEntryKey, IDEMPOTENCY_KEYS } from '../src/ledger.service.js';

const sale100 = { gross: 10000, stripeFee: 175, platformFee: 500, creatorNet: 9325 };
const saleUs = { gross: 10000, stripeFee: 340, platformFee: 500, creatorNet: 9160 };

describe('sharesOfGross', () => {
  it('reembolso total de 100 €: 93,25 del creador, 5,00 del operador, 1,75 de Stripe', () => {
    expect(sharesOfGross(sale100, 0, 10000)).toEqual({
      amount: 10000,
      creator: 9325,
      platform: 500,
      stripe: 175,
    });
  });

  it('parcial de 40 €: 37,30 / 2,00 / 0,70 (la reversión del plan: 3730)', () => {
    expect(sharesOfGross(sale100, 0, 4000)).toEqual({
      amount: 4000,
      creator: 3730,
      platform: 200,
      stripe: 70,
    });
  });

  it('tarjeta US: 91,60 / 5,00 / 3,40', () => {
    expect(sharesOfGross(saleUs, 0, 10000)).toMatchObject({
      creator: 9160,
      platform: 500,
      stripe: 340,
    });
  });

  it('parciales que suman el total devuelven EXACTAMENTE la venta (sin deriva de redondeo)', () => {
    for (const parts of [
      [3333, 3333, 3334],
      [1, 9999],
      [4000, 6000],
      [7, 13, 9980],
      Array.from({ length: 100 }, () => 100),
    ]) {
      let consumed = 0;
      const total = { creator: 0, platform: 0, stripe: 0 };
      for (const part of parts) {
        const shares = sharesOfGross(sale100, consumed, part);
        expect(shares.creator + shares.platform + shares.stripe).toBe(part);
        total.creator += shares.creator;
        total.platform += shares.platform;
        total.stripe += shares.stripe;
        consumed += part;
      }
      expect(total).toEqual({ creator: 9325, platform: 500, stripe: 175 });
    }
  });

  it('las comisiones del reparto de la tabla de E1 cuadran en cualquier divisa', () => {
    const split = computeSplit({ gross: 11971, stripeFee: 563, feeBps: 500 });
    const shares = sharesOfGross(split, 0, 11971);
    expect(shares).toMatchObject({ creator: 10809, platform: 599, stripe: 563 });
  });

  it('no deja devolver más que el bruto', () => {
    expect(() => sharesOfGross(sale100, 6000, 4001)).toThrow(PayoutsInvalidAmountError);
  });
});

describe('chargeToSettlement', () => {
  it('misma divisa: identidad', () => {
    expect(
      chargeToSettlement({ chargeAmount: 10000, gross: 10000, refundedBefore: 0, amount: 4000 }),
    ).toBe(4000);
  });

  it('cargo en USD liquidado en EUR (100 $ → 90,21 €): dos mitades suman el bruto exacto', () => {
    const first = chargeToSettlement({
      chargeAmount: 10000,
      gross: 9021,
      refundedBefore: 0,
      amount: 5000,
    });
    const second = chargeToSettlement({
      chargeAmount: 10000,
      gross: 9021,
      refundedBefore: 5000,
      amount: 5000,
    });
    expect(first + second).toBe(9021);
  });

  it('no deja reembolsar más que el cargo', () => {
    expect(() =>
      chargeToSettlement({ chargeAmount: 10000, gross: 10000, refundedBefore: 9000, amount: 1001 }),
    ).toThrow(PayoutsInvalidAmountError);
  });
});

describe('claves del libro', () => {
  it('el conciliador distingue los asientos del reparto de los de E6', () => {
    const sale = '00000000-0000-4000-8000-000000000001';
    expect(isSettlementEntryKey(IDEMPOTENCY_KEYS.saleEntry(sale, 'SALE_GROSS'))).toBe(true);
    expect(isSettlementEntryKey(IDEMPOTENCY_KEYS.transfer(sale))).toBe(true);
    expect(isSettlementEntryKey(IDEMPOTENCY_KEYS.debtNetting('d1', sale))).toBe(true);
    expect(isSettlementEntryKey(IDEMPOTENCY_KEYS.refund('r1'))).toBe(false);
    expect(isSettlementEntryKey(IDEMPOTENCY_KEYS.reversal('r1'))).toBe(false);
    expect(isSettlementEntryKey(IDEMPOTENCY_KEYS.disputeReinstatement('dp_1'))).toBe(false);
    expect(isSettlementEntryKey(IDEMPOTENCY_KEYS.debtRecovery('d1', 1))).toBe(false);
    expect(isSettlementEntryKey(`${IDEMPOTENCY_KEYS.debtRecovery('d1', 1)}:debt`)).toBe(false);
  });
});
