/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { PlatformStripeApiError } from './errors.js';
import { idOf } from './event-router.js';
import type { PlatformStripeClient } from './stripe/platform-stripe.client.js';

/**
 * Piezas comunes de los caminos de VUELTA del dinero (etapa E6): reembolsos,
 * disputas y recobro de deudas.
 *
 * La regla que no se negocia: **ninguna pérdida queda en silencio**. Lo que
 * se devuelve al alumno o se lleva el banco sale de tres bolsillos —lo que
 * recibió el creador, la comisión del operador y la de Stripe— y cada
 * céntimo acaba en un asiento: recuperado revirtiendo la transferencia,
 * devuelto por el operador, asumido por el operador (asiento `ADJUSTMENT`
 * con su motivo) o como deuda del creador con su motivo.
 */

/**
 * Quién asume qué. Por defecto, lo decidido por el dueño (plan, §7):
 * el operador devuelve su comisión en proporción, y la comisión de la tarjeta
 * que Stripe no devuelve, la tasa de una disputa perdida y la comisión de esa
 * venta las asume el creador.
 */
export interface PayoutsLossPolicy {
  /** ¿Devuelve el operador su comisión en proporción a lo devuelto? */
  readonly refundPlatformFee: boolean;
  /** Comisión de la tarjeta que Stripe no devuelve al reembolsar. */
  readonly refundCardFeeBearer: 'creator' | 'platform';
  /** Tasa de la disputa y comisión de la tarjeta cuando se PIERDE. */
  readonly disputeLossBearer: 'creator' | 'platform';
}

export const DEFAULT_LOSS_POLICY: PayoutsLossPolicy = Object.freeze({
  refundPlatformFee: true,
  refundCardFeeBearer: 'creator',
  disputeLossBearer: 'creator',
});

/**
 * Avisos que salen del dominio. El host los convierte en correos (al creador,
 * al operador) y en alertas de log. Nunca lanzan: un correo que no sale no
 * deshace un asiento.
 */
export interface PayoutsNotifier {
  /** El alumno reclamó el pago a su banco. Aviso al creador con la fecha límite. */
  disputeOpened(input: {
    readonly tenantId: string;
    readonly saleId: string;
    readonly description: string | null;
    readonly amount: number;
    readonly currency: string;
    readonly evidenceDueBy: Date | null;
  }): Promise<void>;
  /** Se le ha anotado al creador una deuda que se descontará de próximos cobros. */
  debtCharged(input: {
    readonly tenantId: string;
    readonly saleId: string | null;
    readonly description: string | null;
    readonly amount: number;
    readonly currency: string;
    readonly cause: 'refund' | 'dispute_withdrawn' | 'dispute_lost';
  }): Promise<void>;
  /** Algo que un humano del operador debe mirar. */
  operatorAlert(alert: string, detail: Record<string, unknown>): Promise<void>;
}

export const SILENT_NOTIFIER: PayoutsNotifier = {
  disputeOpened: async () => undefined,
  debtCharged: async () => undefined,
  operatorAlert: async () => undefined,
};

/** Alertas de E6 que buscan los operadores en los logs (y llegan por correo). */
export const PAYOUTS_LOSS_ALERTS = {
  reversalShortfall: 'payouts.reversal_shortfall',
  refundFailedAfterAccounting: 'payouts.refund_failed_after_accounting',
  refundFxDifference: 'payouts.refund_fx_difference',
  refundUnaccountable: 'payouts.refund_unaccountable',
  disputeOpened: 'payouts.dispute_opened',
  disputeMismatch: 'payouts.dispute_mismatch',
  disputeReinstatementFailed: 'payouts.dispute_reinstatement_failed',
  debtAlert: 'payouts.debt_alert',
  platformAbsorbed: 'payouts.platform_absorbed',
} as const;

export type ReversalStatus = 'DONE' | 'PARTIAL' | 'FAILED_TO_DEBT';

export interface ReversalResult {
  /** Lo que de verdad se revirtió (0..objetivo). */
  readonly reversed: number;
  readonly reversalId: string | null;
  readonly status: ReversalStatus;
  /** Por qué no se revirtió todo (literal de Stripe), si no se pudo. */
  readonly detail: string | null;
}

interface ReversalFromApi {
  readonly id: string;
  readonly amount?: number;
  readonly metadata?: Record<string, unknown> | null;
}

/** «does not have sufficient funds…», o el código que lo acompañe. */
export function isInsufficientFunds(err: PlatformStripeApiError): boolean {
  return (
    err.stripeCode === 'balance_insufficient' ||
    err.stripeCode === 'insufficient_funds' ||
    /sufficient funds|insufficient/i.test(err.detail ?? err.message)
  );
}

/**
 * Lo que la cuenta del creador puede devolver ahora en `currency`: su saldo
 * disponible más el pendiente (`GET /v1/balance` con `Stripe-Account`). Con
 * el calendario de pagos del operador el dinero recién transferido está
 * «pendiente» unos días, y Stripe lo usa para la reversión.
 */
