/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import {
  PayoutsInvalidAmountError,
  PayoutsInvalidCurrencyError,
  PayoutsInvalidFeeBpsError,
} from './errors.js';

/**
 * Aritmética del dinero de mod.payouts. Funciones PURAS: ni base de datos, ni
 * Stripe, ni reloj.
 *
 * Reglas:
 *  - Todo importe es un ENTERO en la unidad mínima de la divisa (céntimos en
 *    eur/usd/gbp). Nunca decimales, nunca `number` con coma.
 *  - Las multiplicaciones y las sumas se hacen en `bigint`: `gross × fee_bps`
 *    cabe de sobra en un `number`, pero una suma de libro no tiene techo y un
 *    redondeo en coma flotante con dinero no avisa.
 *  - Los importes que se guardan caben en un `INTEGER` de Postgres (las
 *    columnas son `Int`): por encima de 2^31 − 1 se rechaza, no se trunca.
 *  - Todo se calcula en la divisa de LIQUIDACIÓN del cargo
 *    (`balance_transaction.currency`), que no tiene por qué ser la que pagó el
 *    alumno.
 */

/** Comisión por defecto del operador: 5 %. */
export const DEFAULT_FEE_BPS = 500;
/** Techo de la comisión del operador: 30 %. */
export const MAX_FEE_BPS = 3000;
/** 10 000 puntos básicos = 100 %. */
export const BPS_DENOMINATOR = 10_000;
/** Mayor importe que cabe en una columna `Int` (INTEGER de Postgres). */
export const MAX_MINOR_AMOUNT = 2_147_483_647;

/** Entero no negativo que cabe en una columna `Int`. */
export function assertMinorAmount(value: unknown, what: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_MINOR_AMOUNT
  ) {
    throw new PayoutsInvalidAmountError(`${what} = ${String(value)}`);
  }
}

/** Entero CON signo que cabe en una columna `Int` (asientos del libro). */
export function assertSignedMinorAmount(value: unknown, what: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > MAX_MINOR_AMOUNT) {
    throw new PayoutsInvalidAmountError(`${what} = ${String(value)}`);
  }
}

/** Entero entre 0 y `MAX_FEE_BPS`. */
export function assertFeeBps(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_FEE_BPS) {
    throw new PayoutsInvalidFeeBpsError(value);
  }
}

/** Código ISO 4217 en minúsculas (`eur`), que es como lo devuelve Stripe. */
export function normalizeCurrency(value: unknown): string {
  if (typeof value !== 'string') throw new PayoutsInvalidCurrencyError(value);
  const currency = value.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new PayoutsInvalidCurrencyError(value);
  return currency;
}

/**
 * Comisión del operador sobre el bruto, redondeada al entero más cercano con
 * el medio hacia arriba:
 *
 *     platform_fee = floor((gross × fee_bps + 5000) / 10000)
 *
 * 11971 al 5 % son 598,55 → 599; 8071 al 5 % son 403,55 → 404.
 */
export function computePlatformFee(gross: number, feeBps: number): number {
  assertMinorAmount(gross, 'gross');
  assertFeeBps(feeBps);
  const fee =
    (BigInt(gross) * BigInt(feeBps) + BigInt(BPS_DENOMINATOR / 2)) / BigInt(BPS_DENOMINATOR);
  return Number(fee);
}

export interface ComputeSplitInput {
  /** Bruto del cargo en la divisa de liquidación (`balance_transaction.amount`). */
  readonly gross: number;
  /** Comisión REAL de Stripe (`balance_transaction.fee`), leída de la API. */
  readonly stripeFee: number;
  /** Comisión del operador en puntos básicos (500 = 5 %). */
  readonly feeBps: number;
}

export interface Split {
  readonly gross: number;
  readonly stripeFee: number;
  readonly feeBpsApplied: number;
  readonly platformFee: number;
  /**
   * Lo que corresponde al creador. Puede ser NEGATIVO en un cargo minúsculo
   * (la comisión de Stripe se come el bruto): quien liquida no transfiere un
   * negativo, lo convierte en deuda.
   */
  readonly creatorNet: number;
}

/**
 * Reparto de una venta. Invariante, siempre:
 *
 *     gross − stripe_fee − platform_fee = creator_net
 *
 * La comisión del operador se calcula sobre el BRUTO, no sobre el neto de
 * Stripe: 100 € con 1,75 € de Stripe dejan 5,00 € al operador y 93,25 € al
 * creador.
 */
export function computeSplit(input: ComputeSplitInput): Split {
  assertMinorAmount(input.gross, 'gross');
  assertMinorAmount(input.stripeFee, 'stripeFee');
  const platformFee = computePlatformFee(input.gross, input.feeBps);
  return {
    gross: input.gross,
    stripeFee: input.stripeFee,
    feeBpsApplied: input.feeBps,
    platformFee,
    creatorNet: input.gross - input.stripeFee - platformFee,
  };
}

/**
 * Parte proporcional de un importe: `round(amount × part / whole)`, con el
 * medio hacia arriba y en `bigint`. `part` no puede superar a `whole`.
 */
export function prorate(amount: number, part: number, whole: number): number {
  assertMinorAmount(amount, 'amount');
  assertMinorAmount(part, 'part');
  assertMinorAmount(whole, 'whole');
  if (whole === 0) throw new PayoutsInvalidAmountError('whole = 0');
  if (part > whole) throw new PayoutsInvalidAmountError(`part ${part} > whole ${whole}`);
  const w = BigInt(whole);
  return Number((BigInt(amount) * BigInt(part) * 2n + w) / (2n * w));
}

export interface ProportionalReversalInput {
  /** Lo que se transfirió al creador por la venta. */
  readonly transferAmount: number;
  /** Importe que se reembolsa AHORA al alumno. */
  readonly refundAmount: number;
  /** Bruto de la venta. */
  readonly gross: number;
  /** Lo que ya se revirtió de esa transferencia en reembolsos anteriores. */
  readonly alreadyReversed?: number;
}

/**
 * Cuánto hay que revertir de la transferencia al reembolsar una parte de la
 * venta: `round(transfer_amount × refund / gross)`. Reembolsar el 40 % de una
 * venta de 100 € con 93,25 € transferidos revierte 37,30 €.
 *
 * Nunca devuelve más de lo que queda por revertir: dos reembolsos parciales
 * cuyos redondeos sumen un céntimo de más no pueden pedirle a Stripe una
 * reversión mayor que la transferencia.
 */
export function computeProportionalReversal(input: ProportionalReversalInput): number {
  const alreadyReversed = input.alreadyReversed ?? 0;
  assertMinorAmount(alreadyReversed, 'alreadyReversed');
  const target = prorate(input.transferAmount, input.refundAmount, input.gross);
  if (alreadyReversed > input.transferAmount) {
    throw new PayoutsInvalidAmountError(
      `alreadyReversed ${alreadyReversed} > transferAmount ${input.transferAmount}`,
    );
  }
  return Math.min(target, input.transferAmount - alreadyReversed);
}

/** Suma de importes en `bigint`. Para totales de libro: no tiene techo. */
export function sumMinor(amounts: Iterable<number | bigint>): bigint {
  let total = 0n;
  for (const amount of amounts) {
    if (typeof amount === 'number' && !Number.isInteger(amount)) {
      throw new PayoutsInvalidAmountError(`sumando = ${String(amount)}`);
    }
    total += BigInt(amount);
  }
  return total;
}
