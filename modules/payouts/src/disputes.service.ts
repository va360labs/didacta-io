/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PrismaClient } from '@didacta/database';
import type { PayoutsDbPort, PayoutsLogger, PayoutsTx } from './accounts.service.js';
import { DISPUTE_WON_FEE_DEBT_PART, createDebt, netAgainstPendingSale } from './debts.service.js';
import { PlatformStripeApiError } from './errors.js';
import { idOf } from './event-router.js';
import { IDEMPOTENCY_KEYS, LedgerService, type LedgerEntryInput } from './ledger.service.js';
import {
  DEFAULT_LOSS_POLICY,
  PAYOUTS_LOSS_ALERTS,
  SILENT_NOTIFIER,
  debtLockKey,
  reverseTransfer,
  saleLockKey,
  saleTransferInFlight,
  type PayoutsLossPolicy,
  type PayoutsNotifier,
  type ReversalResult,
} from './losses.js';
import { normalizeCurrency, sharesOfGross } from './money.js';
import { RefsService } from './refs.service.js';
import type { PlatformStripeClient } from './stripe/platform-stripe.client.js';

/**
 * Disputas (contracargos) sobre ventas cobradas por la plataforma (etapa E6).
 *
 * Todo evento de disputa (`charge.dispute.*`) acaba en `sync`, que RELEE la
 * disputa de la API y lleva nuestro estado hasta el de Stripe. Así da igual
 * el orden en que lleguen los eventos o que se pierda alguno: el conciliador
 * vuelve a llamar a `sync` con las disputas abiertas.
 *
 * | Paso | Cuándo | Qué se anota |
 * |---|---|---|
 * | Alta | la disputa existe | fila, aviso al creador con la fecha límite; sin dinero |
 * | Retirada | `balance_transactions` con importe negativo | `DISPUTE_WITHDRAWN` (−importe real), `DISPUTE_FEE` (−tasa real), `PLATFORM_FEE_REFUND` (+5 % en proporción), `TRANSFER_REVERSAL` (+lo revertido al creador), `ADJUSTMENT` provisional (+tasa y comisión de la tarjeta, que adelanta el operador hasta que se decida) y deuda `DISPUTE` por lo que no se pudo revertir |
 * | Ganada | `balance_transactions` con importe positivo | `DISPUTE_REINSTATED`, tasa devuelta, el 5 % otra vez, se deshace el provisional, `TRANSFER` nueva al creador por lo que se le quitó, se cancela su deuda `DISPUTE` y la tasa que Stripe NO devuelve pasa a deuda `DISPUTE_FEE` del creador (`disputeWonFeeBearer = creator`, por defecto) o la asume el operador (`platform`, `ADJUSTMENT` y alerta) |
 * | Perdida | `status = lost` | se deshace el provisional y nace la deuda `DISPUTE_FEE` (tasa + comisión de la tarjeta): la repercusión |
 *
 * Cada paso suma 0 en el libro. La deuda `DISPUTE` de una disputa abierta no
 * se cobra (`frozenDisputeSaleIds`): si se gana, se cancela sin devolver nada.
 *
 * Tarjeta US, 100 €: comisión 3,40, transferidos 91,60. Retirada: −10000,
 * −2000, +500, +9160 revertidos, +2340 provisional. Perdida: −2340 provisional
 * y deuda de 2340 (20 € de tasa + 3,40 de comisión).
 */

export type DisputeSyncOutcome =
  | { readonly outcome: 'no_sale'; readonly disputeId: string }
  | {
      readonly outcome: 'synced';
      readonly disputeId: string;
      readonly status: string;
      readonly steps: readonly string[];
    };

export interface DisputeView {
  readonly id: string;
  readonly saleId: string;
  readonly saleDescription: string | null;
  readonly status: string;
  readonly amount: number;
  readonly currency: string;
  readonly reason: string | null;
  readonly evidenceDueBy: string | null;
}

export interface DisputesServiceOptions {
  readonly policy?: PayoutsLossPolicy;
  readonly notifier?: PayoutsNotifier;
  readonly logger?: PayoutsLogger;
  readonly now?: () => Date;
  readonly leaseMs?: number;
  readonly onSaleChanged?: (tenantId: string, saleId: string) => Promise<unknown>;
}

interface BalanceTransactionFromApi {
  readonly id?: string;
  readonly amount?: number;
  readonly fee?: number;
  readonly currency?: string;
  readonly created?: number;
}

interface DisputeFromApi {
  readonly id: string;
  readonly status?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly reason?: string | null;
  readonly charge?: unknown;
  readonly livemode?: boolean;
  readonly evidence_details?: { readonly due_by?: number | null } | null;
  readonly balance_transactions?: BalanceTransactionFromApi[] | null;
}

type SaleRow = Awaited<ReturnType<PayoutsTx['modPayoutsSale']['findFirstOrThrow']>>;
type DisputeRow = Awaited<ReturnType<PayoutsTx['modPayoutsDispute']['findFirstOrThrow']>>;

