/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PayoutsDebtReason, PayoutsSaleStatus, PrismaClient } from '@didacta/database';
import type { PayoutsDbPort, PayoutsLogger, PayoutsTx } from './accounts.service.js';
import { PayoutsSettlementConflictError, PlatformStripeApiError } from './errors.js';
import { IDEMPOTENCY_KEYS, LedgerService, type LedgerEntryInput } from './ledger.service.js';
import {
  PAYOUTS_LOSS_ALERTS,
  SILENT_NOTIFIER,
  debtLockKey,
  reverseTransfer,
  reversibleBalance,
  saleLockKey,
  type PayoutsNotifier,
} from './losses.js';
import type { PlatformStripeClient } from './stripe/platform-stripe.client.js';

/**
 * Deudas del creador (`mod_payouts_debt`, etapa E6).
 *
 * Una deuda nace cuando un reembolso o una disputa le quita al creador más de
 * lo que se le pudo recuperar en el momento. Se cobra de tres maneras, todas
 * en la MISMA divisa (nunca se cruzan divisas):
 *
 *  1. **Compensación en la próxima liquidación** (`settlement.service.ts`):
 *     el neto de la siguiente venta paga la deuda antes de transferirse.
 *  2. **Contra una venta aún sin transferir**: si la venta reembolsada o
 *     disputada no se había transferido, su propia transferencia pendiente
 *     paga lo que le toca al creador, en la misma transacción
 *     (`netAgainstPendingSale`).
 *  3. **Recobro diario** (`recoverOpenDebts`): revirtiendo transferencias
 *     recientes del creador hasta lo que permite su saldo en Stripe.
 *
 * La deuda de una disputa AÚN ABIERTA no se cobra (está «congelada»): si el
 * operador gana, se cancela y no hay nada que devolver.
 *
 * Libro: `DEBT_CREATED` (+X) acompaña al grupo que deja al creador debiendo X
 * (el grupo suma 0); `DEBT_RECOVERED` (−Y) lo cancela. Invariante del
 * conciliador: Σ asientos de deuda = Σ `amount_outstanding` de las abiertas.
 */

export interface CreateDebtInput {
  readonly tenantId: string;
  readonly accountId: string;
  readonly currency: string;
  readonly reason: PayoutsDebtReason;
  /** > 0, en unidad mínima de la divisa de liquidación. */
  readonly amount: number;
  readonly originSaleId: string | null;
  /** Clave del asiento `DEBT_CREATED`: hace idempotente la deuda entera. */
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly stripeObjectId?: string | null;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Crea la deuda y su asiento `DEBT_CREATED`, dentro de la transacción de
 * quien la origina. Idempotente por la clave del asiento: si ya existe,
 * devuelve la deuda que creó.
 */
export async function createDebt(
  tx: PayoutsTx,
  input: CreateDebtInput,
): Promise<{ debtId: string; created: boolean }> {
  const previous = await tx.modPayoutsLedgerEntry.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { metadata: true },
  });
  const previousDebtId = (previous?.metadata as { debtId?: unknown } | null)?.debtId;
  if (previous && typeof previousDebtId === 'string') {
    return { debtId: previousDebtId, created: false };
  }
  const debt = await tx.modPayoutsDebt.create({
    data: {
      tenantId: input.tenantId,
      accountId: input.accountId,
      reason: input.reason,
      originSaleId: input.originSaleId,
      amountOriginal: input.amount,
      amountOutstanding: input.amount,
      currency: input.currency,
      status: 'OPEN',
    },
  });
  await new LedgerService(tx as unknown as PrismaClient).append({
    tenantId: input.tenantId,
    accountId: input.accountId,
    saleId: input.originSaleId,
    type: 'DEBT_CREATED',
    amount: input.amount,
    currency: input.currency,
    stripeObjectId: input.stripeObjectId ?? null,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
    metadata: { ...input.metadata, debtId: debt.id, reason: input.reason },
  });
  return { debtId: debt.id, created: true };
}

