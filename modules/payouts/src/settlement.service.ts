/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PayoutsSaleStatus, PrismaClient } from '@didacta/database';
import type { PayoutsDbPort, PayoutsLogger, PayoutsTx } from './accounts.service.js';
import { PayoutsSettlementConflictError, PlatformStripeApiError } from './errors.js';
import { idOf } from './event-router.js';
import { IDEMPOTENCY_KEYS, LedgerService, type LedgerEntryInput } from './ledger.service.js';
import { frozenDisputeSaleIds, unfrozenDebtsWhere } from './debts.service.js';
import { assertFeeBps, computeSplit, normalizeCurrency } from './money.js';
import { RefsService } from './refs.service.js';
import type { PayoutsSettingsService } from './settings.service.js';
import type { PlatformStripeClient } from './stripe/platform-stripe.client.js';

/**
 * Liquidación de una venta (etapa E4): de la venta cobrada a la
 * transferencia exacta al creador y sus asientos en el libro.
 *
 * Reglas que no se negocian:
 *
 *  1. **Los importes salen de la API, nunca del evento.** Cada intento relee
 *     el cargo con su `balance_transaction` (`GET /v1/charges/{id}`). El
 *     reparto se calcula en la divisa de LIQUIDACIÓN (`balance_transaction.
 *     currency`), con la comisión REAL de Stripe (`balance_transaction.fee`).
 *  2. **El reparto se sella antes de llamar a Stripe.** En una transacción, con
 *     la venta como cerrojo (actualización condicionada al estado) y un cerrojo
 *     de deuda por cuenta y divisa, se fijan `gross`, comisiones,
 *     `debt_netted` y `transfer_amount`, se descuenta la deuda abierta de la
 *     MISMA divisa y se anotan `SALE_GROSS`, `STRIPE_FEE`, `PLATFORM_FEE` y
 *     `DEBT_RECOVERED`. Un reintento nunca recalcula: reutiliza el reparto
 *     sellado, así que la petición a Stripe es byte a byte la misma.
 *  3. **Una transferencia por venta.** Antes de crearla se busca en Stripe
 *     (`GET /v1/transfers?transfer_group=…&destination=…`) una con
 *     `metadata.didacta_sale_id` de esta venta; si existe, se adopta. Se crea
 *     con `source_transaction`, `destination`, `transfer_group` y la cabecera
 *     `Idempotency-Key: payouts:transfer:<saleId>` (`…:<n>` tras el n-ésimo
 *     rechazo definitivo: Stripe guarda 24 h la respuesta de un 4xx, y
 *     reintentar con la misma clave devolvería el mismo rechazo).
 *  4. **Un solo trabajador por venta.** Quien sella el reparto (o toma el
 *     relevo de una venta `READY`/`HELD` vencida) se queda un arriendo
 *     (`next_attempt_at` en el futuro, actualización condicionada). El webhook
 *     (`charge.updated` ×5 a la vez) y el barrido no duplican.
 *  5. **Lo que no se puede hacer no se fuerza.** Sin `balance_transaction`, la
 *     venta sigue `AWAITING_FEE` con la próxima consulta programada. Cuenta
 *     restringida, transferencia rechazada, cargo reembolsado o disputado →
 *     `HELD` con motivo y reintento. Lo que no cuadra (cargo de otra cuenta,
 *     neto negativo, transferencia distinta de la sellada) → `FAILED` y alerta.
 *
 * Invariante por venta: `gross − stripe_fee − platform_fee = creator_net =
 * transfer_amount + debt_netted`.
 */

/** Motivo de una venta retenida (`HELD`), al principio de `last_error`. */
export const SALE_HOLD_REASONS = {
  /** La cuenta del creador está restringida o rechazada: Stripe no admite transferencias. */
  accountNotReady: 'account_not_ready',
  /** Stripe rechazó la transferencia (saldo, capacidad…). Se reintenta cada día. */
  transferRejected: 'transfer_rejected',
  /**
   * El cargo tiene reembolsos que aún no están anotados: se espera a que los
   * anote `refunds.service.ts` (que descuenta de esta transferencia pendiente
   * lo que toque) y después la venta sigue sola.
   */
  chargeRefunded: 'charge_refunded',
  /** El cargo tiene una disputa sin decidir: no se transfiere hasta que se decida. */
  chargeDisputed: 'charge_disputed',
  /**
   * Faltan los datos fiscales del creador (factura y DAC7). Se libera sola en
   * cuanto los completa (`tax-profile.service.ts`).
   */
  taxProfileIncomplete: 'tax_profile_incomplete',
} as const;
export type SaleHoldReason = (typeof SALE_HOLD_REASONS)[keyof typeof SALE_HOLD_REASONS];

