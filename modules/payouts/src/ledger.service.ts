/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PayoutsLedgerEntryType, PrismaClient } from '@didacta/database';
import {
  PayoutsInvalidAmountError,
  PayoutsInvalidIdempotencyKeyError,
  PayoutsLedgerIdempotencyConflictError,
} from './errors.js';
import { assertSignedMinorAmount, normalizeCurrency } from './money.js';

/**
 * Libro mayor de mod.payouts — de SOLO INSERCIÓN.
 *
 * Cada movimiento de dinero del creador es un asiento. `amount` lleva signo:
 * es el efecto sobre lo que le corresponde al creador (el bruto de una venta
 * suma; la comisión de Stripe, la del operador y la transferencia restan).
 * Una corrección es OTRO asiento, nunca una edición: un trigger de `rls.sql`
 * rechaza UPDATE y DELETE sobre la tabla, también al dueño.
 *
 * Signos y grupos (fijados en E4; E5 y E6 deben respetarlos):
 *
 *  - Venta liquidada: `SALE_GROSS` (+bruto), `STRIPE_FEE` (−comisión de
 *    Stripe), `PLATFORM_FEE` (−comisión del operador), `DEBT_RECOVERED`
 *    (−lo compensado, uno por deuda) y `TRANSFER` (−lo transferido). Suman 0.
 *    Los cuatro primeros se anotan al SELLAR el reparto (con la deuda ya
 *    descontada, en la misma transacción); `TRANSFER`, con la transferencia.
 *  - Deuda: `DEBT_CREATED` lleva +X y acompaña a los asientos económicos que
 *    dejan al creador debiendo X (reembolso, disputa…, que suman −X): el grupo
 *    suma 0 y el descubierto pasa a la deuda. `DEBT_RECOVERED` (−Y) lo cancela.
 *
 * Invariantes que comprueba el conciliador, por cuenta y divisa (nunca se
 * suman divisas distintas):
 *
 *  1. Σ de todos los asientos = Σ `transfer_amount` de las ventas con reparto
 *     sellado y aún sin transferir (`READY`/`HELD`): lo que se le debe ahora.
 *  2. Σ (`DEBT_CREATED` + `DEBT_RECOVERED`) = Σ `amount_outstanding` de las
 *     deudas abiertas.
 *
 * Idempotencia: `idempotency_key` es única en toda la tabla y es la MISMA
 * cadena que la cabecera `Idempotency-Key` enviada a Stripe por la operación
 * que originó el asiento. Reintentar un asiento idéntico no lanza y no
 * duplica; reutilizar la clave para un asiento distinto sí lanza.
 *
 * El servicio no abre transacciones propias: cada llamada es una operación de
 * modelo, así que la extensión de RLS del host la acota al tenant del contexto
 * (y también funciona con un cliente de transacción).
 */

/** Asiento tal como queda en la tabla. */
export interface LedgerEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly saleId: string | null;
  readonly type: PayoutsLedgerEntryType;
  readonly amount: number;
  readonly currency: string;
  readonly stripeObjectId: string | null;
  readonly stripeBalanceTransactionId: string | null;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly metadata: unknown;
  readonly createdAt: Date;
}

export interface LedgerEntryInput {
  readonly tenantId: string;
  readonly accountId: string;
  readonly saleId?: string | null;
  readonly type: PayoutsLedgerEntryType;
  /** Con signo, en unidad mínima. */
  readonly amount: number;
  readonly currency: string;
  /** Objeto de Stripe que respalda el asiento (`tr_…`, `re_…`, `ch_…`…). */
  readonly stripeObjectId?: string | null;
  readonly stripeBalanceTransactionId?: string | null;
  readonly idempotencyKey: string;
  /** Cuándo ocurrió el movimiento en Stripe (no cuándo se anotó). */
  readonly occurredAt: Date;
  readonly metadata?: Record<string, unknown>;
}

export interface AppendLedgerResult {
  readonly entry: LedgerEntry;
  /** `false` si el asiento ya existía (reintento): no se ha escrito nada. */
  readonly created: boolean;
}