/**
 * Ventas con una disputa ABIERTA (sin resultado aún) del tenant: sus deudas
 * `DISPUTE` no se cobran hasta que se decida.
 */
export async function frozenDisputeSaleIds(tx: PayoutsTx, tenantId: string): Promise<string[]> {
  const rows = await tx.modPayoutsDispute.findMany({
    where: { tenantId, outcome: null },
    select: { saleId: true },
  });
  return [...new Set(rows.map((row) => row.saleId))];
}

/**
 * Parte de la clave del asiento `DEBT_CREATED` de la deuda por la tasa de una
 * disputa GANADA (`payouts:dispute:<id>:debt-won-fee`): con ella «Tus ventas»
 * distingue esa deuda de la de una disputa perdida (las dos son `DISPUTE_FEE`).
 */
export const DISPUTE_WON_FEE_DEBT_PART = 'debt-won-fee';

/**
 * De estas deudas, cuáles son la tasa de una disputa GANADA (Stripe no la
 * devuelve y la paga el creador). Exacto: por la clave de su asiento.
 */
export async function wonDisputeFeeDebtIds(
  tx: PayoutsTx,
  tenantId: string,
  debts: ReadonlyArray<{ readonly reason: string; readonly originSaleId: string | null }>,
): Promise<Set<string>> {
  const out = new Set<string>();
  const saleIds = [
    ...new Set(
      debts
        .filter((d) => d.reason === 'DISPUTE_FEE' && d.originSaleId !== null)
        .map((d) => d.originSaleId as string),
    ),
  ];
  if (saleIds.length === 0) return out;
  const won = await tx.modPayoutsDispute.findMany({
    where: { tenantId, saleId: { in: saleIds }, outcome: 'won' },
    select: { id: true },
  });
  if (won.length === 0) return out;
  const entries = await tx.modPayoutsLedgerEntry.findMany({
    where: {
      tenantId,
      idempotencyKey: {
        in: won.map((d) => IDEMPOTENCY_KEYS.disputeEntry(d.id, DISPUTE_WON_FEE_DEBT_PART)),
      },
    },
    select: { metadata: true },
  });
  for (const entry of entries) {
    const debtId = (entry.metadata as { debtId?: unknown } | null)?.debtId;
    if (typeof debtId === 'string') out.add(debtId);
  }
  return out;
}

/** Filtro de Prisma para dejar fuera las deudas congeladas. */
export function unfrozenDebtsWhere(frozenSaleIds: readonly string[]): Record<string, unknown> {
  return frozenSaleIds.length === 0
    ? {}
    : { NOT: { reason: 'DISPUTE', originSaleId: { in: [...frozenSaleIds] } } };
}

/**
 * Cobra deudas con la transferencia PENDIENTE de una venta que aún no se ha
 * transferido (la propia venta reembolsada o disputada). Misma mecánica que
 * la compensación de la liquidación: la venta baja su `transfer_amount`, sube
 * su `debt_netted` y se anota `DEBT_RECOVERED` con la clave de compensación
 * (deuda + venta), así que el conciliador lo coteja como cualquier otra.
 *
 * Llamar con el cerrojo de deuda de la cuenta y divisa tomado. Si la venta
 * cambió desde que se leyó (`expected`), lanza y la transacción se deshace.
 *
 * @returns lo compensado de cada deuda (en el orden dado).
 */
