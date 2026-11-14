/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { formatNumber } from './i18n/format';

/**
 * «Con 49 € te llegan ~44,25 €»: lo que le queda al creador de un precio,
 * APROXIMADO, para enseñarlo donde se pone el precio (editor del curso,
 * «Empieza aquí» y al publicar).
 *
 * Las comisiones salen de la API (`GET /admin/simple-mode/currencies` →
 * `fees`): la del operador es la vigente del aula (la que se sellará en cada
 * venta, `PAYMENTS_PLATFORM_DEFAULT_FEE_BPS` por defecto) y la de la tarjeta
 * la configurada (`PAYMENTS_PLATFORM_CARD_FEE_ESTIMATE`). La real de cada
 * cobro depende de la tarjeta (país, tipo): por eso es una estimación.
 *
 * Mismo redondeo que el reparto de verdad (`computePlatformFee` de
 * `mod.payouts`): cada comisión, al entero más cercano con el medio hacia
 * arriba.
 */
export interface PriceFees {
  /** Comisión del operador (500 = 5 %); `null` si el aula cobra con sus claves. */
  platformFeeBps: number | null;
  operatorName: string | null;
  /** Comisión aproximada de la tarjeta: puntos básicos + fijo (unidad mínima). */
  cardFeeBps: number;
  cardFeeFixed: number;
}

export interface TakeHome {
  amount: number;
  cardFee: number;
  platformFee: number;
  /** Lo que le llega; nunca negativo. */
  net: number;
}

/** `floor((amount × bps + 5000) / 10000)`: el medio hacia arriba. */
function feeOf(amount: number, bps: number): number {
  return Math.floor((amount * bps + 5000) / 10000);
}

export function estimateTakeHome(amount: number, fees: PriceFees): TakeHome | null {
  if (!Number.isInteger(amount) || amount <= 0) return null;
  const cardFee = feeOf(amount, fees.cardFeeBps) + fees.cardFeeFixed;
  const platformFee = fees.platformFeeBps === null ? 0 : feeOf(amount, fees.platformFeeBps);
  return { amount, cardFee, platformFee, net: Math.max(0, amount - cardFee - platformFee) };
}

/** Puntos básicos → porcentaje legible («1,5», «5»). */
export function bpsToPercent(bps: number, locale: string): string {
  return formatNumber(bps / 100, { locale, maximumFractionDigits: 2 });
}
