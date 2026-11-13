/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 *
 * Facturación del descuento por referidos (ADR-057, punto 4): la cuota se
 * factura ENTERA y el saldo figura aparte como «Pago con saldo de referidos»;
 * la base de la comisión de la plataforma (`fee_base` del ledger de
 * mod.payouts) es esa misma cuota entera. Dos módulos leen la misma factura
 * de Stripe: aquí se fija que llegan a las mismas cifras.
 */

import { describe, expect, it } from 'vitest';
import { invoiceCreditApplied } from '@didacta/mod-subscriptions';
import {
  computeSplit,
  creditAppliedInPresentment,
  creditInSettlementCurrency,
} from '@didacta/mod-payouts';
import { REFERRAL_CREDIT_LABEL } from '@didacta/mod-referrals';

/** Cuota de 30 € con 6 € de saldo de referidos: la tarjeta paga 24 €. */
const INVOICE = {
  total: 3000,
  amount_paid: 2400,
  starting_balance: -600,
  ending_balance: 0,
  currency: 'eur',
};

describe('factura de la cuota con saldo de referidos', () => {
  it('la factura (cuota entera − saldo aparte) y la base del ledger coinciden', () => {
    // mod.subscriptions: lo que se guarda y enseña en la factura.
    const credit = invoiceCreditApplied(INVOICE);
    expect(credit).toBe(600);
    expect(INVOICE.amount_paid + credit).toBe(INVOICE.total);

    // mod.payouts: el saldo que guarda la venta y la base de su comisión.
    const saleCredit = creditAppliedInPresentment(INVOICE, INVOICE.amount_paid, 'eur');
    expect(saleCredit).toBe(credit);
    const gross = INVOICE.amount_paid;
    const feeBase =
      gross +
      creditInSettlementCurrency(
        { customerCreditApplied: saleCredit, presentmentAmount: gross, presentmentCurrency: 'eur' },
        gross,
        'eur',
      );
    expect(feeBase).toBe(INVOICE.total);

    // 5 % de la cuota ENTERA: la plataforma cobra lo mismo con o sin descuento.
    const conDescuento = computeSplit({ gross, stripeFee: 60, feeBps: 500, feeBase });
    const sinDescuento = computeSplit({ gross: 3000, stripeFee: 69, feeBps: 500 });
    expect(conDescuento.platformFee).toBe(150);
    expect(conDescuento.platformFee).toBe(sinDescuento.platformFee);
  });

  it('el abono en el saldo de Stripe lleva la etiqueta de la línea de la factura', () => {
    expect(REFERRAL_CREDIT_LABEL).toBe('Pago con saldo de referidos');
  });
});