export async function netAgainstPendingSale(
  tx: PayoutsTx,
  input: {
    readonly tenantId: string;
    readonly saleId: string;
    readonly expected: {
      readonly transferAmount: number;
      readonly debtNetted: number;
      readonly status: PayoutsSaleStatus;
      readonly nextAttemptAt: Date | null;
    };
    readonly debtIds: readonly string[];
    readonly currency: string;
    readonly accountId: string;
    readonly occurredAt: Date;
    /** Próxima consulta de la venta si le queda algo por transferir. */
    readonly nextAttemptAt: Date;
  },
): Promise<Map<string, number>> {
  const taken = new Map<string, number>();
  let remaining = input.expected.transferAmount;
  const entries: LedgerEntryInput[] = [];
  for (const debtId of input.debtIds) {
    if (remaining <= 0) break;
    const debt = await tx.modPayoutsDebt.findFirst({
      where: { id: debtId, tenantId: input.tenantId, status: 'OPEN' },
    });
    if (!debt || debt.amountOutstanding <= 0) continue;
    const take = Math.min(remaining, debt.amountOutstanding);
    const left = debt.amountOutstanding - take;
    const updated = await tx.modPayoutsDebt.updateMany({
      where: { id: debt.id, status: 'OPEN', amountOutstanding: debt.amountOutstanding },
      data: { amountOutstanding: left, status: left === 0 ? 'RECOVERED' : 'OPEN' },
    });
    if (updated.count !== 1) {
      throw new PayoutsSettlementConflictError(`la deuda ${debt.id} cambió a mitad`);
    }
    remaining -= take;
    taken.set(debt.id, take);
    entries.push({
      tenantId: input.tenantId,
      accountId: input.accountId,
      saleId: input.saleId,
      type: 'DEBT_RECOVERED',
      amount: -take,
      currency: input.currency,
      idempotencyKey: IDEMPOTENCY_KEYS.debtNetting(debt.id, input.saleId),
      occurredAt: input.occurredAt,
      metadata: { debtId: debt.id, via: 'pending_sale' },
    });
  }
  const total = input.expected.transferAmount - remaining;
  if (total === 0) return taken;

  const { count } = await tx.modPayoutsSale.updateMany({
    where: {
      id: input.saleId,
      tenantId: input.tenantId,
      stripeTransferId: null,
      status: input.expected.status,
      transferAmount: input.expected.transferAmount,
      nextAttemptAt: input.expected.nextAttemptAt,
    },
    data: {
      transferAmount: remaining,
      debtNetted: input.expected.debtNetted + total,
      ...(remaining === 0
        ? { status: 'SETTLED_NETTED', nextAttemptAt: null, lastError: null }
        : { nextAttemptAt: input.nextAttemptAt }),
    },
  });
  if (count !== 1) {
    throw new PayoutsSettlementConflictError(
      `la venta ${input.saleId} cambió mientras se descontaba su deuda`,
    );
  }
  await new LedgerService(tx as unknown as PrismaClient).appendMany(entries);
  return taken;
}

export interface DebtView {
  readonly id: string;
  readonly reason: PayoutsDebtReason;
  readonly amountOriginal: number;
  readonly amountOutstanding: number;
  readonly currency: string;
  readonly createdAt: string;
  readonly saleId: string | null;
  readonly saleDescription: string | null;
  /** Deuda de una disputa aún abierta: no se cobra hasta que se decida. */
  readonly frozen: boolean;
  /** La tasa de una disputa que se GANÓ (Stripe no la devuelve): se explica aparte. */
  readonly fromWonDispute: boolean;
}

export interface DebtRecoveryReport {
  readonly accounts: number;
  readonly attempts: number;
  readonly recovered: Array<{ currency: string; amount: number }>;
  readonly failed: number;
}

export interface DebtAlertReport {
  readonly alerts: number;
}

export interface DebtsServiceOptions {
  readonly now?: () => Date;
  readonly logger?: PayoutsLogger;
  readonly notifier?: PayoutsNotifier;
  /** Deuda abierta (unidad mínima) a partir de la cual se avisa al operador. */
  readonly alertThresholdMinor?: number;
  /** Días con deuda abierta a partir de los cuales se avisa. */
  readonly alertAgeDays?: number;
}

const SILENT_LOGGER: PayoutsLogger = { warn: () => undefined };
const DAY_MS = 86_400_000;

export class PayoutsDebtsService {
  private readonly now: () => Date;
  private readonly logger: PayoutsLogger;
  private readonly notifier: PayoutsNotifier;
  private readonly alertThresholdMinor: number;
  private readonly alertAgeDays: number;

