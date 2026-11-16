/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@didacta/database';
import type { PayoutsDbPort, PayoutsLogger } from './accounts.service.js';
import {
  PayoutsCreditIdempotencyConflictError,
  PayoutsCreditInsufficientPlatformBalanceError,
  PayoutsCreditInvalidError,
  PayoutsCreditNoAccountError,
  PlatformStripeApiError,
} from './errors.js';
import { idOf } from './event-router.js';
import { LedgerService } from './ledger.service.js';
import { isInsufficientFunds } from './losses.js';
import { MAX_MINOR_AMOUNT } from './money.js';
import { RefsService } from './refs.service.js';
import type { PlatformStripeClient } from './stripe/platform-stripe.client.js';

/**
 * Crédito de la plataforma a la cuenta conectada de un aula
 * (`POST /admin/tenants/:id/payouts/credits`): mueve `amount` del saldo de la
 * cuenta del operador a la del creador con una `transfer` SIN venta detrás.
 * Es la salida de dinero del programa de afiliados (ADR-008) y la única
 * operación de este módulo que gasta saldo del operador sin que un alumno
 * haya pagado: por eso cada paso está cerrado.
 *
 * Idempotencia (la propiedad que importa): una misma `idempotencyKey` produce
 * COMO MUCHO una transferencia, por tres capas independientes.
 *
 *  1. El libro. Antes de tocar Stripe se busca el asiento `TRANSFER` de la
 *     clave (`payouts:credit:<tenant>:<clave>`, única en toda la tabla). Si
 *     existe, se devuelve el crédito original sin llamar a Stripe y SIN mirar
 *     el estado actual de la cuenta: reintentar un crédito ya pagado no puede
 *     fallar porque la cuenta se haya restringido después.
 *  2. Stripe. La clave viaja como `Idempotency-Key` (la MISMA cadena que la
 *     del asiento, como en el resto del módulo). Stripe la olvida a las 24 h.
 *  3. Búsqueda previa. Antes de crear se pregunta a Stripe por una
 *     transferencia de ese `transfer_group` con la clave en su metadata, que
 *     sobrevive a las 24 h de la cabecera. Cubre el caso «se creó la
 *     transferencia y el proceso murió antes de anotar el libro» pasado un
 *     día.
 *
 * Reutilizar la clave con otro importe, divisa o cuenta NUNCA devuelve el
 * crédito viejo ni crea uno nuevo: es un `PAYOUTS_CREDIT_IDEMPOTENCY_CONFLICT`.
 *
 * Libro (decisión): dos asientos que suman 0, en una sola transacción.
 *
 *     ADJUSTMENT  +importe   metadata { cause: 'affiliate_credit', idempotencyKey, … }
 *     TRANSFER    −importe   stripe_object_id = tr_…   (clave = la del crédito)
 *
 * El `ADJUSTMENT` es lo que la plataforma le concede (le debe más) y el
 * `TRANSFER` es ese dinero saliendo de verdad. Así se cumple el invariante del
 * conciliador (Σ del libro de la cuenta = lo pendiente de transferir) sin
 * tocarlo, y el conciliador reconoce la transferencia por su asiento
 * (`transfersWithoutEntry`: transferencia sin venta pero con asiento). No
 * empieza por `payouts:transfer:` ni `payouts:reinstate:`, así que ni el
 * cotejo de ventas ni «Recibido» (que cuenta los reintegros de disputas) lo
 * confunden con una venta. No es ingreso por ventas: no sale en el resumen de
 * «Tus ventas» ni en la factura de la comisión (esa solo lee `PLATFORM_FEE*`).
 *
 * Lo que NO hace: no compensa la deuda abierta del creador (un crédito es
 * dinero que se le entrega, no una venta que se le liquida) y no valida que
 * exista el afiliado ni la causa — quien llama (Didacta Cloud) responde de
 * eso y deja la causa en `reason`, que va al audit log del aula y a la
 * descripción de la transferencia.
 */

/** Tope por defecto de un crédito (unidad mínima de su divisa). Configurable. */
export const DEFAULT_MAX_CREDIT_MINOR = 1_000_000;

/** Metadata de la transferencia: la clave del asiento que la respalda. */
export const CREDIT_METADATA_KEY = 'didacta_credit_key';

const KEY_SHAPE = /^[A-Za-z0-9._:-]{8,120}$/;
const MAX_REASON = 200;