/** Motivo de una venta que necesita intervención (`FAILED`). */
export const SALE_FAILURE_REASONS = {
  /** El cargo no es de la cuenta de la venta, o no está cobrado. */
  chargeMismatch: 'charge_mismatch',
  /** La comisión de Stripe y la del operador superan el bruto. */
  negativeNet: 'negative_net',
  /** Stripe tiene para esta venta una transferencia que no es la sellada. */
  transferMismatch: 'transfer_mismatch',
} as const;
export type SaleFailureReason = (typeof SALE_FAILURE_REASONS)[keyof typeof SALE_FAILURE_REASONS];

/** Alertas que buscan los operadores en los logs. */
export const PAYOUTS_ALERTS = {
  settlementFailed: 'payouts.settlement_failed',
  balanceTransactionLate: 'payouts.balance_transaction_late',
  chargeUnattributed: 'payouts.charge_unattributed',
  chargeUnhandled: 'payouts.charge_unhandled',
  transferUnrecorded: 'payouts.transfer_unrecorded',
  transferMismatch: 'payouts.transfer_mismatch',
  ledgerInvariant: 'payouts.ledger_invariant',
  eventReplayFailed: 'payouts.event_replay_failed',
} as const;

/** `transfer_rejected: <detalle>` → `transfer_rejected`. */
export function saleReasonCode(lastError: string | null | undefined): string | null {
  const match = /^([a-z_]+):/.exec(lastError ?? '');
  return match ? match[1]! : null;
}

export type SettleOutcome =
  /** Transferencia creada (o adoptada) y anotada. */
  | {
      readonly outcome: 'transferred';
      readonly saleId: string;
      readonly transferId: string;
      readonly transferAmount: number;
      readonly debtNetted: number;
      readonly currency: string;
    }
  /** La deuda abierta absorbió todo el neto: sin transferencia. */
  | {
      readonly outcome: 'netted';
      readonly saleId: string;
      readonly debtNetted: number;
      readonly currency: string;
    }
  /** El cargo aún no tiene `balance_transaction`. */
  | { readonly outcome: 'awaiting_fee'; readonly saleId: string; readonly nextAttemptAt: Date }
  | { readonly outcome: 'held'; readonly saleId: string; readonly reason: SaleHoldReason }
  /** Error transitorio de Stripe: se reintenta pronto con la misma clave. */
  | { readonly outcome: 'retry'; readonly saleId: string; readonly reason: string }
  | { readonly outcome: 'failed'; readonly saleId: string; readonly reason: SaleFailureReason }
  /** Otro trabajador la tiene entre manos (o aún no toca reintentar). */
  | { readonly outcome: 'busy'; readonly saleId: string }
  /** Ya estaba liquidada (o en `FAILED`): no se toca. */
  | { readonly outcome: 'already_settled'; readonly saleId: string; readonly status: string }
  | { readonly outcome: 'not_found'; readonly saleId: string };

export interface SettleSweepResult {
  readonly due: number;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly errors: number;
}

export interface SettlementServiceOptions {
  readonly now?: () => Date;
  readonly logger?: PayoutsLogger;
  /** Cuánto se reserva una venta quien la está transfiriendo. */
  readonly leaseMs?: number;
  /** Cuándo se reintenta una venta retenida. Por defecto, al día siguiente. */
  readonly heldRetryMs?: number;
  /** Cuándo se reintenta tras un error transitorio de Stripe. */
  readonly transientRetryMs?: number;
  /**
   * ¿Se puede transferir a este creador? Devuelve el motivo para retener
   * (`tax_profile_incomplete`) o `null`. Sin él, no se retiene por esto.
   */
  readonly transferGate?: { transferBlockReason(tenantId: string): Promise<string | null> };
}

const FINAL_STATUSES: ReadonlySet<PayoutsSaleStatus> = new Set([
  'TRANSFERRED',
  'SETTLED_NETTED',
  'FAILED',
]);
/** Estados desde los que se puede sellar un reparto (si aún no lo tiene). */
const PLANNABLE_STATUSES: PayoutsSaleStatus[] = ['AWAITING_FEE', 'READY', 'HELD'];
/** Estados con reparto sellado pendiente de transferencia. */
const TRANSFERABLE_STATUSES: PayoutsSaleStatus[] = ['READY', 'HELD'];
const ACCOUNT_BLOCKED_STATUSES = new Set(['RESTRICTED', 'REJECTED']);