  constructor(
    private readonly db: PayoutsDbPort,
    private readonly stripe: PlatformStripeClient,
    options: DebtsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? SILENT_LOGGER;
    this.notifier = options.notifier ?? SILENT_NOTIFIER;
    this.alertThresholdMinor = options.alertThresholdMinor ?? 10_000;
    this.alertAgeDays = options.alertAgeDays ?? 30;
  }

  /** Deudas abiertas del tenant, de la más antigua a la más reciente. */
  async listOpen(tenantId: string): Promise<DebtView[]> {
    return this.db.inTenant(tenantId, async (tx) => {
      const [debts, frozen] = await Promise.all([
        tx.modPayoutsDebt.findMany({
          where: { tenantId, status: 'OPEN', amountOutstanding: { gt: 0 } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        frozenDisputeSaleIds(tx, tenantId),
      ]);
      const saleIds = [
        ...new Set(debts.map((d) => d.originSaleId).filter((id): id is string => !!id)),
      ];
      const sales = saleIds.length
        ? await tx.modPayoutsSale.findMany({
            where: { tenantId, id: { in: saleIds } },
            select: { id: true, description: true },
          })
        : [];
      const description = new Map(sales.map((s) => [s.id, s.description]));
      const wonFee = await wonDisputeFeeDebtIds(tx, tenantId, debts);
      return debts.map((debt) => ({
        id: debt.id,
        reason: debt.reason,
        amountOriginal: debt.amountOriginal,
        amountOutstanding: debt.amountOutstanding,
        currency: debt.currency,
        createdAt: debt.createdAt.toISOString(),
        saleId: debt.originSaleId,
        saleDescription: debt.originSaleId ? (description.get(debt.originSaleId) ?? null) : null,
        frozen:
          debt.reason === 'DISPUTE' &&
          debt.originSaleId !== null &&
          frozen.includes(debt.originSaleId),
        fromWonDispute: wonFee.has(debt.id),
      }));
    });
  }

  /**
   * Recobro diario: por cada cuenta y divisa con deuda abierta (y no
   * congelada), revierte transferencias recientes del creador hasta lo que
   * permite su saldo en Stripe.
   *
   * Cada recobro corre en UNA transacción con el cerrojo de deuda de la
   * cuenta y divisa y el de la venta cuya transferencia se revierte: la
   * liquidación no puede compensar la misma deuda mientras tanto, así que
   * nunca se cobra dos veces. Es la única llamada a Stripe del módulo dentro
   * de una transacción: una reversión, una vez al día, por deuda. Si la
   * transacción muere después de que Stripe la hiciera, el siguiente intento
   * la ADOPTA (`metadata.didacta_debt_recovery`) en vez de repetirla.
   */
  async recoverOpenDebts(options: { readonly limit?: number } = {}): Promise<DebtRecoveryReport> {
    const debts = await this.db.global((tx) =>
      tx.modPayoutsDebt.findMany({
        where: { status: 'OPEN', amountOutstanding: { gt: 0 } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: options.limit ?? 500,
        select: { id: true, tenantId: true, accountId: true, currency: true },
      }),
    );
    const groups = new Map<
      string,
      { tenantId: string; accountId: string; currency: string; ids: string[] }
    >();
    for (const debt of debts) {
      const key = `${debt.tenantId}|${debt.accountId}|${debt.currency}`;
      const group = groups.get(key) ?? {
        tenantId: debt.tenantId,
        accountId: debt.accountId,
        currency: debt.currency,
        ids: [],
      };
      group.ids.push(debt.id);
      groups.set(key, group);
    }

    let attempts = 0;
    let failed = 0;
    const recovered = new Map<string, number>();
    for (const group of groups.values()) {
      try {
        const result = await this.recoverGroup(group);
        attempts += result.attempts;
        if (result.amount > 0) {
          recovered.set(group.currency, (recovered.get(group.currency) ?? 0) + result.amount);
        }
      } catch (err) {
        failed += 1;
        this.logger.warn(
          { tenantId: group.tenantId, accountId: group.accountId, err: describe(err) },
          'payouts.debts: no se pudo intentar el recobro (se reintenta mañana)',
        );
      }
    }
    return {
      accounts: groups.size,
      attempts,
      recovered: [...recovered.entries()].map(([currency, amount]) => ({ currency, amount })),
      failed,
    };
  }

  private async recoverGroup(group: {
    tenantId: string;
    accountId: string;
    currency: string;
    ids: string[];
  }): Promise<{ attempts: number; amount: number }> {
    const { tenantId, accountId, currency } = group;
    const account = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsAccount.findFirst({
        where: { id: accountId, tenantId },
        select: { stripeAccountId: true },
      }),
    );
    if (!account?.stripeAccountId) return { attempts: 0, amount: 0 };
    const stripeAccountId = account.stripeAccountId;
    let capacity = await reversibleBalance(this.stripe, stripeAccountId, currency);
    if (capacity <= 0) return { attempts: 0, amount: 0 };

    let attempts = 0;
    let amount = 0;
    for (const debtId of group.ids) {
      if (capacity <= 0) break;
      // Una deuda puede necesitar varias transferencias.
      for (let guard = 0; guard < 20 && capacity > 0; guard += 1) {
        const step = await this.db.inTenant(tenantId, async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${debtLockKey(accountId, currency)}::text, 0))`;
          const debt = await tx.modPayoutsDebt.findFirst({
            where: { id: debtId, tenantId, status: 'OPEN' },
          });
          if (!debt || debt.amountOutstanding <= 0) return null;
          const frozen = await frozenDisputeSaleIds(tx, tenantId);
          if (
            debt.reason === 'DISPUTE' &&
            debt.originSaleId &&
            frozen.includes(debt.originSaleId)
          ) {
            return null;
          }
          const candidates = await tx.modPayoutsSale.findMany({
            where: {
              tenantId,
              accountId,
              currency,
              status: 'TRANSFERRED',
              stripeTransferId: { not: null },
            },
            orderBy: [{ transferredAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
            take: 100,
          });
          const sale = candidates.find((s) => (s.transferAmount ?? 0) - s.reversedAmount > 0);
          if (!sale) return null;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${saleLockKey(sale.id)}::text, 0))`;
          const fresh = await tx.modPayoutsSale.findFirstOrThrow({
            where: { id: sale.id, tenantId },
          });
          const room = (fresh.transferAmount ?? 0) - fresh.reversedAmount;
          const take = Math.min(debt.amountOutstanding, capacity, room);
          if (take <= 0) return null;

          const attempt =
            (await tx.modPayoutsLedgerEntry.count({
              where: {
                tenantId,
                type: 'TRANSFER_REVERSAL',
                idempotencyKey: { startsWith: `payouts:debt-recovery:${debt.id}:` },
              },
            })) + 1;
          const key = IDEMPOTENCY_KEYS.debtRecovery(debt.id, attempt);
          const reversal = await reverseTransfer(this.stripe, {
            transferId: fresh.stripeTransferId!,
            stripeAccountId,
            currency,
            target: take,
            idempotencyKey: key,
            metadata: {
              didacta_debt_recovery: `${debt.id}:${attempt}`,
              didacta_tenant_id: tenantId,
              didacta_sale_id: fresh.id,
            },
            metaKey: 'didacta_debt_recovery',
            description: 'Didacta: recobro de deuda',
          });
          if (reversal.reversed <= 0) return { reversed: 0, detail: reversal.detail };

          const left = debt.amountOutstanding - reversal.reversed;
          await tx.modPayoutsDebt.update({
            where: { id: debt.id },
            data: { amountOutstanding: left, status: left === 0 ? 'RECOVERED' : 'OPEN' },
          });
          await tx.modPayoutsSale.update({
            where: { id: fresh.id },
            data: { reversedAmount: fresh.reversedAmount + reversal.reversed },
          });
          const occurredAt = this.now();
          await new LedgerService(tx as unknown as PrismaClient).appendMany([
            {
              tenantId,
              accountId,
              saleId: fresh.id,
              type: 'TRANSFER_REVERSAL',
              amount: reversal.reversed,
              currency,
              stripeObjectId: reversal.reversalId,
              idempotencyKey: key,
              occurredAt,
              metadata: { debtId: debt.id, transferId: fresh.stripeTransferId },
            },
            {
              tenantId,
              accountId,
              saleId: null,
              type: 'DEBT_RECOVERED',
              amount: -reversal.reversed,
              currency,
              stripeObjectId: reversal.reversalId,
              idempotencyKey: `${key}:debt`,
              occurredAt,
              metadata: { debtId: debt.id, via: 'reversal', saleId: fresh.id },
            },
          ]);
          return { reversed: reversal.reversed, detail: reversal.detail };
        });
        if (!step) break;
        attempts += 1;
        if (step.reversed <= 0) {
          this.logger.warn(
            { tenantId, debtId, detail: step.detail },
            'payouts.debts: Stripe no dejó revertir para cobrar la deuda (se reintenta mañana)',
          );
          capacity = 0;
          break;
        }
        amount += step.reversed;
        capacity -= step.reversed;
      }
    }
    if (amount > 0) {
      this.logger.log?.(
        { tenantId, accountId, currency, amount },
        'payouts.debts: deuda cobrada revirtiendo transferencias',
      );
    }
    return { attempts, amount };
  }