/** Clave del asiento `TRANSFER` (y `Idempotency-Key` de Stripe) de un crédito. */
export function creditLedgerKey(tenantId: string, idempotencyKey: string): string {
  return `payouts:credit:${tenantId}:${idempotencyKey}`;
}

/**
 * `transfer_group` de un crédito: filtrable de forma exacta en Stripe, sin
 * meter la clave en claro. Una por (aula, clave).
 */
export function creditTransferGroup(tenantId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${tenantId}\n${idempotencyKey}`).digest('hex');
  return `didacta_credit_${digest.slice(0, 40)}`;
}

export interface CreditInput {
  readonly tenantId: string;
  /** Unidad mínima de `currency`; entero > 0. */
  readonly amount: number;
  /** Código ISO 4217 de tres letras. */
  readonly currency: string;
  /** 8–120 caracteres `[A-Za-z0-9._:-]`. Una clave = como mucho un crédito. */
  readonly idempotencyKey: string;
  /** Por qué se hace (1–200). Va al audit log y a la descripción de Stripe. */
  readonly reason: string;
  /** Quién lo ordena (`credential id` o usuario), para el asiento. */
  readonly initiatedBy?: string | null;
}

export interface CreditOutcome {
  readonly transferId: string;
  readonly amount: number;
  readonly currency: string;
  /** `false`: era un reintento y no se ha escrito ni movido nada. */
  readonly created: boolean;
}

export interface CreditsServiceOptions {
  /** Tope de un crédito en unidad mínima. */
  readonly maxMinor?: number;
  readonly logger?: PayoutsLogger;
}

interface TransferFromApi {
  readonly id: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly destination?: unknown;
  readonly balance_transaction?: unknown;
  readonly created?: number;
  readonly livemode?: boolean;
  readonly metadata?: Record<string, unknown> | null;
}

export class PayoutsCreditsService {
  private readonly maxMinor: number;

  constructor(
    private readonly db: PayoutsDbPort,
    private readonly stripe: PlatformStripeClient,
    private readonly options: CreditsServiceOptions = {},
  ) {
    this.maxMinor = Math.min(options.maxMinor ?? DEFAULT_MAX_CREDIT_MINOR, MAX_MINOR_AMOUNT);
  }

  /** Valida la forma de un crédito. Lanza `PAYOUTS_CREDIT_INVALID` (400). */
  private validate(input: CreditInput): {
    amount: number;
    currency: string;
    idempotencyKey: string;
    reason: string;
  } {
    const { amount } = input;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1) {
      throw new PayoutsCreditInvalidError('amount');
    }
    if (amount > this.maxMinor) throw new PayoutsCreditInvalidError('amount_over_limit');
    const currency = typeof input.currency === 'string' ? input.currency : '';
    if (!/^[a-z]{3}$/.test(currency)) throw new PayoutsCreditInvalidError('currency');
    if (typeof input.idempotencyKey !== 'string' || !KEY_SHAPE.test(input.idempotencyKey)) {
      throw new PayoutsCreditInvalidError('idempotencyKey');
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 1 || reason.length > MAX_REASON) {
      throw new PayoutsCreditInvalidError('reason');
    }
    return { amount, currency, idempotencyKey: input.idempotencyKey, reason };
  }

  /**
   * Mueve el crédito. Idempotente por `idempotencyKey` (ver la cabecera del
   * fichero). Lanza `PAYOUTS_CREDIT_INVALID`, `PAYOUTS_CREDIT_NO_ACCOUNT`,
   * `PAYOUTS_CREDIT_INSUFFICIENT_PLATFORM_BALANCE`,
   * `PAYOUTS_CREDIT_IDEMPOTENCY_CONFLICT` o el error de Stripe que no sea de
   * saldo (reintentable → 503, el resto → 502).
   */
  async credit(input: CreditInput): Promise<CreditOutcome> {
    const { amount, currency, idempotencyKey, reason } = this.validate(input);
    const { tenantId } = input;
    const ledgerKey = creditLedgerKey(tenantId, idempotencyKey);

    // 1. ¿Ya se hizo? Antes que nada, y sin mirar la cuenta.
    const prior = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsLedgerEntry.findFirst({ where: { tenantId, idempotencyKey: ledgerKey } }),
    );
    if (prior) {
      if (
        prior.type !== 'TRANSFER' ||
        prior.amount !== -amount ||
        prior.currency !== currency ||
        !prior.stripeObjectId
      ) {
        throw new PayoutsCreditIdempotencyConflictError('ledger');
      }
      return { transferId: prior.stripeObjectId, amount, currency, created: false };
    }

    // 2. La cuenta tiene que existir y estar lista para recibir.
    const account = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsAccount.findFirst({
        where: { tenantId, closedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true, stripeAccountId: true, status: true },
      }),
    );
    if (!account || !account.stripeAccountId)
      throw new PayoutsCreditNoAccountError('not_connected');
    if (account.status !== 'READY') {
      throw new PayoutsCreditNoAccountError(`account_${account.status.toLowerCase()}`);
    }
    const destination = account.stripeAccountId;

    // 3. Stripe: la transferencia que ya existe, o una nueva.
    const transfer = await this.findOrCreateTransfer({
      tenantId,
      destination,
      amount,
      currency,
      ledgerKey,
      group: creditTransferGroup(tenantId, idempotencyKey),
      reason,
    });
    if (
      transfer.amount !== amount ||
      (transfer.currency ?? '').toLowerCase() !== currency ||
      idOf(transfer.destination) !== destination
    ) {
      // Stripe contesta otra cosa a la que se pidió (clave reutilizada con
      // otros parámetros, p. ej.). No se anota nada.
      throw new PayoutsCreditIdempotencyConflictError('transfer_mismatch');
    }

    // 4. El libro, en una transacción: o los dos asientos o ninguno.
    const occurredAt =
      typeof transfer.created === 'number' ? new Date(transfer.created * 1000) : new Date();
    const created = await this.db.inTenant(tenantId, async (tx) => {
      const ledger = new LedgerService(tx as unknown as PrismaClient);
      const base = { tenantId, accountId: account.id, currency, occurredAt };
      await ledger.append({
        ...base,
        type: 'ADJUSTMENT',
        amount,
        stripeObjectId: transfer.id,
        idempotencyKey: `${ledgerKey}:adjustment`,
        metadata: {
          cause: 'affiliate_credit',
          idempotencyKey,
          reason,
          transferId: transfer.id,
          ...(input.initiatedBy ? { initiatedBy: input.initiatedBy } : {}),
        },
      });
      const transferEntry = await ledger.append({
        ...base,
        type: 'TRANSFER',
        amount: -amount,
        stripeObjectId: transfer.id,
        stripeBalanceTransactionId: idOf(transfer.balance_transaction),
        idempotencyKey: ledgerKey,
        metadata: { cause: 'affiliate_credit', destination, idempotencyKey },
      });
      await new RefsService(tx as unknown as PrismaClient).register({
        tenantId,
        stripeObjectId: transfer.id,
        kind: 'transfer',
        source: 'payouts',
        livemode: transfer.livemode === true,
      });
      return transferEntry.created;
    });

    if (created) {
      this.options.logger?.log?.(
        { tenantId, transferId: transfer.id, amount, currency },
        'payouts.credit: crédito transferido a la cuenta del aula',
      );
    }
    return { transferId: transfer.id, amount, currency, created };
  }

  private async findOrCreateTransfer(input: {
    tenantId: string;
    destination: string;
    amount: number;
    currency: string;
    ledgerKey: string;
    group: string;
    reason: string;
  }): Promise<TransferFromApi> {
    // Antes de crear, buscar: la cabecera de Stripe se olvida a las 24 h.
    const listed = await this.stripe.v1<{ data?: TransferFromApi[] }>('GET', '/v1/transfers', {
      transfer_group: input.group,
      destination: input.destination,
      limit: 10,
    });
    const existing = (listed.data ?? []).find(
      (t) => t.metadata?.[CREDIT_METADATA_KEY] === input.ledgerKey,
    );
    if (existing) return existing;

    try {
      return await this.stripe.v1<TransferFromApi>(
        'POST',
        '/v1/transfers',
        {
          amount: input.amount,
          currency: input.currency,
          destination: input.destination,
          transfer_group: input.group,
          description: input.reason.slice(0, 300),
          metadata: {
            [CREDIT_METADATA_KEY]: input.ledgerKey,
            didacta_tenant_id: input.tenantId,
            didacta_credit_cause: 'affiliate_credit',
          },
        },
        { idempotencyKey: input.ledgerKey },
      );
    } catch (err) {
      if (!(err instanceof PlatformStripeApiError)) throw err;
      if (err.type === 'idempotency_error') {
        throw new PayoutsCreditIdempotencyConflictError('stripe');
      }
      if (!err.retryable && isInsufficientFunds(err)) {
        throw new PayoutsCreditInsufficientPlatformBalanceError(input.currency);
      }
      throw err;
    }
  }
}