const MINUTE = 60_000;
const DEFAULT_LEASE_MS = 5 * MINUTE;
const DEFAULT_HELD_RETRY_MS = 24 * 60 * MINUTE;
const DEFAULT_TRANSIENT_RETRY_MS = 5 * MINUTE;

/**
 * Próxima consulta de una venta sin `balance_transaction`, según cuánto lleva
 * cobrada: Stripe suele tardar segundos, pero documenta hasta una hora.
 */
export function awaitingFeeBackoffMs(ageMs: number): number {
  if (ageMs < 10 * MINUTE) return MINUTE;
  if (ageMs < 2 * 60 * MINUTE) return 5 * MINUTE;
  if (ageMs < 24 * 60 * MINUTE) return 30 * MINUTE;
  return 2 * 60 * MINUTE;
}

interface BalanceTransactionFromApi {
  readonly id?: unknown;
  readonly amount?: unknown;
  readonly fee?: unknown;
  readonly currency?: unknown;
  readonly available_on?: unknown;
}

interface ChargeFromApi {
  readonly id: string;
  readonly status?: string;
  readonly paid?: boolean;
  readonly amount_refunded?: number;
  readonly refunded?: boolean;
  readonly disputed?: boolean;
  readonly on_behalf_of?: unknown;
  readonly transfer_group?: string | null;
  readonly livemode?: boolean;
  readonly balance_transaction?: unknown;
}

interface TransferFromApi {
  readonly id: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly destination?: unknown;
  readonly created?: number;
  readonly livemode?: boolean;
  readonly balance_transaction?: unknown;
  readonly metadata?: Record<string, unknown> | null;
}

type SaleRow = Awaited<ReturnType<PayoutsTx['modPayoutsSale']['findFirstOrThrow']>>;
type AccountRow = Awaited<ReturnType<PayoutsTx['modPayoutsAccount']['findFirstOrThrow']>>;

const SILENT_LOGGER: PayoutsLogger = { warn: () => undefined };

export class SettlementService {
  private readonly now: () => Date;
  private readonly logger: PayoutsLogger;
  private readonly leaseMs: number;
  private readonly heldRetryMs: number;
  private readonly transientRetryMs: number;
  private readonly transferGate: SettlementServiceOptions['transferGate'];

  constructor(
    private readonly db: PayoutsDbPort,
    private readonly stripe: PlatformStripeClient,
    private readonly settings: Pick<PayoutsSettingsService, 'get'>,
    options: SettlementServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? SILENT_LOGGER;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.heldRetryMs = options.heldRetryMs ?? DEFAULT_HELD_RETRY_MS;
    this.transientRetryMs = options.transientRetryMs ?? DEFAULT_TRANSIENT_RETRY_MS;
    this.transferGate = options.transferGate;
  }

  /**
   * Avanza una venta todo lo que se pueda ahora mismo. Idempotente y segura
   * con llamadas simultáneas.
   *
   * @param options.force Ignora la espera programada de una venta
   *   `AWAITING_FEE` (la dispara un `charge.updated`). No salta el arriendo
   *   de una transferencia en curso ni el reintento diario de una retenida.
   */
  async settleSale(
    tenantId: string,
    saleId: string,
    options: { readonly force?: boolean } = {},
  ): Promise<SettleOutcome> {
    const sale = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsSale.findFirst({ where: { id: saleId, tenantId } }),
    );
    if (!sale) return { outcome: 'not_found', saleId };
    if (FINAL_STATUSES.has(sale.status)) {
      return { outcome: 'already_settled', saleId, status: sale.status };
    }
    const now = this.now();
    const due = sale.nextAttemptAt === null || sale.nextAttemptAt.getTime() <= now.getTime();

    if (sale.transferAmount === null) {
      const forced = options.force === true && sale.status === 'AWAITING_FEE';
      if (!due && !forced) return { outcome: 'busy', saleId };
      return this.planAndTransfer(tenantId, sale);
    }