/** Total del libro de una cuenta en una divisa. */
export interface LedgerBalance {
  readonly currency: string;
  /** Suma con signo de todos los asientos, en unidad mínima. */
  readonly total: bigint;
  readonly entries: number;
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Claves de idempotencia del dominio. Se usan dos veces con el mismo valor:
 * como cabecera `Idempotency-Key` de la llamada a Stripe y como
 * `idempotency_key` del asiento que la anota.
 *
 * OJO: Stripe olvida la clave a las 24 h. Antes de reintentar una
 * transferencia antigua hay que buscarla (`GET /v1/transfers?transfer_group=`).
 */
export const IDEMPOTENCY_KEYS = {
  transfer: (saleId: string) => `payouts:transfer:${saleId}`,
  refund: (refundId: string) => `payouts:refund:${refundId}`,
  reversal: (refundId: string) => `payouts:reversal:${refundId}`,
  disputeReversal: (disputeId: string) => `payouts:reversal:dispute:${disputeId}`,
  debtRecovery: (debtId: string, attempt: number) => `payouts:debt-recovery:${debtId}:${attempt}`,
  /**
   * Parte de una deuda que se cobra compensándola con el neto de una venta
   * (liquidación, E4). Una por deuda y venta: la misma venta no puede
   * compensar dos veces la misma deuda.
   */
  debtNetting: (debtId: string, saleId: string) => `payouts:debt-recovery:${debtId}:sale:${saleId}`,
  /**
   * Asientos de una venta que no nacen de una llamada propia a Stripe (bruto,
   * comisión de Stripe, comisión del operador): uno por tipo y venta.
   */
  saleEntry: (saleId: string, type: PayoutsLedgerEntryType) =>
    `payouts:sale:${saleId}:${type.toLowerCase()}`,
} as const;

export class LedgerService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Anota un asiento. Idempotente por `idempotencyKey`.
   *
   * Se inserta con `ON CONFLICT DO NOTHING` (`skipDuplicates`) y NO capturando
   * el error de clave duplicada: dentro de una transacción, una violación de
   * unicidad la deja abortada y se llevaría por delante el resto del trabajo.
   */
  async append(input: LedgerEntryInput): Promise<AppendLedgerResult> {
    assertSignedMinorAmount(input.amount, 'amount');
    const currency = normalizeCurrency(input.currency);
    const idempotencyKey = input.idempotencyKey;
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length === 0 ||
      idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
    ) {
      throw new PayoutsInvalidIdempotencyKeyError();
    }
    const saleId = input.saleId ?? null;

    const { count } = await this.prisma.modPayoutsLedgerEntry.createMany({
      data: [
        {
          tenantId: input.tenantId,
          accountId: input.accountId,
          saleId,
          type: input.type,
          amount: input.amount,
          currency,
          stripeObjectId: input.stripeObjectId ?? null,
          stripeBalanceTransactionId: input.stripeBalanceTransactionId ?? null,
          idempotencyKey,
          occurredAt: input.occurredAt,
          metadata: (input.metadata ?? {}) as never,
        },
      ],
      skipDuplicates: true,
    });

    const entry = (await this.prisma.modPayoutsLedgerEntry.findUnique({
      where: { idempotencyKey },
    })) as LedgerEntry | null;

    // `entry === null` con `count === 0`: la clave existe pero RLS no deja
    // verla, o sea que es de OTRO tenant. Mismo tratamiento que un contenido
    // distinto: no es un reintento, es un choque.
    if (
      !entry ||
      entry.tenantId !== input.tenantId ||
      entry.accountId !== input.accountId ||
      entry.saleId !== saleId ||
      entry.type !== input.type ||
      entry.amount !== input.amount ||
      entry.currency !== currency
    ) {
      throw new PayoutsLedgerIdempotencyConflictError(idempotencyKey);
    }
    return { entry, created: count === 1 };
  }

  /** Anota varios asientos, en orden. Cada uno es idempotente por su clave. */
  async appendMany(inputs: readonly LedgerEntryInput[]): Promise<AppendLedgerResult[]> {
    const results: AppendLedgerResult[] = [];
    for (const input of inputs) results.push(await this.append(input));
    return results;
  }

  /** Asientos de una venta, del más antiguo al más reciente. */
  async listBySale(tenantId: string, saleId: string): Promise<LedgerEntry[]> {
    return (await this.prisma.modPayoutsLedgerEntry.findMany({
      where: { tenantId, saleId },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    })) as LedgerEntry[];
  }

  /**
   * Total del libro de una cuenta, por divisa. La suma la hace Postgres (un
   * INTEGER se suma en BIGINT) y aquí se lleva en `bigint`: el total de una
   * cuenta no cabe en una columna `Int` en cuanto pasa de 21 millones.
   */
  async balanceByAccount(tenantId: string, accountId: string): Promise<LedgerBalance[]> {
    const groups = await this.prisma.modPayoutsLedgerEntry.groupBy({
      by: ['currency'],
      where: { tenantId, accountId },
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: { currency: 'asc' },
    });
    return groups.map((group) => ({
      currency: group.currency,
      total: toBigInt(group._sum.amount ?? 0),
      entries: group._count._all,
    }));
  }
}

/**
 * Prisma devuelve la suma como `number`, exacto hasta 2^53. Por encima no se
 * podría fiar del valor: se rechaza en vez de redondear dinero en silencio.
 */
function toBigInt(value: number): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new PayoutsInvalidAmountError(`suma fuera de rango exacto: ${String(value)}`);
  }
  return BigInt(value);
}