const SILENT_LOGGER: PayoutsLogger = { warn: () => undefined };
const DEFAULT_LEASE_MS = 5 * 60_000;
/** Estados de Stripe en los que la disputa ya está decidida a favor del operador. */
const WON_WITHOUT_MONEY = new Set(['won', 'warning_closed']);

export class PayoutsDisputesService {
  private readonly policy: PayoutsLossPolicy;
  private readonly notifier: PayoutsNotifier;
  private readonly logger: PayoutsLogger;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly onSaleChanged?: (tenantId: string, saleId: string) => Promise<unknown>;

  constructor(
    private readonly db: PayoutsDbPort,
    private readonly stripe: PlatformStripeClient,
    options: DisputesServiceOptions = {},
  ) {
    this.policy = options.policy ?? DEFAULT_LOSS_POLICY;
    this.notifier = options.notifier ?? SILENT_NOTIFIER;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.onSaleChanged = options.onSaleChanged;
  }

  /** Disputas abiertas (sin resultado) del tenant, para los avisos del panel. */
  async listOpen(tenantId: string): Promise<DisputeView[]> {
    return this.db.inTenant(tenantId, async (tx) => {
      const rows = await tx.modPayoutsDispute.findMany({
        where: { tenantId, outcome: null },
        orderBy: [{ evidenceDueBy: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      });
      const sales = rows.length
        ? await tx.modPayoutsSale.findMany({
            where: { tenantId, id: { in: rows.map((r) => r.saleId) } },
            select: { id: true, description: true },
          })
        : [];
      const description = new Map(sales.map((s) => [s.id, s.description]));
      return rows.map((row) => ({
        id: row.id,
        saleId: row.saleId,
        saleDescription: description.get(row.saleId) ?? null,
        status: row.status,
        amount: row.amount,
        currency: row.currency,
        reason: row.reason,
        evidenceDueBy: row.evidenceDueBy?.toISOString() ?? null,
      }));
    });
  }

  /** Disputas sin resultado de TODAS las aulas (acceso sancionado, conciliador). */
  async listUnresolved(limit = 200): Promise<Array<{ tenantId: string; stripeDisputeId: string }>> {
    return this.db.global((tx) =>
      tx.modPayoutsDispute.findMany({
        where: { outcome: null },
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: { tenantId: true, stripeDisputeId: true },
      }),
    );
  }

  /**
   * Todas las disputas de un cargo (`GET /v1/disputes?charge=`): lo que hace la
   * venta al anotarse retenida por disputa, por si los eventos llegaron antes.
   */
  async syncCharge(tenantId: string, chargeId: string): Promise<DisputeSyncOutcome[]> {
    const list = await this.stripe.v1<{ data?: Array<{ id?: unknown }> }>('GET', '/v1/disputes', {
      charge: chargeId,
      limit: 10,
    });
    const out: DisputeSyncOutcome[] = [];
    for (const item of list.data ?? []) {
      const id = idOf(item.id);
      if (id) out.push(await this.sync(tenantId, id));
    }
    return out;
  }

  /**
   * Lleva la disputa a lo que dice Stripe. Idempotente: cada paso tiene su
   * sello (la clave de su primer asiento o el `outcome` de la fila).
   */
  async sync(tenantId: string, disputeId: string): Promise<DisputeSyncOutcome> {
    const dispute = await this.stripe.v1<DisputeFromApi>(
      'GET',
      `/v1/disputes/${encodeURIComponent(disputeId)}`,
      { expand: ['balance_transactions'] },
    );
    const chargeId = idOf(dispute.charge);
    const loaded = await this.db.inTenant(tenantId, async (tx) => {
      const sale = chargeId
        ? await tx.modPayoutsSale.findFirst({ where: { tenantId, stripeChargeId: chargeId } })
        : null;
      if (!sale) return null;
      const account = await tx.modPayoutsAccount.findFirst({
        where: { id: sale.accountId, tenantId },
        select: { stripeAccountId: true },
      });
      return { sale, stripeAccountId: account?.stripeAccountId ?? null };
    });
    if (!loaded) {
      // Lo normal: con algunas tarjetas Stripe abre la disputa ANTES de que
      // llegue el `checkout.session.completed` que anota la venta (visto en el
      // sandbox con la tarjeta de disputa). No es un fallo: quien llama deja el
      // evento pendiente y se reintenta (y la venta, al anotarse, la pone al
      // día con `syncCharge`). Si la venta no llega nunca, lo avisa el
      // conciliador como cobro sin venta.
      this.logger.warn(
        { tenantId, disputeId, chargeId },
        'payouts.dispute: la venta del cargo aún no está anotada (se reintenta)',
      );
      return { outcome: 'no_sale', disputeId };
    }
    const { sale } = loaded;
    const status = dispute.status ?? 'needs_response';
    const steps: string[] = [];

    // 1. Fila.
    const { row, created } = await this.upsertRow(tenantId, sale, dispute, status);
    if (created) {
      steps.push('opened');
      await this.notifier
        .disputeOpened({
          tenantId,
          saleId: sale.id,
          description: sale.description,
          amount: row.amount,
          currency: row.currency,
          evidenceDueBy: row.evidenceDueBy,
        })
        .catch(() => undefined);
      await this.alert(PAYOUTS_LOSS_ALERTS.disputeOpened, {
        tenantId,
        saleId: sale.id,
        disputeId,
        amount: row.amount,
        currency: row.currency,
        reason: row.reason,
        evidenceDueBy: row.evidenceDueBy?.toISOString() ?? null,
        detail: 'responder en el panel de Stripe antes de la fecha límite',
      });
    }
    if (row.outcome !== null) return { outcome: 'synced', disputeId, status, steps };

    const bts = dispute.balance_transactions ?? [];
    const withdrawals = bts.filter((bt) => (bt.amount ?? 0) < 0);
    const reinstatements = bts.filter((bt) => (bt.amount ?? 0) > 0);

    // 2. Retirada de fondos.
    let withdrawn = await this.entryExists(
      tenantId,
      IDEMPOTENCY_KEYS.disputeEntry(row.id, 'withdrawn'),
    );
    if (withdrawals.length > 0 && !withdrawn) {
      const result = await this.accountWithdrawal(
        tenantId,
        row,
        withdrawals,
        loaded.stripeAccountId,
      );
      steps.push(`withdrawn:${result}`);
      withdrawn = result === 'accounted';
    }

    // 3. Ganada con dinero devuelto.
    if (withdrawn && reinstatements.length > 0) {
      const result = await this.accountReinstatement(
        tenantId,
        row,
        reinstatements,
        loaded.stripeAccountId,
      );
      steps.push(`reinstated:${result}`);
    } else if (withdrawn && status === 'lost') {
      // 4. Perdida: repercusión.
      const result = await this.accountLoss(tenantId, row);
      steps.push(`lost:${result}`);
    } else if (!withdrawn && withdrawals.length === 0) {
      // Decidida sin que se llegara a mover dinero (consulta previa, o ganada antes).
      if (WON_WITHOUT_MONEY.has(status) || status === 'lost') {
        await this.db.inTenant(tenantId, (tx) =>
          tx.modPayoutsDispute.updateMany({
            where: { id: row.id, tenantId, outcome: null },
            data: { outcome: status === 'lost' ? 'lost' : 'won' },
          }),
        );
        steps.push(`closed_without_funds:${status}`);
        await this.onSaleChanged?.(tenantId, sale.id).catch(() => undefined);
      }
    }
    return { outcome: 'synced', disputeId, status, steps };
  }

  // ── Alta ───────────────────────────────────────────────────────────────

  private async upsertRow(
    tenantId: string,
    sale: SaleRow,
    dispute: DisputeFromApi,
    status: string,
  ): Promise<{ row: DisputeRow; created: boolean }> {
    const dueBy =
      typeof dispute.evidence_details?.due_by === 'number'
        ? new Date(dispute.evidence_details.due_by * 1000)
        : null;
    const disputeCurrency = (dispute.currency ?? '').toLowerCase();
    // Importe en la divisa de liquidación: hasta la retirada solo se estima.
    const estimate =
      sale.currency && disputeCurrency === sale.currency && Number.isInteger(dispute.amount)
        ? dispute.amount!
        : (sale.gross ?? dispute.amount ?? 0);
    return this.db.inTenant(tenantId, async (tx) => {
      const existing = await tx.modPayoutsDispute.findFirst({
        where: { tenantId, stripeDisputeId: dispute.id },
      });
      if (existing) {
        if (
          existing.status !== status ||
          (existing.evidenceDueBy?.getTime() ?? null) !== (dueBy?.getTime() ?? null)
        ) {
          await tx.modPayoutsDispute.updateMany({
            where: { id: existing.id, tenantId },
            data: { status, evidenceDueBy: dueBy },
          });
        }
        return {
          row: await tx.modPayoutsDispute.findFirstOrThrow({
            where: { id: existing.id, tenantId },
          }),
          created: false,
        };
      }
      const { count } = await tx.modPayoutsDispute.createMany({
        data: [
          {
            tenantId,
            saleId: sale.id,
            stripeDisputeId: dispute.id,
            status,
            amount: estimate,
            currency: sale.currency ?? disputeCurrency,
            reason: dispute.reason ?? null,
            evidenceDueBy: dueBy,
          },
        ],
        skipDuplicates: true,
      });
      await new RefsService(tx as unknown as PrismaClient).register({
        tenantId,
        stripeObjectId: dispute.id,
        kind: 'dispute',
        source: 'payouts',
        localRef: sale.id,
        parentObjectId: sale.stripeChargeId,
        livemode: dispute.livemode === true,
      });
      return {
        row: await tx.modPayoutsDispute.findFirstOrThrow({
          where: { tenantId, stripeDisputeId: dispute.id },
        }),
        created: count === 1,
      };
    });
  }

  // ── Retirada ───────────────────────────────────────────────────────────

  private async accountWithdrawal(
    tenantId: string,
    row: DisputeRow,
    withdrawals: BalanceTransactionFromApi[],
    stripeAccountId: string | null,
  ): Promise<'accounted' | 'awaiting_split' | 'busy' | 'mismatch'> {
    const sale = await this.loadSale(tenantId, row.saleId);
    if (sale.transferAmount === null || sale.gross === null || sale.currency === null) {
      return 'awaiting_split';
    }
    const currency = sale.currency;
    if (withdrawals.some((bt) => normalizeCurrency(bt.currency) !== currency)) {
      await this.alert(PAYOUTS_LOSS_ALERTS.disputeMismatch, {
        tenantId,
        saleId: sale.id,
        disputeId: row.stripeDisputeId,
        detail: `la retirada no va en la divisa de la venta (${currency})`,
      });
      return 'mismatch';
    }
    const disputed = -withdrawals.reduce((total, bt) => total + (bt.amount ?? 0), 0);
    const fee = withdrawals.reduce((total, bt) => total + Math.max(0, bt.fee ?? 0), 0);
    const transferred = sale.status === 'TRANSFERRED' && sale.stripeTransferId !== null;
    if (!transferred && saleTransferInFlight(sale, this.now(), this.leaseMs)) return 'busy';

    const effective = Math.min(disputed, sale.gross - sale.refundedAmount);
    const shares = sharesOfGross(settled(sale), sale.refundedAmount, effective);
    const target = transferred
      ? Math.max(0, Math.min(shares.creator, (sale.transferAmount ?? 0) - sale.reversedAmount))
      : 0;

    let reversal: ReversalResult = { reversed: 0, reversalId: null, status: 'DONE', detail: null };
    if (target > 0 && stripeAccountId) {
      reversal = await reverseTransfer(this.stripe, {
        transferId: sale.stripeTransferId!,
        stripeAccountId,
        currency,
        target,
        idempotencyKey: IDEMPOTENCY_KEYS.disputeReversal(row.stripeDisputeId),
        metadata: {
          didacta_dispute_id: row.stripeDisputeId,
          didacta_sale_id: sale.id,
          didacta_tenant_id: tenantId,
        },
        metaKey: 'didacta_dispute_id',
        description: 'Didacta: el alumno reclamó el pago a su banco',
      });
    }

    const platformReturned = this.policy.refundPlatformFee ? shares.platform : 0;
    const platformKept = shares.platform - platformReturned;
    // Lo que el operador ADELANTA hasta que se decida: la tasa, la comisión de
    // la tarjeta, su 5 % si no lo devuelve y lo que exceda del bruto.
    const provisional = fee + shares.stripe + platformKept + (disputed - effective);
    const occurredAt = this.now();
    const btId = idOf(withdrawals[0]?.id);

    const written = await this.db
      .inTenant(tenantId, async (tx) => {
        await lock(tx, debtLockKey(sale.accountId, currency));
        await lock(tx, saleLockKey(sale.id));
        if (await entryExistsTx(tx, IDEMPOTENCY_KEYS.disputeEntry(row.id, 'withdrawn')))
          return null;
        const s = await tx.modPayoutsSale.findFirstOrThrow({ where: { id: sale.id, tenantId } });
        if (!transferred && s.stripeTransferId !== null) throw new DisputeBusyError();
        const reversed = Math.min(reversal.reversed, shares.creator);
        const base = { tenantId, accountId: s.accountId, saleId: s.id, currency, occurredAt };
        const entries: LedgerEntryInput[] = [
          {
            ...base,
            type: 'DISPUTE_WITHDRAWN',
            amount: -disputed,
            stripeObjectId: row.stripeDisputeId,
            stripeBalanceTransactionId: btId,
            idempotencyKey: IDEMPOTENCY_KEYS.disputeEntry(row.id, 'withdrawn'),
            metadata: { disputeId: row.stripeDisputeId },
          },
        ];
        if (fee > 0) {
          entries.push({
            ...base,
            type: 'DISPUTE_FEE',
            amount: -fee,
            stripeObjectId: row.stripeDisputeId,
            stripeBalanceTransactionId: btId,
            idempotencyKey: IDEMPOTENCY_KEYS.disputeEntry(row.id, 'fee'),
            metadata: { disputeId: row.stripeDisputeId },
          });
        }
        if (platformReturned > 0) {
          entries.push({
            ...base,
            type: 'PLATFORM_FEE_REFUND',
            amount: platformReturned,
            idempotencyKey: IDEMPOTENCY_KEYS.disputeEntry(row.id, 'platform-fee'),
            metadata: { disputeId: row.stripeDisputeId },
          });
        }
        if (reversed > 0) {
          entries.push({
            ...base,
            type: 'TRANSFER_REVERSAL',
            amount: reversed,
            stripeObjectId: reversal.reversalId,
            idempotencyKey: IDEMPOTENCY_KEYS.disputeReversal(row.stripeDisputeId),
            metadata: { disputeId: row.stripeDisputeId, transferId: s.stripeTransferId },
          });
        }
        if (provisional > 0) {
          entries.push({
            ...base,
            type: 'ADJUSTMENT',
            amount: provisional,
            idempotencyKey: IDEMPOTENCY_KEYS.disputeEntry(row.id, 'provisional'),
            metadata: {
              disputeId: row.stripeDisputeId,
              cause: 'dispute_costs_advanced_by_platform',
              disputeFee: fee,
              cardFee: shares.stripe,
              platformFeeKept: platformKept,
            },
          });
        }
        await new LedgerService(tx as unknown as PrismaClient).appendMany(entries);

        const shortfall = shares.creator - reversed;
        let netted = 0;
        if (shortfall > 0) {
          const { debtId } = await createDebt(tx, {
            ...base,
            reason: 'DISPUTE',
            amount: shortfall,
            originSaleId: s.id,
            idempotencyKey: IDEMPOTENCY_KEYS.disputeEntry(row.id, 'debt'),
            stripeObjectId: row.stripeDisputeId,
            metadata: {
              disputeId: row.stripeDisputeId,
              cause: transferred ? 'reversal_shortfall' : 'dispute_before_transfer',
              detail: reversal.detail,
            },
          });
          if (
            !transferred &&
            s.stripeTransferId === null &&
            (s.status === 'READY' || s.status === 'HELD') &&
            (s.transferAmount ?? 0) > 0
          ) {
            if (saleTransferInFlight(s, occurredAt, this.leaseMs)) throw new DisputeBusyError();
            const taken = await netAgainstPendingSale(tx, {
              tenantId,
              saleId: s.id,
              expected: {
                transferAmount: s.transferAmount!,
                debtNetted: s.debtNetted,
                status: s.status,
                nextAttemptAt: s.nextAttemptAt,
              },
              debtIds: [debtId],
              currency,
              accountId: s.accountId,
              occurredAt,
              nextAttemptAt: occurredAt,
            });
            netted = taken.get(debtId) ?? 0;
          }
        }
        if (reversed > 0) {
          await tx.modPayoutsSale.updateMany({
            where: { id: s.id, tenantId },
            data: { reversedAmount: s.reversedAmount + reversed },
          });
        }
        await tx.modPayoutsDispute.updateMany({
          where: { id: row.id, tenantId },
          data: {
            amount: disputed,
            currency,
            fee,
            ...(reversal.reversalId ? { stripeReversalId: reversal.reversalId } : {}),
          },
        });
        return { reversed, shortfall, netted };
      })
      .catch((err: unknown) => {
        if (err instanceof DisputeBusyError) return 'busy' as const;
        throw err;
      });

    if (written === 'busy') return 'busy';
    if (written && transferred && written.shortfall > 0) {
      await this.alert(PAYOUTS_LOSS_ALERTS.reversalShortfall, {
        tenantId,
        saleId: sale.id,
        disputeId: row.stripeDisputeId,
        target,
        reversed: written.reversed,
        currency,
        detail: reversal.detail,
      });
    }
    this.logger.log?.(
      {
        tenantId,
        saleId: sale.id,
        disputeId: row.stripeDisputeId,
        disputed,
        fee,
        reversed: reversal.reversed,
      },
      'payouts.dispute: retirada de fondos anotada',
    );
    return 'accounted';
  }

  // ── Ganada ─────────────────────────────────────────────────────────────

  private async accountReinstatement(
    tenantId: string,
    row: DisputeRow,
    reinstatements: BalanceTransactionFromApi[],
    stripeAccountId: string | null,
  ): Promise<'accounted' | 'already' | 'transfer_failed'> {
    if (await this.entryExists(tenantId, IDEMPOTENCY_KEYS.disputeEntry(row.id, 'reinstated'))) {
      return 'already';
    }
    const sale = await this.loadSale(tenantId, row.saleId);
    const currency = sale.currency!;
    const back = reinstatements.reduce((total, bt) => total + (bt.amount ?? 0), 0);
    const feeBack = Math.max(0, -reinstatements.reduce((total, bt) => total + (bt.fee ?? 0), 0));
    const previous = await this.withdrawalEntries(tenantId, row.id, row.stripeDisputeId);
    const debt = previous.debtId
      ? await this.db.inTenant(tenantId, (tx) =>
          tx.modPayoutsDebt.findFirst({ where: { id: previous.debtId!, tenantId } }),
        )
      : null;
    const recoveredFromDebt = debt ? debt.amountOriginal - debt.amountOutstanding : 0;
    const owed = previous.reversed + recoveredFromDebt;

    // Transferencia nueva al creador por lo que se le quitó.
    let transfer: { id: string; amount: number } | null = null;
    if (owed > 0) {
      if (!stripeAccountId) return 'transfer_failed';
      try {
        transfer = await this.reinstatementTransfer(
          tenantId,
          sale,
          row,
          owed,
          currency,
          stripeAccountId,
        );
      } catch (err) {
        if (!(err instanceof PlatformStripeApiError) || err.retryable) throw err;
        await this.alert(PAYOUTS_LOSS_ALERTS.disputeReinstatementFailed, {
          tenantId,
          saleId: sale.id,
          disputeId: row.stripeDisputeId,
          amount: owed,
          currency,
          detail: `${err.stripeCode ?? err.status}: ${err.detail ?? err.message} (se reintenta en el conciliador)`,
        });
        return 'transfer_failed';
      }
    }

    const occurredAt = this.now();
    const written = await this.db.inTenant(tenantId, async (tx) => {
      await lock(tx, debtLockKey(sale.accountId, currency));
      await lock(tx, saleLockKey(sale.id));
      if (await entryExistsTx(tx, IDEMPOTENCY_KEYS.disputeEntry(row.id, 'reinstated'))) return null;
      const base = { tenantId, accountId: sale.accountId, saleId: sale.id, currency, occurredAt };
      const entries: LedgerEntryInput[] = [
        {
          ...base,
          type: 'DISPUTE_REINSTATED',
          amount: back,
          stripeObjectId: row.stripeDisputeId,
          stripeBalanceTransactionId: idOf(reinstatements[0]?.id),
          idempotencyKey: IDEMPOTENCY_KEYS.disputeEntry(row.id, 'reinstated'),
          metadata: { disputeId: row.stripeDisputeId },
        },
      ];
      if (feeBack > 0) {
        entries.push({
          ...base,
          type: 'DISPUTE_FEE',
          amount: feeBack,
          stripeObjectId: row.stripeDisputeId,
          idempotencyKey: IDEMPOTENCY_KEYS.disputeEntry(row.id, 'fee-returned'),
          metadata: { disputeId: row.stripeDisputeId },
        });
      }
      if (previous.platformReturned > 0) {
        entries.push({
          ...base,
          type: 'PLATFORM_FEE',
          amount: -previous.platformReturned,
          idempotencyKey: IDEMPOTENCY_KEYS.disputeEntry(row.id, 'platform-fee-again'),
          metadata: { disputeId: row.stripeDisputeId },
        });
      }
      if (previous.provisional > 0) {
        entries.push({
          ...base,
          type: 'ADJUSTMENT',
          amount: -previous.provisional,
          idempotencyKey: IDEMPOTENCY_KEYS.disputeEntry(row.id, 'provisional-undo'),
          metadata: { disputeId: row.stripeDisputeId, cause: 'dispute_won' },
        });
      }
      if (transfer) {
        entries.push({
          ...base,
          type: 'TRANSFER',
          amount: -transfer.amount,
          stripeObjectId: transfer.id,
          idempotencyKey: IDEMPOTENCY_KEYS.disputeReinstatement(row.stripeDisputeId),
          metadata: { disputeId: row.stripeDisputeId, destination: stripeAccountId },
        });
      }
      if (debt) {
        const fresh = await tx.modPayoutsDebt.findFirstOrThrow({
          where: { id: debt.id, tenantId },
        });
        if (fresh.amountOutstanding !== debt.amountOutstanding) {
          // Congelada: no debería moverse. Si se movió, mejor no anotar a ciegas.
          throw new Error(`la deuda ${debt.id} de la disputa cambió mientras se resolvía`);
        }
        if (fresh.status === 'OPEN' && fresh.amountOutstanding > 0) {
          await tx.modPayoutsDebt.update({
            where: { id: debt.id },
            data: { amountOutstanding: 0, status: 'WRITTEN_OFF' },
          });
          entries.push({
            ...base,
            type: 'DEBT_RECOVERED',
            amount: -fresh.amountOutstanding,
            idempotencyKey: IDEMPOTENCY_KEYS.disputeEntry(row.id, 'debt-cancel'),
            metadata: { disputeId: row.stripeDisputeId, debtId: debt.id, via: 'dispute_won' },
          });
        }
      }
      // Lo que no cuadra: la tasa que Stripe no devolvió y, si la hubiera, una
      // diferencia de importe. La tasa la paga el creador (deuda `DISPUTE_FEE`)
      // si así lo dice la política; el resto lo asume el operador, con su
      // asiento y su alerta. La deuda es SOLO la tasa no devuelta: lo revertido
      // o retenido al creador ya vuelve entero con la transferencia de arriba y
      // la cancelación de su deuda `DISPUTE`, así que nada se cuenta dos veces.
      const plug = -entries.reduce((total, entry) => total + entry.amount, 0);
      const unreturnedFee = Math.max(0, previous.fee - feeBack);
      const feeCharged =
        this.policy.disputeWonFeeBearer === 'creator'
          ? Math.max(0, Math.min(unreturnedFee, plug))
          : 0;
      if (feeCharged > 0) {
        await createDebt(tx, {
          ...base,
          reason: 'DISPUTE_FEE',
          amount: feeCharged,
          originSaleId: sale.id,
          idempotencyKey: IDEMPOTENCY_KEYS.disputeEntry(row.id, DISPUTE_WON_FEE_DEBT_PART),
          stripeObjectId: row.stripeDisputeId,
          metadata: { disputeId: row.stripeDisputeId, cause: 'dispute_won_fee_not_returned' },
        });
      }
      const absorbed = plug - feeCharged;
      if (absorbed !== 0) {
        entries.push({
          ...base,
          type: 'ADJUSTMENT',
          amount: absorbed,
          idempotencyKey: IDEMPOTENCY_KEYS.disputeEntry(row.id, 'won-cost'),
          metadata: {
            disputeId: row.stripeDisputeId,
            cause: 'dispute_won_cost_absorbed_by_platform',
          },
        });
      }
      await new LedgerService(tx as unknown as PrismaClient).appendMany(entries);
      if (transfer) {
        await new RefsService(tx as unknown as PrismaClient).register({
          tenantId,
          stripeObjectId: transfer.id,
          kind: 'transfer',
          source: 'payouts',
          localRef: sale.id,
          parentObjectId: sale.stripeChargeId,
          livemode: false,
        });
      }
      await tx.modPayoutsDispute.updateMany({
        where: { id: row.id, tenantId },
        data: { outcome: 'won', status: 'won' },
      });
      return { absorbed, feeCharged };
    });
    if (written && written.absorbed !== 0) {
      await this.alert(PAYOUTS_LOSS_ALERTS.platformAbsorbed, {
        tenantId,
        saleId: sale.id,
        disputeId: row.stripeDisputeId,
        amount: written.absorbed,
        currency,
        detail: 'disputa ganada: coste que no devolvió Stripe, asumido por la plataforma',
      });
    }
    if (written && written.feeCharged > 0) {
      await this.notifier
        .debtCharged({
          tenantId,
          saleId: sale.id,
          description: sale.description,
          amount: written.feeCharged,
          currency,
          cause: 'dispute_won',
        })
        .catch(() => undefined);
      this.logger.log?.(
        { tenantId, saleId: sale.id, disputeId: row.stripeDisputeId, fee: written.feeCharged },
        'payouts.dispute: disputa ganada; la tasa no devuelta pasa a deuda del creador',
      );
    }
    await this.onSaleChanged?.(tenantId, sale.id).catch(() => undefined);
    return written ? 'accounted' : 'already';
  }

  /** La transferencia de una disputa ganada, adoptando la que ya exista. */
  private async reinstatementTransfer(
    tenantId: string,
    sale: SaleRow,
    row: DisputeRow,
    amount: number,
    currency: string,
    destination: string,
  ): Promise<{ id: string; amount: number }> {
    const transferGroup = `didacta_dispute_${row.stripeDisputeId}`;
    const list = await this.stripe.v1<{
      data?: Array<{ id: string; amount?: number; metadata?: Record<string, unknown> | null }>;
    }>('GET', '/v1/transfers', { transfer_group: transferGroup, destination, limit: 100 });
    const existing = (list.data ?? []).find(
      (t) => t.metadata?.['didacta_dispute_id'] === row.stripeDisputeId,
    );
    if (existing) return { id: existing.id, amount: existing.amount ?? amount };
    const created = await this.stripe.v1<{ id: string; amount?: number }>(
      'POST',
      '/v1/transfers',
      {
        amount,
        currency,
        destination,
        transfer_group: transferGroup,
        description: 'Didacta: disputa ganada, te devolvemos lo retenido',
        metadata: {
          didacta_sale_id: sale.id,
          didacta_dispute_id: row.stripeDisputeId,
          didacta_tenant_id: tenantId,
        },
      },
      { idempotencyKey: IDEMPOTENCY_KEYS.disputeReinstatement(row.stripeDisputeId) },
    );
    return { id: created.id, amount: created.amount ?? amount };
  }

  // ── Perdida ────────────────────────────────────────────────────────────

  private async accountLoss(tenantId: string, row: DisputeRow): Promise<'accounted' | 'already'> {
    const previous = await this.withdrawalEntries(tenantId, row.id, row.stripeDisputeId);
    const occurredAt = this.now();
    const written = await this.db.inTenant(tenantId, async (tx) => {
      const sale = await tx.modPayoutsSale.findFirstOrThrow({
        where: { id: row.saleId, tenantId },
      });
      const currency = sale.currency!;
      await lock(tx, debtLockKey(sale.accountId, currency));
      await lock(tx, saleLockKey(sale.id));
      const { count } = await tx.modPayoutsDispute.updateMany({
        where: { id: row.id, tenantId, outcome: null },
        data: { outcome: 'lost', status: 'lost' },
      });
      if (count !== 1) return null;
      const base = { tenantId, accountId: sale.accountId, saleId: sale.id, currency, occurredAt };
      let charged = 0;
      if (this.policy.disputeLossBearer === 'creator' && previous.provisional > 0) {
        await new LedgerService(tx as unknown as PrismaClient).append({
          ...base,
          type: 'ADJUSTMENT',
          amount: -previous.provisional,
          idempotencyKey: IDEMPOTENCY_KEYS.disputeEntry(row.id, 'provisional-undo'),
          metadata: { disputeId: row.stripeDisputeId, cause: 'dispute_lost' },
        });
        const { debtId } = await createDebt(tx, {
          ...base,
          reason: 'DISPUTE_FEE',
          amount: previous.provisional,
          originSaleId: sale.id,
          idempotencyKey: IDEMPOTENCY_KEYS.disputeEntry(row.id, 'debt-loss'),
          stripeObjectId: row.stripeDisputeId,
          metadata: { disputeId: row.stripeDisputeId },
        });
        charged = previous.provisional;
        // Si la venta aún tenía transferencia pendiente, paga primero ella.
        if (
          sale.stripeTransferId === null &&
          (sale.status === 'READY' || sale.status === 'HELD') &&
          (sale.transferAmount ?? 0) > 0 &&
          !saleTransferInFlight(sale, occurredAt, this.leaseMs)
        ) {
          const taken = await netAgainstPendingSale(tx, {
            tenantId,
            saleId: sale.id,
            expected: {
              transferAmount: sale.transferAmount!,
              debtNetted: sale.debtNetted,
              status: sale.status,
              nextAttemptAt: sale.nextAttemptAt,
            },
            debtIds: [debtId],
            currency,
            accountId: sale.accountId,
            occurredAt,
            nextAttemptAt: occurredAt,
          });
          charged -= taken.get(debtId) ?? 0;
        }
      }
      // Lo que ya se debía de esta disputa (retirada sin poder revertir) se
      // empieza a cobrar ahora: deja de estar congelado.
      const frozenDebt = previous.debtId
        ? await tx.modPayoutsDebt.findFirst({
            where: { id: previous.debtId, tenantId, status: 'OPEN' },
          })
        : null;
      return {
        sale,
        currency,
        totalOpen: charged + (frozenDebt?.amountOutstanding ?? 0),
      };
    });
    if (!written) return 'already';
    if (written.totalOpen > 0) {
      await this.notifier
        .debtCharged({
          tenantId,
          saleId: written.sale.id,
          description: written.sale.description,
          amount: written.totalOpen,
          currency: written.currency,
          cause: 'dispute_lost',
        })
        .catch(() => undefined);
    }
    this.logger.log?.(
      {
        tenantId,
        saleId: written.sale.id,
        disputeId: row.stripeDisputeId,
        charged: written.totalOpen,
      },
      'payouts.dispute: disputa perdida; repercusión anotada',
    );
    await this.onSaleChanged?.(tenantId, written.sale.id).catch(() => undefined);
    return 'accounted';
  }

  // ── Utilidades ─────────────────────────────────────────────────────────

  /** Lo que dejó anotado la retirada (lo revertido, el provisional, la deuda…). */
  private async withdrawalEntries(tenantId: string, rowId: string, stripeDisputeId: string) {
    return this.db.inTenant(tenantId, async (tx) => {
      const keys = {
        reversal: IDEMPOTENCY_KEYS.disputeReversal(stripeDisputeId),
        provisional: IDEMPOTENCY_KEYS.disputeEntry(rowId, 'provisional'),
        fee: IDEMPOTENCY_KEYS.disputeEntry(rowId, 'fee'),
        platform: IDEMPOTENCY_KEYS.disputeEntry(rowId, 'platform-fee'),
        debt: IDEMPOTENCY_KEYS.disputeEntry(rowId, 'debt'),
      };
      const rows = await tx.modPayoutsLedgerEntry.findMany({
        where: { tenantId, idempotencyKey: { in: Object.values(keys) } },
        select: { idempotencyKey: true, amount: true, metadata: true },
      });
      const byKey = new Map(rows.map((r) => [r.idempotencyKey, r]));
      const debtMeta = byKey.get(keys.debt)?.metadata as { debtId?: unknown } | undefined;
      return {
        reversed: byKey.get(keys.reversal)?.amount ?? 0,
        provisional: byKey.get(keys.provisional)?.amount ?? 0,
        /** La tasa que Stripe retiró con la disputa (el asiento va en negativo). */
        fee: -(byKey.get(keys.fee)?.amount ?? 0),
        platformReturned: byKey.get(keys.platform)?.amount ?? 0,
        debtId: typeof debtMeta?.debtId === 'string' ? debtMeta.debtId : null,
      };
    });
  }

  private loadSale(tenantId: string, saleId: string): Promise<SaleRow> {
    return this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsSale.findFirstOrThrow({ where: { id: saleId, tenantId } }),
    );
  }

  private entryExists(tenantId: string, key: string): Promise<boolean> {
    return this.db.inTenant(tenantId, (tx) => entryExistsTx(tx, key));
  }

  private async alert(alert: string, detail: Record<string, unknown>): Promise<void> {
    (this.logger.error ?? this.logger.warn).call(this.logger, { alert, ...detail }, `${alert}`);
    await this.notifier.operatorAlert(alert, detail).catch(() => undefined);
  }
}

class DisputeBusyError extends Error {}

async function lock(tx: PayoutsTx, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`;
}

async function entryExistsTx(tx: PayoutsTx, key: string): Promise<boolean> {
  const found = await tx.modPayoutsLedgerEntry.findUnique({
    where: { idempotencyKey: key },
    select: { id: true },
  });
  return found !== null;
}

function settled(sale: SaleRow) {
  return {
    gross: sale.gross!,
    stripeFee: sale.stripeFee!,
    platformFee: sale.platformFee!,
    creatorNet: sale.creatorNet!,
  };
}