    if (!due) return { outcome: 'busy', saleId };
    const lease = await this.acquireLease(tenantId, sale);
    if (!lease) return { outcome: 'busy', saleId };
    return this.transfer(tenantId, lease.sale, lease.until, null);
  }

  /**
   * Ventas que toca mover ahora: `AWAITING_FEE`, `READY` y `HELD` cuya
   * próxima consulta ya venció. La fila de venta ES la cola. Acceso global
   * sancionado (barrido del worker).
   */
  async listDue(limit = 50): Promise<Array<{ id: string; tenantId: string }>> {
    const now = this.now();
    return this.db.global((tx) =>
      tx.modPayoutsSale.findMany({
        where: {
          status: { in: PLANNABLE_STATUSES },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        orderBy: [{ nextAttemptAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
        take: limit,
        select: { id: true, tenantId: true },
      }),
    );
  }

  /**
   * Un barrido: cada venta vencida, con su tenant. Un fallo con una venta no
   * para el resto (la venta conserva su arriendo y se reintenta al vencer).
   */
  async sweep(limit = 50): Promise<SettleSweepResult> {
    const due = await this.listDue(limit);
    const outcomes: Record<string, number> = {};
    let errors = 0;
    for (const sale of due) {
      try {
        const result = await this.settleSale(sale.tenantId, sale.id);
        outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
      } catch (err) {
        errors += 1;
        this.logger.warn(
          { saleId: sale.id, tenantId: sale.tenantId, err: describeError(err) },
          'payouts.settle: no se pudo avanzar una venta (se reintenta en el próximo barrido)',
        );
      }
    }
    return { due: due.length, outcomes, errors };
  }

  // ── Sellar el reparto ──────────────────────────────────────────────────

  private async planAndTransfer(tenantId: string, sale: SaleRow): Promise<SettleOutcome> {
    const now = this.now();
    const account = await this.loadAccount(tenantId, sale.accountId);
    const charge = await this.readCharge(sale.stripeChargeId);

    if (!account?.stripeAccountId || idOf(charge.on_behalf_of) !== account.stripeAccountId) {
      return this.fail(
        tenantId,
        sale,
        SALE_FAILURE_REASONS.chargeMismatch,
        `el cargo ${charge.id} es en nombre de ${idOf(charge.on_behalf_of) ?? 'nadie'} y la venta es de ${account?.stripeAccountId ?? 'una cuenta sin acct_'}`,
      );
    }
    if (charge.status !== 'succeeded' || charge.paid !== true) {
      return this.fail(
        tenantId,
        sale,
        SALE_FAILURE_REASONS.chargeMismatch,
        `el cargo ${charge.id} no está cobrado (${String(charge.status)})`,
      );
    }
    // Un cargo reembolsado o disputado también SELLA su reparto (los
    // reembolsos y las disputas se anotan contra él); lo que no hace es
    // transferir hasta que estén anotados: eso lo decide `transfer()`.
    const bt = this.balanceTransactionOf(charge);
    if (!bt) {
      const chargedAt = (sale.chargedAt ?? sale.createdAt).getTime();
      const nextAttemptAt = new Date(
        now.getTime() + awaitingFeeBackoffMs(now.getTime() - chargedAt),
      );
      await this.db.inTenant(tenantId, (tx) =>
        tx.modPayoutsSale.updateMany({
          where: { id: sale.id, tenantId, status: 'AWAITING_FEE', transferAmount: null },
          data: { nextAttemptAt },
        }),
      );
      return { outcome: 'awaiting_fee', saleId: sale.id, nextAttemptAt };
    }

    // Comisión sellada en un intento anterior, o la vigente del tenant.
    const feeBps = sale.feeBpsApplied ?? (await this.settings.get(tenantId)).feeBps;
    assertFeeBps(feeBps);
    const split = computeSplit({ gross: bt.amount, stripeFee: bt.fee, feeBps });
    const currency = bt.currency;
    const splitColumns = {
      gross: split.gross,
      stripeFee: split.stripeFee,
      feeBpsApplied: split.feeBpsApplied,
      platformFee: split.platformFee,
      creatorNet: split.creatorNet,
      currency,
      stripeBalanceTransactionId: bt.id,
      availableOn: bt.availableOn,
    };
    if (split.creatorNet < 0) {
      return this.fail(
        tenantId,
        sale,
        SALE_FAILURE_REASONS.negativeNet,
        `bruto ${split.gross} − Stripe ${split.stripeFee} − operador ${split.platformFee} = ${split.creatorNet} ${currency}`,
        splitColumns,
      );
    }

    const sealed = await this.db.inTenant(tenantId, async (tx) => {
      // Cerrojo de la deuda de esta cuenta en esta divisa: dos ventas a la vez
      // no pueden compensar la misma deuda.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payouts:debt:${sale.accountId}:${currency}`}::text, 0))`;
      // La deuda de una disputa aún abierta no se cobra (E6): si se gana, se cancela.
      const frozen = split.creatorNet > 0 ? await frozenDisputeSaleIds(tx, tenantId) : [];
      const debts =
        split.creatorNet > 0
          ? await tx.modPayoutsDebt.findMany({
              where: {
                tenantId,
                accountId: sale.accountId,
                currency,
                status: 'OPEN',
                amountOutstanding: { gt: 0 },
                ...unfrozenDebtsWhere(frozen),
              },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            })
          : [];
      let remaining = split.creatorNet;
      const allocations: Array<{ id: string; outstanding: number; take: number }> = [];
      for (const debt of debts) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, debt.amountOutstanding);
        allocations.push({ id: debt.id, outstanding: debt.amountOutstanding, take });
        remaining -= take;
      }
      const transferAmount = remaining;
      const debtNetted = split.creatorNet - transferAmount;
      const status: PayoutsSaleStatus = transferAmount > 0 ? 'READY' : 'SETTLED_NETTED';
      const leaseUntil = transferAmount > 0 ? new Date(now.getTime() + this.leaseMs) : null;

      // La venta es el cerrojo: solo uno sella el reparto.
      const { count } = await tx.modPayoutsSale.updateMany({
        where: {
          id: sale.id,
          tenantId,
          transferAmount: null,
          status: { in: PLANNABLE_STATUSES },
        },
        data: {
          ...splitColumns,
          debtNetted,
          transferAmount,
          status,
          nextAttemptAt: leaseUntil,
          lastError: null,
        },
      });
      if (count !== 1) return null;

      for (const allocation of allocations) {
        const left = allocation.outstanding - allocation.take;
        const updated = await tx.modPayoutsDebt.updateMany({
          where: { id: allocation.id, status: 'OPEN', amountOutstanding: allocation.outstanding },
          data: { amountOutstanding: left, status: left === 0 ? 'RECOVERED' : 'OPEN' },
        });
        if (updated.count !== 1) {
          throw new PayoutsSettlementConflictError(`la deuda ${allocation.id} cambió a mitad`);
        }
      }

      const base = {
        tenantId,
        accountId: sale.accountId,
        saleId: sale.id,
        currency,
        occurredAt: sale.chargedAt ?? now,
      };
      const entries: LedgerEntryInput[] = [
        {
          ...base,
          type: 'SALE_GROSS',
          amount: split.gross,
          stripeObjectId: charge.id,
          stripeBalanceTransactionId: bt.id,
          idempotencyKey: IDEMPOTENCY_KEYS.saleEntry(sale.id, 'SALE_GROSS'),
        },
        {
          ...base,
          type: 'STRIPE_FEE',
          amount: -split.stripeFee,
          stripeObjectId: charge.id,
          stripeBalanceTransactionId: bt.id,
          idempotencyKey: IDEMPOTENCY_KEYS.saleEntry(sale.id, 'STRIPE_FEE'),
        },
        {
          ...base,
          type: 'PLATFORM_FEE',
          amount: -split.platformFee,
          stripeObjectId: charge.id,
          idempotencyKey: IDEMPOTENCY_KEYS.saleEntry(sale.id, 'PLATFORM_FEE'),
          metadata: { feeBps: split.feeBpsApplied },
        },
        ...allocations.map(
          (allocation): LedgerEntryInput => ({
            ...base,
            type: 'DEBT_RECOVERED',
            amount: -allocation.take,
            idempotencyKey: IDEMPOTENCY_KEYS.debtNetting(allocation.id, sale.id),
            metadata: { debtId: allocation.id },
          }),
        ),
      ];
      await new LedgerService(tx as unknown as PrismaClient).appendMany(entries);
      return { transferAmount, debtNetted, status, leaseUntil };
    });

    if (!sealed) return { outcome: 'busy', saleId: sale.id };
    if (sealed.status === 'SETTLED_NETTED') {
      this.logger.log?.(
        { saleId: sale.id, tenantId, debtNetted: sealed.debtNetted, currency },
        'payouts.settle: la deuda absorbió el neto de la venta',
      );
      return { outcome: 'netted', saleId: sale.id, debtNetted: sealed.debtNetted, currency };
    }
    const fresh = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsSale.findFirstOrThrow({ where: { id: sale.id, tenantId } }),
    );
    return this.transfer(tenantId, fresh, sealed.leaseUntil!, charge);
  }

  // ── Transferir ─────────────────────────────────────────────────────────

  /** Se reserva una venta `READY`/`HELD` vencida. `null` si otro se adelantó. */
  private async acquireLease(
    tenantId: string,
    sale: SaleRow,
  ): Promise<{ sale: SaleRow; until: Date } | null> {
    const until = new Date(this.now().getTime() + this.leaseMs);
    const { count } = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsSale.updateMany({
        where: {
          id: sale.id,
          tenantId,
          status: sale.status,
          stripeTransferId: null,
          nextAttemptAt: sale.nextAttemptAt,
        },
        data: { nextAttemptAt: until },
      }),
    );
    if (count !== 1) return null;
    return { sale: { ...sale, nextAttemptAt: until }, until };
  }

  private async transfer(
    tenantId: string,
    sale: SaleRow,
    leaseUntil: Date,
    chargeRead: ChargeFromApi | null,
  ): Promise<SettleOutcome> {
    const account = await this.loadAccount(tenantId, sale.accountId);
    const destination = account?.stripeAccountId ?? null;
    if (!account || !destination) {
      return this.fail(
        tenantId,
        sale,
        SALE_FAILURE_REASONS.chargeMismatch,
        'la cuenta de la venta no tiene acct_',
      );
    }
    if (ACCOUNT_BLOCKED_STATUSES.has(account.status)) {
      return this.hold(
        tenantId,
        sale,
        SALE_HOLD_REASONS.accountNotReady,
        `cuenta ${account.status}`,
        leaseUntil,
      );
    }

    if (this.transferGate) {
      const gated = await this.transferGate.transferBlockReason(tenantId);
      if (gated === SALE_HOLD_REASONS.taxProfileIncomplete) {
        return this.hold(
          tenantId,
          sale,
          SALE_HOLD_REASONS.taxProfileIncomplete,
          'faltan los datos fiscales del creador',
          leaseUntil,
        );
      }
    }

    const charge = chargeRead ?? (await this.readCharge(sale.stripeChargeId));
    const blocked = await this.chargeHoldReason(tenantId, sale.id, charge);
    if (blocked) return this.hold(tenantId, sale, blocked, `cargo ${charge.id}`, leaseUntil);

    const amount = sale.transferAmount!;
    const currency = sale.currency!;
    const transferGroup =
      typeof charge.transfer_group === 'string' && charge.transfer_group.length > 0
        ? charge.transfer_group
        : `didacta_sale_${sale.id}`;

    let transfer: TransferFromApi;
    try {
      transfer =
        (await this.findExistingTransfer(transferGroup, destination, sale.id)) ??
        (await this.stripe.v1<TransferFromApi>(
          'POST',
          '/v1/transfers',
          {
            amount,
            currency,
            destination,
            source_transaction: sale.stripeChargeId,
            transfer_group: transferGroup,
            description: (sale.description ?? '').slice(0, 300) || undefined,
            metadata: { didacta_sale_id: sale.id, didacta_tenant_id: tenantId },
          },
          {
            idempotencyKey:
              sale.attempts === 0
                ? IDEMPOTENCY_KEYS.transfer(sale.id)
                : `${IDEMPOTENCY_KEYS.transfer(sale.id)}:${sale.attempts}`,
          },
        ));
    } catch (err) {
      if (!(err instanceof PlatformStripeApiError)) throw err;
      const detail = `${err.stripeCode ?? err.type ?? err.status}: ${err.detail ?? err.message}`;
      if (err.retryable) return this.retryLater(tenantId, sale, detail, leaseUntil);
      return this.hold(tenantId, sale, SALE_HOLD_REASONS.transferRejected, detail, leaseUntil, {
        rejected: true,
      });
    }

    if (
      transfer.amount !== amount ||
      (transfer.currency ?? '').toLowerCase() !== currency ||
      idOf(transfer.destination) !== destination
    ) {
      return this.fail(
        tenantId,
        sale,
        SALE_FAILURE_REASONS.transferMismatch,
        `${transfer.id}: ${String(transfer.amount)} ${String(transfer.currency)} a ${String(idOf(transfer.destination))}; sellado ${amount} ${currency} a ${destination}`,
      );
    }

    const transferredAt =
      typeof transfer.created === 'number' ? new Date(transfer.created * 1000) : this.now();
    await this.db.inTenant(tenantId, async (tx) => {
      const { count } = await tx.modPayoutsSale.updateMany({
        where: {
          id: sale.id,
          tenantId,
          stripeTransferId: null,
          status: { in: TRANSFERABLE_STATUSES },
          // Un reembolso anotado mientras tanto habría cambiado el importe.
          transferAmount: amount,
        },
        data: {
          status: 'TRANSFERRED',
          stripeTransferId: transfer.id,
          transferredAt,
          nextAttemptAt: null,
          lastError: null,
        },
      });
      if (count !== 1) {
        const current = await tx.modPayoutsSale.findFirst({ where: { id: sale.id, tenantId } });
        if (current?.stripeTransferId !== transfer.id) {
          throw new PayoutsSettlementConflictError(
            `la venta ${sale.id} cambió mientras se transfería (${String(current?.status)})`,
          );
        }
      }
      await new LedgerService(tx as unknown as PrismaClient).append({
        tenantId,
        accountId: sale.accountId,
        saleId: sale.id,
        type: 'TRANSFER',
        amount: -amount,
        currency,
        stripeObjectId: transfer.id,
        stripeBalanceTransactionId: idOf(transfer.balance_transaction),
        idempotencyKey: IDEMPOTENCY_KEYS.transfer(sale.id),
        occurredAt: transferredAt,
        metadata: { destination, transferGroup },
      });
      await new RefsService(tx as unknown as PrismaClient).register({
        tenantId,
        stripeObjectId: transfer.id,
        kind: 'transfer',
        source: 'payouts',
        localRef: sale.id,
        parentObjectId: sale.stripeChargeId,
        livemode: transfer.livemode === true,
      });
    });

    return {
      outcome: 'transferred',
      saleId: sale.id,
      transferId: transfer.id,
      transferAmount: amount,
      debtNetted: sale.debtNetted,
      currency,
    };
  }

  /**
   * Transferencia de esta venta ya creada en Stripe (un intento anterior que
   * murió tras crearla, o de hace más de 24 h, cuando Stripe ya olvidó la
   * clave de idempotencia). Se busca SIEMPRE antes de crear.
   */
  private async findExistingTransfer(
    transferGroup: string,
    destination: string,
    saleId: string,
  ): Promise<TransferFromApi | null> {
    const list = await this.stripe.v1<{ data?: TransferFromApi[] }>('GET', '/v1/transfers', {
      transfer_group: transferGroup,
      destination,
      limit: 100,
    });
    return (list.data ?? []).find((t) => t.metadata?.['didacta_sale_id'] === saleId) ?? null;
  }

  // ── Estados de espera y fallo ──────────────────────────────────────────

  private async hold(
    tenantId: string,
    sale: SaleRow,
    reason: SaleHoldReason,
    detail: string,
    leaseUntil: Date | null,
    options: { readonly rejected?: boolean } = {},
  ): Promise<SettleOutcome> {
    const retryAt = new Date(this.now().getTime() + this.heldRetryMs);
    await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsSale.updateMany({
        where: {
          id: sale.id,
          tenantId,
          status: { in: PLANNABLE_STATUSES },
          stripeTransferId: null,
          ...(leaseUntil ? { nextAttemptAt: leaseUntil } : {}),
        },
        data: {
          status: 'HELD',
          lastError: `${reason}: ${detail}`.slice(0, 500),
          nextAttemptAt: retryAt,
          ...(options.rejected ? { attempts: { increment: 1 } } : {}),
        },
      }),
    );
    this.logger.warn(
      { saleId: sale.id, tenantId, reason, detail },
      'payouts.settle: venta retenida (se reintenta mañana)',
    );
    return { outcome: 'held', saleId: sale.id, reason };
  }

  private async retryLater(
    tenantId: string,
    sale: SaleRow,
    detail: string,
    leaseUntil: Date,
  ): Promise<SettleOutcome> {
    await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsSale.updateMany({
        where: { id: sale.id, tenantId, stripeTransferId: null, nextAttemptAt: leaseUntil },
        data: {
          lastError: `stripe_unavailable: ${detail}`.slice(0, 500),
          nextAttemptAt: new Date(this.now().getTime() + this.transientRetryMs),
        },
      }),
    );
    return { outcome: 'retry', saleId: sale.id, reason: detail };
  }

  private async fail(
    tenantId: string,
    sale: SaleRow,
    reason: SaleFailureReason,
    detail: string,
    columns: Record<string, unknown> = {},
  ): Promise<SettleOutcome> {
    await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsSale.updateMany({
        where: {
          id: sale.id,
          tenantId,
          status: { in: PLANNABLE_STATUSES },
          stripeTransferId: null,
        },
        data: {
          ...columns,
          status: 'FAILED',
          lastError: `${reason}: ${detail}`.slice(0, 500),
          nextAttemptAt: null,
        },
      }),
    );
    this.alert(
      PAYOUTS_ALERTS.settlementFailed,
      { saleId: sale.id, tenantId, reason, detail },
      'la venta necesita intervención',
    );
    return { outcome: 'failed', saleId: sale.id, reason };
  }

  // ── Lectura de Stripe ──────────────────────────────────────────────────

  private readCharge(chargeId: string): Promise<ChargeFromApi> {
    return this.stripe.v1<ChargeFromApi>('GET', `/v1/charges/${encodeURIComponent(chargeId)}`, {
      expand: ['balance_transaction'],
    });
  }

  private balanceTransactionOf(charge: ChargeFromApi): {
    id: string;
    amount: number;
    fee: number;
    currency: string;
    availableOn: Date | null;
  } | null {
    const bt = charge.balance_transaction;
    if (!bt || typeof bt !== 'object') return null;
    const raw = bt as BalanceTransactionFromApi;
    const id = idOf(raw.id);
    if (
      !id ||
      typeof raw.amount !== 'number' ||
      !Number.isInteger(raw.amount) ||
      raw.amount <= 0 ||
      typeof raw.fee !== 'number' ||
      !Number.isInteger(raw.fee) ||
      raw.fee < 0
    ) {
      return null;
    }
    return {
      id,
      amount: raw.amount,
      fee: raw.fee,
      currency: normalizeCurrency(raw.currency),
      availableOn: typeof raw.available_on === 'number' ? new Date(raw.available_on * 1000) : null,
    };
  }

  /**
   * ¿Hay algo en el cargo que aún no está anotado? (E6)
   *
   *  - Una disputa sin decidir (o que Stripe tiene y nosotros aún no) →
   *    retenida hasta que se decida.
   *  - Más reembolsado en Stripe que anotado en el libro → retenida hasta que
   *    se anote: la anotación descuenta de ESTA transferencia lo que toca al
   *    creador. Con todo anotado, la venta sigue con su importe ya reducido.
   */
  private async chargeHoldReason(
    tenantId: string,
    saleId: string,
    charge: ChargeFromApi,
  ): Promise<SaleHoldReason | null> {
    const refunded = charge.amount_refunded ?? 0;
    if (charge.disputed !== true && refunded === 0) return null;
    const recorded = await this.db.inTenant(tenantId, async (tx) => ({
      disputes: await tx.modPayoutsDispute.findMany({
        where: { tenantId, saleId },
        select: { outcome: true },
      }),
      refunds: await tx.modPayoutsRefund.findMany({
        where: { tenantId, saleId, reversalStatus: { not: null } },
        select: { amount: true },
      }),
    }));
    if (charge.disputed === true) {
      if (recorded.disputes.length === 0 || recorded.disputes.some((d) => d.outcome === null)) {
        return SALE_HOLD_REASONS.chargeDisputed;
      }
    }
    const accounted = recorded.refunds.reduce((total, row) => total + row.amount, 0);
    if (refunded > accounted) return SALE_HOLD_REASONS.chargeRefunded;
    return null;
  }

  private loadAccount(tenantId: string, accountId: string): Promise<AccountRow | null> {
    return this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsAccount.findFirst({ where: { id: accountId, tenantId } }),
    );
  }

  private alert(alert: string, obj: Record<string, unknown>, msg: string): void {
    const log = this.logger.error ?? this.logger.warn;
    log.call(this.logger, { alert, ...obj }, `${alert}: ${msg}`);
  }
}

function describeError(err: unknown): string {
  if (err instanceof PlatformStripeApiError)
    return `${err.operation}: ${err.detail ?? err.message}`;
  return err instanceof Error ? err.message : String(err);
}