export async function reversibleBalance(
  stripe: PlatformStripeClient,
  stripeAccountId: string,
  currency: string,
): Promise<number> {
  const balance = await stripe.v1<{
    available?: Array<{ amount?: number; currency?: string }>;
    pending?: Array<{ amount?: number; currency?: string }>;
  }>('GET', '/v1/balance', {}, { account: stripeAccountId });
  const sum = (rows: Array<{ amount?: number; currency?: string }> | undefined) =>
    (rows ?? [])
      .filter((row) => (row.currency ?? '').toLowerCase() === currency)
      .reduce((total, row) => total + Math.max(0, row.amount ?? 0), 0);
  return sum(balance.available) + sum(balance.pending);
}

/**
 * Revierte hasta `target` de una transferencia al creador
 * (`POST /v1/transfers/{id}/reversals`; nunca `reverse_transfer=true`, que en
 * este flujo no sirve).
 *
 *  1. Si un intento anterior ya la creó (murió antes de anotarla, o hace más
 *     de 24 h y Stripe olvidó la clave), se ADOPTA: se busca por
 *     `metadata[<metaKey>] = <metaValue>`.
 *  2. Se pide el objetivo entero con `Idempotency-Key: <idempotencyKey>`.
 *  3. Si Stripe dice que la cuenta no tiene saldo, se revierte lo que permite
 *     su saldo (clave `<idempotencyKey>:partial:<importe>`).
 *  4. Lo que no se pudo revertir lo convierte en deuda quien llama.
 *
 * Un error transitorio de Stripe se propaga: quien llama reintenta más tarde
 * y, gracias al paso 1, nunca revierte dos veces.
 */
export async function reverseTransfer(
  stripe: PlatformStripeClient,
  input: {
    readonly transferId: string;
    readonly stripeAccountId: string;
    readonly currency: string;
    readonly target: number;
    readonly idempotencyKey: string;
    readonly metadata: Record<string, string>;
    /** Campo de `metadata` que identifica la reversión para adoptarla. */
    readonly metaKey: string;
    readonly description?: string;
  },
): Promise<ReversalResult> {
  if (input.target <= 0) return { reversed: 0, reversalId: null, status: 'DONE', detail: null };
  const path = `/v1/transfers/${encodeURIComponent(input.transferId)}/reversals`;
  const metaValue = input.metadata[input.metaKey];

  const existing = await stripe.v1<{ data?: ReversalFromApi[] }>('GET', path, { limit: 100 });
  const adopted = (existing.data ?? []).find(
    (reversal) => metaValue !== undefined && reversal.metadata?.[input.metaKey] === metaValue,
  );
  if (adopted) return fromReversal(adopted, input.target, null);

  const create = (amount: number, key: string) =>
    stripe.v1<ReversalFromApi>(
      'POST',
      path,
      {
        amount,
        metadata: input.metadata,
        ...(input.description ? { description: input.description.slice(0, 300) } : {}),
      },
      { idempotencyKey: key },
    );

  try {
    return fromReversal(await create(input.target, input.idempotencyKey), input.target, null);
  } catch (err) {
    if (!(err instanceof PlatformStripeApiError) || err.retryable) throw err;
    const detail = `${err.stripeCode ?? err.type ?? err.status}: ${err.detail ?? err.message}`;
    if (!isInsufficientFunds(err)) {
      return { reversed: 0, reversalId: null, status: 'FAILED_TO_DEBT', detail };
    }
    const capacity = await reversibleBalance(stripe, input.stripeAccountId, input.currency);
    const partial = Math.min(input.target, capacity);
    if (partial <= 0) return { reversed: 0, reversalId: null, status: 'FAILED_TO_DEBT', detail };
    try {
      const reversal = await create(partial, `${input.idempotencyKey}:partial:${partial}`);
      return fromReversal(reversal, input.target, detail);
    } catch (second) {
      if (!(second instanceof PlatformStripeApiError) || second.retryable) throw second;
      return {
        reversed: 0,
        reversalId: null,
        status: 'FAILED_TO_DEBT',
        detail: `${detail}; parcial ${partial}: ${second.detail ?? second.message}`,
      };
    }
  }
}

function fromReversal(
  reversal: ReversalFromApi,
  target: number,
  detail: string | null,
): ReversalResult {
  const reversed = Math.min(Math.max(reversal.amount ?? 0, 0), target);
  return {
    reversed,
    reversalId: idOf(reversal.id),
    status: reversed >= target ? 'DONE' : reversed > 0 ? 'PARTIAL' : 'FAILED_TO_DEBT',
    detail: reversed >= target ? null : (detail ?? 'reversión parcial'),
  };
}

/**
 * ¿Está la venta en manos de la liquidación (transfiriéndose ahora mismo)?
 * Quien transfiere se reserva la venta poniendo `next_attempt_at` unos
 * minutos en el futuro; mientras tanto nadie toca su `transfer_amount`.
 */
export function saleTransferInFlight(
  sale: { readonly nextAttemptAt: Date | null; readonly stripeTransferId: string | null },
  now: Date,
  leaseMs: number,
): boolean {
  if (sale.stripeTransferId !== null || sale.nextAttemptAt === null) return false;
  const until = sale.nextAttemptAt.getTime();
  return until > now.getTime() && until <= now.getTime() + leaseMs + 60_000;
}

/** Cerrojo de la venta en una transacción (reembolsos y disputas de la misma venta). */
export function saleLockKey(saleId: string): string {
  return `payouts:sale:${saleId}`;
}

/** El mismo cerrojo de deuda que usa la liquidación al compensar. */
export function debtLockKey(accountId: string, currency: string): string {
  return `payouts:debt:${accountId}:${currency}`;
}