  /**
   * Aviso al operador por cuenta y divisa: deuda abierta por encima del umbral
   * (`PAYMENTS_PLATFORM_DEBT_ALERT_MINOR`) o con más de 30 días.
   */
  async alertOldOrLargeDebts(): Promise<DebtAlertReport> {
    const now = this.now();
    const debts = await this.db.global((tx) =>
      tx.modPayoutsDebt.findMany({
        where: { status: 'OPEN', amountOutstanding: { gt: 0 } },
        select: {
          tenantId: true,
          accountId: true,
          currency: true,
          amountOutstanding: true,
          createdAt: true,
          reason: true,
        },
      }),
    );
    const groups = new Map<
      string,
      {
        tenantId: string;
        accountId: string;
        currency: string;
        total: number;
        oldest: Date;
        reasons: Set<string>;
      }
    >();
    for (const debt of debts) {
      const key = `${debt.tenantId}|${debt.accountId}|${debt.currency}`;
      const group = groups.get(key) ?? {
        tenantId: debt.tenantId,
        accountId: debt.accountId,
        currency: debt.currency,
        total: 0,
        oldest: debt.createdAt,
        reasons: new Set<string>(),
      };
      group.total += debt.amountOutstanding;
      if (debt.createdAt < group.oldest) group.oldest = debt.createdAt;
      group.reasons.add(debt.reason);
      groups.set(key, group);
    }
    let alerts = 0;
    for (const group of groups.values()) {
      const ageDays = Math.floor((now.getTime() - group.oldest.getTime()) / DAY_MS);
      const large = group.total > this.alertThresholdMinor;
      const old = ageDays >= this.alertAgeDays;
      if (!large && !old) continue;
      alerts += 1;
      const detail = {
        tenantId: group.tenantId,
        accountId: group.accountId,
        currency: group.currency,
        outstanding: group.total,
        oldestDays: ageDays,
        reasons: [...group.reasons],
        why: [large ? 'importe' : null, old ? 'antigüedad' : null].filter(Boolean),
      };
      (this.logger.error ?? this.logger.warn).call(
        this.logger,
        { alert: PAYOUTS_LOSS_ALERTS.debtAlert, ...detail },
        `${PAYOUTS_LOSS_ALERTS.debtAlert}: un creador debe ${group.total} ${group.currency} desde hace ${ageDays} días`,
      );
      await this.notifier
        .operatorAlert(PAYOUTS_LOSS_ALERTS.debtAlert, detail)
        .catch(() => undefined);
    }
    return { alerts };
  }
}

function describe(err: unknown): string {
  if (err instanceof PlatformStripeApiError)
    return `${err.operation}: ${err.detail ?? err.message}`;
  return err instanceof Error ? err.message : String(err);
}
