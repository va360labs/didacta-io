/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@didacta/database';
import type { PayoutsDbPort, PayoutsLogger, PayoutsTx } from './accounts.service.js';
import { createDebt, netAgainstPendingSale } from './debts.service.js';
import {
  PayoutsInvalidAmountError,
  PayoutsRefundExceedsRemainingError,
  PayoutsRefundRejectedError,
  PayoutsSaleNotFoundError,
  PayoutsSaleNotRefundableError,
  PlatformStripeApiError,
} from './errors.js';
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
import { chargeToSettlement, sharesOfGross, type GrossShares } from './money.js';
import { RefsService } from './refs.service.js';
import type { PlatformStripeClient } from './stripe/platform-stripe.client.js';

/**
 * Reembolsos de ventas cobradas por la plataforma (etapa E6).
 *
 * Dos puertas, un solo camino de dinero:
 *
 *  - **Desde Didacta** (`refund`, botón «Reembolsar» del creador): fila en
 *    `mod_payouts_refund` ANTES de llamar a Stripe → `POST /v1/refunds` con
 *    `Idempotency-Key: payouts:refund:<id de la fila>` → anotación.
 *  - **A mano en el panel de Stripe** (`syncCharge`, desde `charge.refunded`
 *    y `refund.*`): se listan los reembolsos del cargo en la API; el que no
 *    tiene fila se da de alta y se anota igual.
 *
 * La ANOTACIÓN (`account`) reparte lo devuelto entre los tres bolsillos de la
 * venta (`sharesOfGross`, sobre lo acumulado) y deja un grupo de asientos que
 * suma 0:
 *
 *     REFUND               −devuelto (divisa de liquidación)
 *     PLATFORM_FEE_REFUND  +parte del operador          (si la devuelve)
 *     ADJUSTMENT           +comisión de Stripe          (si la asume el operador)
 *     TRANSFER_REVERSAL    +lo revertido al creador
 *     DEBT_CREATED         +lo que falta → deuda REVERSAL_FAILED / REFUND_FEE
 *
 * Reembolso total de 100 € con 1,75 de Stripe: −10000, +500, +9325 revertido
 * y deuda REFUND_FEE de 175. En la MISMA transacción se suben
 * `refunded_amount` y `reversed_amount` de la venta (si no, el cotejo de
 * `transfer.*` vería la reversión como discrepancia).
 *
 * Si la venta aún no se había transferido, no hay nada que revertir: la parte
 * del creador y lo que asume salen de su transferencia pendiente
 * (`netAgainstPendingSale`), y si se queda en 0 la venta acaba `SETTLED_NETTED`.
 *
 * La retirada del acceso del alumno NO es de aquí: sigue por `charge.refunded`
 * hacia `mod.billing` (reembolso total), como siempre.
 */

export interface RefundPreview {
  readonly saleId: string;
  /** Moneda en la que se devuelve al alumno (la del cargo). */
  readonly chargeCurrency: string;
  /** Lo que aún se puede devolver, en la moneda del cargo. */
  readonly refundable: number;
  /** Lo que se devolvería (lo pedido o, si no se pide nada, todo lo que queda). */
  readonly amount: number;
  /** Divisa de liquidación (en la que cobra el creador). */
  readonly currency: string;
  /** `amount` en la divisa de liquidación. */
  readonly settlementAmount: number;
  /** Parte de lo que el creador recibió (o iba a recibir) por la venta. */
  readonly creatorShare: number;
  /** Comisión de la tarjeta que Stripe no devuelve. */
  readonly cardFee: number;
  /** Cuánto de esa comisión se descuenta al creador (0 si la asume el operador). */
  readonly cardFeeToCreator: number;
  /** Comisión del operador que se devuelve. */
  readonly platformFeeReturned: number;
  /** Comisión del operador que NO se devuelve y paga el creador. */
  readonly platformFeeToCreator: number;
  /** Total que se le descuenta al creador. */
  readonly creatorTotal: number;
  /** ¿Ya se le había enviado el dinero? (se le retira de su saldo o queda como deuda). */
  readonly alreadyPaidOut: boolean;
}

export type RefundAccountingOutcome =
  | {
      readonly outcome: 'accounted';
      readonly refundId: string;
      readonly reversal: ReversalResult;
      readonly debt: number;
    }
  | { readonly outcome: 'already'; readonly refundId: string }
  /** El reembolso aún no está hecho en Stripe (`pending`) o falló. */
  | { readonly outcome: 'not_succeeded'; readonly refundId: string; readonly status: string }
  /** La venta aún no tiene reparto sellado: se anota cuando lo tenga. */
  | { readonly outcome: 'awaiting_split'; readonly refundId: string }
  /** La liquidación está transfiriendo la venta ahora mismo: se reintenta. */
  | { readonly outcome: 'busy'; readonly refundId: string }
  | { readonly outcome: 'not_found'; readonly refundId: string };

export interface RefundResult {
  readonly refundId: string;
  readonly saleId: string;
  readonly stripeRefundId: string | null;
  readonly amount: number;
  readonly currency: string;
  /** Estado literal del reembolso en Stripe. */
  readonly status: string;
  readonly accounting: RefundAccountingOutcome['outcome'] | 'pending';
}

export interface RefundsServiceOptions {
  readonly policy?: PayoutsLossPolicy;
  readonly notifier?: PayoutsNotifier;
  readonly logger?: PayoutsLogger;
  readonly now?: () => Date;
  /** El arriendo de la liquidación (para no tocar una venta que se está transfiriendo). */
  readonly leaseMs?: number;
  /** Tras anotar un reembolso de una venta sin transferir: que siga su camino. */
  readonly onSaleChanged?: (tenantId: string, saleId: string) => Promise<unknown>;
}

interface ChargeFromApi {
  readonly id: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly amount_refunded?: number;
  readonly disputed?: boolean;
}

interface RefundFromApi {
  readonly id: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly status?: string;
  readonly reason?: string | null;
  readonly charge?: unknown;
  readonly created?: number;
  readonly livemode?: boolean;
  readonly metadata?: Record<string, unknown> | null;
  readonly balance_transaction?: unknown;
}

type SaleRow = Awaited<ReturnType<PayoutsTx['modPayoutsSale']['findFirstOrThrow']>>;
type RefundRow = Awaited<ReturnType<PayoutsTx['modPayoutsRefund']['findFirstOrThrow']>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SILENT_LOGGER: PayoutsLogger = { warn: () => undefined };
const DEFAULT_LEASE_MS = 5 * 60_000;
/** Una fila sin `re_` más vieja que esto se completa desde el conciliador. */
const STALE_CREATION_MS = 2 * 60_000;

export class PayoutsRefundsService {
  private readonly policy: PayoutsLossPolicy;
  private readonly notifier: PayoutsNotifier;
  private readonly logger: PayoutsLogger;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly onSaleChanged?: (tenantId: string, saleId: string) => Promise<unknown>;

  constructor(
    private readonly db: PayoutsDbPort,
    private readonly stripe: PlatformStripeClient,
    options: RefundsServiceOptions = {},
  ) {
    this.policy = options.policy ?? DEFAULT_LOSS_POLICY;
    this.notifier = options.notifier ?? SILENT_NOTIFIER;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.onSaleChanged = options.onSaleChanged;
  }

  // ── Desde Didacta ──────────────────────────────────────────────────────

  /**
   * Qué pasaría al devolver `amount` (moneda del cargo; sin él, todo lo que
   * queda). Solo lectura: no llama a nada que mueva dinero.
   */
  async preview(tenantId: string, saleId: string, amount?: number): Promise<RefundPreview> {
    const { sale, accountedBefore } = await this.loadRefundable(tenantId, saleId);
    const charge = await this.readCharge(sale.stripeChargeId);
    this.assertNotDisputed(charge);
    const chargeAmount = this.chargeAmountOf(charge);
    const pendingReserved = await this.reservedAmount(tenantId, saleId);
    const refundable = Math.max(0, chargeAmount - (charge.amount_refunded ?? 0) - pendingReserved);
    if (refundable === 0) throw new PayoutsSaleNotRefundableError('fully_refunded');
    const wanted = amount ?? refundable;
    if (!Number.isInteger(wanted) || wanted <= 0) {
      throw new PayoutsInvalidAmountError(`amount = ${String(amount)}`);
    }
    if (wanted > refundable) throw new PayoutsRefundExceedsRemainingError(wanted, refundable);

    const settlementAmount = chargeToSettlement({
      chargeAmount,
      gross: sale.gross!,
      refundedBefore: Math.min(
        Math.max(accountedBefore, (charge.amount_refunded ?? 0) + pendingReserved),
        chargeAmount - wanted,
      ),
      amount: wanted,
    });
    const shares = sharesOfGross(
      this.settled(sale),
      Math.min(sale.refundedAmount, sale.gross! - settlementAmount),
      settlementAmount,
    );
    const split = this.split(shares);
    return {
      saleId,
      chargeCurrency: (charge.currency ?? sale.presentmentCurrency).toLowerCase(),
      refundable,
      amount: wanted,
      currency: sale.currency!,
      settlementAmount,
      creatorShare: shares.creator,
      cardFee: shares.stripe,
      cardFeeToCreator: split.cardFeeToCreator,
      platformFeeReturned: split.platformFeeReturned,
      platformFeeToCreator: split.platformFeeToCreator,
      creatorTotal: shares.creator + split.cardFeeToCreator + split.platformFeeToCreator,
      alreadyPaidOut: sale.status === 'TRANSFERRED',
    };
  }

  /**
   * Reembolso pedido desde el panel del creador.
   *
   *  - Otra academia: 404 (la RLS no deja ver la venta).
   *  - Doble clic: el diálogo manda un `requestId` (UUID) que es el id de la
   *    fila; el segundo clic encuentra la fila y Stripe la misma clave → un
   *    solo reembolso. Sin `requestId`, lo pendiente de otro reembolso cuenta
   *    como ya devuelto: dos reembolsos nunca superan el cargo.
   */
  async refund(input: {
    readonly tenantId: string;
    readonly saleId: string;
    readonly amount?: number;
    readonly requestId?: string;
    readonly initiatedBy: string;
  }): Promise<RefundResult> {
    const { tenantId, saleId } = input;
    const { sale } = await this.loadRefundable(tenantId, saleId);
    const charge = await this.readCharge(sale.stripeChargeId);
    this.assertNotDisputed(charge);
    const chargeAmount = this.chargeAmountOf(charge);
    const currency = (charge.currency ?? sale.presentmentCurrency).toLowerCase();
    const requestId = input.requestId && UUID.test(input.requestId) ? input.requestId : null;

    // 1. Fila del reembolso, bajo el cerrojo de la venta.
    const row = await this.db.inTenant(tenantId, async (tx) => {
      await lock(tx, saleLockKey(saleId));
      if (requestId) {
        const existing = await tx.modPayoutsRefund.findFirst({
          where: { id: requestId, tenantId },
        });
        if (existing) {
          if (existing.saleId !== saleId) {
            throw new PayoutsSaleNotRefundableError('request_conflict');
          }
          return existing;
        }
      }
      const reserved = await sumReserved(tx, tenantId, saleId);
      const remaining = Math.max(0, chargeAmount - (charge.amount_refunded ?? 0) - reserved);
      if (remaining === 0) throw new PayoutsSaleNotRefundableError('fully_refunded');
      const amount = input.amount ?? remaining;
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new PayoutsInvalidAmountError(`amount = ${String(input.amount)}`);
      }
      if (amount > remaining) throw new PayoutsRefundExceedsRemainingError(amount, remaining);
      const id = requestId ?? randomUUID();
      await tx.modPayoutsRefund.createMany({
        data: [
          {
            id,
            tenantId,
            saleId,
            amount,
            currency,
            initiatedBy: input.initiatedBy.slice(0, 200),
            reason: 'requested_by_customer',
            status: 'pending',
          },
        ],
        skipDuplicates: true,
      });
      const created = await tx.modPayoutsRefund.findFirst({ where: { id, tenantId } });
      // El id existe, pero en OTRO tenant (la RLS no lo deja ver): no es un reintento.
      if (!created) throw new PayoutsSaleNotRefundableError('request_conflict');
      return created;
    });

    if (row.status === 'failed') {
      throw new PayoutsRefundRejectedError(row.reason ?? 'rechazado');
    }

    // 2. Stripe (adoptando el que ya exista para esta fila).
    const stripeRefund = row.stripeRefundId
      ? await this.stripe.v1<RefundFromApi>(
          'GET',
          `/v1/refunds/${encodeURIComponent(row.stripeRefundId)}`,
        )
      : await this.createInStripe(tenantId, row, sale.stripeChargeId);

    // 3. Enlace fila ↔ `re_` y estado.
    const linked = await this.link(tenantId, row, stripeRefund, sale.stripeChargeId);

    // 4. Anotación. El dinero ya ha vuelto al alumno: si la anotación falla,
    //    no se le dice al creador que falló el reembolso; la termina el
    //    conciliador.
    let accounting: RefundResult['accounting'] = 'pending';
    if (linked.status === 'succeeded') {
      try {
        accounting = (await this.account(tenantId, linked.id)).outcome;
      } catch (err) {
        this.logger.error?.(
          { tenantId, saleId, refundId: linked.id, err: describe(err) },
          'payouts.refund: reembolso hecho; la anotación se completará en el conciliador',
        );
      }
    }
    return {
      refundId: linked.id,
      saleId,
      stripeRefundId: linked.stripeRefundId,
      amount: linked.amount,
      currency: linked.currency,
      status: linked.status,
      accounting,
    };
  }

  // ── Detectados en Stripe ───────────────────────────────────────────────

  /**
   * Pone al día los reembolsos de un cargo con lo que dice Stripe: da de alta
   * los hechos a mano en el panel, actualiza estados y anota los que ya
   * están hechos. Idempotente: es lo que hacen `charge.refunded`, `refund.*`
   * y el conciliador.
   */
  async syncCharge(
    tenantId: string,
    chargeId: string,
  ): Promise<{ outcome: 'no_sale' } | { outcome: 'synced'; refunds: number; accounted: number }> {
    const sale = await this.db.inTenant(tenantId, (tx) =>
      tx.modPayoutsSale.findFirst({ where: { tenantId, stripeChargeId: chargeId } }),
    );
    if (!sale) return { outcome: 'no_sale' };
    const list = await this.stripe.v1<{ data?: RefundFromApi[] }>('GET', '/v1/refunds', {
      charge: chargeId,
      limit: 100,
    });
    let accounted = 0;
    for (const refund of list.data ?? []) {
      if (!idOf(refund.id)) continue;
      const row = await this.upsertFromStripe(tenantId, sale.id, refund);
      if (!row) continue;
      if (row.status === 'succeeded' && row.reversalStatus === null) {
        const result = await this.account(tenantId, row.id);
        if (result.outcome === 'accounted') accounted += 1;
      }
    }
    return { outcome: 'synced', refunds: (list.data ?? []).length, accounted };
  }

  /**
   * Lo que quedó a medias, para el conciliador: filas sin `re_` (Stripe no
   * respondió), reembolsos `pending` en Stripe y reembolsos hechos sin
   * anotar. Acceso global sancionado para encontrarlos; cada uno se trata con
   * su tenant.
   */
  async retryPending(limit = 100): Promise<{ checked: number; accounted: number; errors: number }> {
    const staleBefore = new Date(this.now().getTime() - STALE_CREATION_MS);
    const rows = await this.db.global((tx) =>
      tx.modPayoutsRefund.findMany({
        where: {
          OR: [
            { stripeRefundId: null, status: 'pending', createdAt: { lt: staleBefore } },
            { stripeRefundId: { not: null }, status: 'pending' },
            { status: 'succeeded', reversalStatus: null },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: { id: true, tenantId: true, saleId: true },
      }),
    );
    let accounted = 0;
    let errors = 0;
    for (const ref of rows) {
      try {
        const row = await this.db.inTenant(ref.tenantId, (tx) =>
          tx.modPayoutsRefund.findFirst({ where: { id: ref.id, tenantId: ref.tenantId } }),
        );
        if (!row) continue;
        const sale = await this.db.inTenant(ref.tenantId, (tx) =>
          tx.modPayoutsSale.findFirstOrThrow({ where: { id: row.saleId, tenantId: ref.tenantId } }),
        );
        let current = row;
        if (!row.stripeRefundId) {
          const created = await this.createInStripe(ref.tenantId, row, sale.stripeChargeId);
          current = await this.link(ref.tenantId, row, created, sale.stripeChargeId);
        } else if (row.status === 'pending') {
          const fresh = await this.stripe.v1<RefundFromApi>(
            'GET',
            `/v1/refunds/${encodeURIComponent(row.stripeRefundId)}`,
          );
          current = await this.link(ref.tenantId, row, fresh, sale.stripeChargeId);
        }
        if (current.status === 'succeeded' && current.reversalStatus === null) {
          const result = await this.account(ref.tenantId, current.id);
          if (result.outcome === 'accounted') accounted += 1;
        }
      } catch (err) {
        errors += 1;
        this.logger.warn(
          { refundId: ref.id, tenantId: ref.tenantId, err: describe(err) },
          'payouts.refund: no se pudo completar un reembolso pendiente (se reintenta)',
        );
      }
    }
    return { checked: rows.length, accounted, errors };
  }

  // ── Anotación ──────────────────────────────────────────────────────────

  /** Anota un reembolso HECHO en Stripe. Idempotente (`reversal_status` es el sello). */
  async account(tenantId: string, refundId: string): Promise<RefundAccountingOutcome> {
    const loaded = await this.db.inTenant(tenantId, async (tx) => {
      const row = await tx.modPayoutsRefund.findFirst({ where: { id: refundId, tenantId } });
      if (!row) return null;
      const sale = await tx.modPayoutsSale.findFirstOrThrow({
        where: { id: row.saleId, tenantId },
      });
      const account = await tx.modPayoutsAccount.findFirst({
        where: { id: sale.accountId, tenantId },
        select: { stripeAccountId: true },
      });
      return { row, sale, stripeAccountId: account?.stripeAccountId ?? null };
    });
    if (!loaded) return { outcome: 'not_found', refundId };
    const { row, sale } = loaded;
    if (row.reversalStatus !== null) return { outcome: 'already', refundId };
    if (row.status !== 'succeeded') {
      return { outcome: 'not_succeeded', refundId, status: row.status };
    }
    if (
      sale.status === 'FAILED' ||
      sale.status === 'AWAITING_FEE' ||
      sale.transferAmount === null
    ) {
      if (sale.status === 'FAILED') {
        await this.alert(PAYOUTS_LOSS_ALERTS.refundUnaccountable, {
          tenantId,
          saleId: sale.id,
          refundId,
          detail: 'reembolso de una venta en revisión (FAILED): anotarlo a mano',
        });
      }
      return { outcome: 'awaiting_split', refundId };
    }

    const charge = await this.readCharge(sale.stripeChargeId);
    const chargeAmount = this.chargeAmountOf(charge);
    const transferred = sale.status === 'TRANSFERRED' && sale.stripeTransferId !== null;
    if (!transferred && saleTransferInFlight(sale, this.now(), this.leaseMs)) {
      return { outcome: 'busy', refundId };
    }

    // 1. Objetivo de la reversión, fijado UNA vez en la fila (bajo el cerrojo
    //    de la venta): un reintento pide a Stripe exactamente lo mismo.
    let target = 0;
    if (transferred) {
      target = await this.db.inTenant(tenantId, async (tx) => {
        await lock(tx, saleLockKey(sale.id));
        const fresh = await tx.modPayoutsRefund.findFirstOrThrow({
          where: { id: refundId, tenantId },
        });
        if (fresh.reversalTarget !== null) return fresh.reversalTarget;
        const s = await tx.modPayoutsSale.findFirstOrThrow({ where: { id: sale.id, tenantId } });
        const before = await sumAccounted(tx, tenantId, sale.id);
        const settle = chargeToSettlement({
          chargeAmount,
          gross: s.gross!,
          refundedBefore: Math.min(before, chargeAmount - row.amount),
          amount: row.amount,
        });
        const shares = sharesOfGross(
          this.settled(s),
          Math.min(s.refundedAmount, s.gross! - settle),
          settle,
        );
        const value = Math.max(
          0,
          Math.min(shares.creator, (s.transferAmount ?? 0) - s.reversedAmount),
        );
        await tx.modPayoutsRefund.updateMany({
          where: { id: refundId, tenantId, reversalTarget: null },
          data: { reversalTarget: value },
        });
        return value;
      });
    }

    // 2. Reversión en Stripe (fuera de toda transacción).
    let reversal: ReversalResult = { reversed: 0, reversalId: null, status: 'DONE', detail: null };
    if (transferred && target > 0) {
      if (!loaded.stripeAccountId) throw new PayoutsSaleNotFoundError();
      reversal = await reverseTransfer(this.stripe, {
        transferId: sale.stripeTransferId!,
        stripeAccountId: loaded.stripeAccountId,
        currency: sale.currency!,
        target,
        idempotencyKey: IDEMPOTENCY_KEYS.reversal(refundId),
        metadata: {
          didacta_refund_id: refundId,
          didacta_sale_id: sale.id,
          didacta_tenant_id: tenantId,
        },
        metaKey: 'didacta_refund_id',
        description: 'Didacta: reembolso al alumno',
      });
    }

    // 3. El grupo de asientos, la deuda y las columnas de la venta: todo o nada.
    const occurredAt = this.now();
    const written = await this.db
      .inTenant(tenantId, async (tx) => {
        await lock(tx, debtLockKey(sale.accountId, sale.currency!));
        await lock(tx, saleLockKey(sale.id));
        const fresh = await tx.modPayoutsRefund.findFirstOrThrow({
          where: { id: refundId, tenantId },
        });
        if (fresh.reversalStatus !== null) return null;
        const s = await tx.modPayoutsSale.findFirstOrThrow({ where: { id: sale.id, tenantId } });
        // La liquidación la transfirió entre la lectura y aquí: otra vuelta, ya
        // por el camino de la reversión.
        if (!transferred && s.stripeTransferId !== null) throw new RefundBusyError();
        const before = await sumAccounted(tx, tenantId, s.id);
        const settle = chargeToSettlement({
          chargeAmount,
          gross: s.gross!,
          refundedBefore: Math.min(before, chargeAmount - fresh.amount),
          amount: fresh.amount,
        });
        const shares = sharesOfGross(
          this.settled(s),
          Math.min(s.refundedAmount, s.gross! - settle),
          settle,
        );
        const split = this.split(shares);
        const reversed = Math.min(reversal.reversed, shares.creator);
        const currency = s.currency!;
        const base = { tenantId, accountId: s.accountId, saleId: s.id, currency, occurredAt };
        const entries: LedgerEntryInput[] = [
          {
            ...base,
            type: 'REFUND',
            amount: -settle,
            stripeObjectId: fresh.stripeRefundId,
            idempotencyKey: IDEMPOTENCY_KEYS.refund(refundId),
            metadata: {
              refundId,
              chargeAmount: fresh.amount,
              chargeCurrency: fresh.currency,
              initiatedBy: fresh.initiatedBy,
            },
          },
        ];
        if (split.platformFeeReturned > 0) {
          entries.push({
            ...base,
            type: 'PLATFORM_FEE_REFUND',
            amount: split.platformFeeReturned,
            idempotencyKey: IDEMPOTENCY_KEYS.refundEntry(refundId, 'platform-fee'),
            metadata: { refundId },
          });
        }
        if (split.cardFeeAbsorbed > 0) {
          entries.push({
            ...base,
            type: 'ADJUSTMENT',
            amount: split.cardFeeAbsorbed,
            idempotencyKey: IDEMPOTENCY_KEYS.refundEntry(refundId, 'card-fee-absorbed'),
            metadata: { refundId, cause: 'refund_card_fee_absorbed_by_platform' },
          });
        }
        if (reversed > 0) {
          entries.push({
            ...base,
            type: 'TRANSFER_REVERSAL',
            amount: reversed,
            stripeObjectId: reversal.reversalId,
            idempotencyKey: IDEMPOTENCY_KEYS.reversal(refundId),
            metadata: { refundId, transferId: s.stripeTransferId },
          });
        }
        await new LedgerService(tx as unknown as PrismaClient).appendMany(entries);

        // Lo que el creador no devolvió revirtiendo, y lo que asume de comisiones.
        const shortfall = shares.creator - reversed;
        const feeDebt = split.cardFeeToCreator + split.platformFeeToCreator;
        const debtIds: string[] = [];
        if (shortfall > 0) {
          const { debtId } = await createDebt(tx, {
            ...base,
            reason: 'REVERSAL_FAILED',
            amount: shortfall,
            originSaleId: s.id,
            idempotencyKey: IDEMPOTENCY_KEYS.refundEntry(refundId, 'debt-reversal'),
            stripeObjectId: fresh.stripeRefundId,
            metadata: {
              refundId,
              cause: transferred ? 'reversal_shortfall' : 'refund_before_transfer',
              detail: reversal.detail,
            },
          });
          debtIds.push(debtId);
        }
        if (feeDebt > 0) {
          const { debtId } = await createDebt(tx, {
            ...base,
            reason: 'REFUND_FEE',
            amount: feeDebt,
            originSaleId: s.id,
            idempotencyKey: IDEMPOTENCY_KEYS.refundEntry(refundId, 'debt-fee'),
            stripeObjectId: fresh.stripeRefundId,
            metadata: {
              refundId,
              cardFee: split.cardFeeToCreator,
              platformFee: split.platformFeeToCreator,
            },
          });
          debtIds.push(debtId);
        }

        // Venta aún sin transferir: lo que toca al creador sale de su transferencia pendiente.
        let netted = 0;
        if (
          !transferred &&
          s.stripeTransferId === null &&
          (s.status === 'READY' || s.status === 'HELD') &&
          (s.transferAmount ?? 0) > 0 &&
          debtIds.length > 0
        ) {
          if (saleTransferInFlight(s, occurredAt, this.leaseMs)) {
            throw new RefundBusyError();
          }
          const taken = await netAgainstPendingSale(tx, {
            tenantId,
            saleId: s.id,
            expected: {
              transferAmount: s.transferAmount!,
              debtNetted: s.debtNetted,
              status: s.status,
              nextAttemptAt: s.nextAttemptAt,
            },
            debtIds,
            currency,
            accountId: s.accountId,
            occurredAt,
            nextAttemptAt: occurredAt,
          });
          netted = [...taken.values()].reduce((a, b) => a + b, 0);
        }

        await tx.modPayoutsSale.updateMany({
          where: { id: s.id, tenantId },
          data: {
            refundedAmount: s.refundedAmount + settle,
            reversedAmount: s.reversedAmount + reversed,
          },
        });
        const recovered = reversed + netted;
        await tx.modPayoutsRefund.updateMany({
          where: { id: refundId, tenantId, reversalStatus: null },
          data: {
            reversalStatus:
              recovered >= shares.creator ? 'DONE' : recovered > 0 ? 'PARTIAL' : 'FAILED_TO_DEBT',
            stripeReversalId: reversal.reversalId,
            ...(fresh.reversalTarget === null ? { reversalTarget: transferred ? target : 0 } : {}),
          },
        });
        return {
          settle,
          currency,
          openDebt: shortfall + feeDebt - netted,
          shortfall: transferred ? shortfall : 0,
          description: s.description,
          stillPending: !transferred && s.status !== 'SETTLED_NETTED',
        };
      })
      .catch((err: unknown) => {
        if (err instanceof RefundBusyError) return 'busy' as const;
        throw err;
      });

    if (written === 'busy') return { outcome: 'busy', refundId };
    if (!written) return { outcome: 'already', refundId };

    this.logger.log?.(
      {
        tenantId,
        saleId: sale.id,
        refundId,
        settle: written.settle,
        reversed: reversal.reversed,
        debt: written.openDebt,
      },
      'payouts.refund: reembolso anotado',
    );
    if (written.shortfall > 0) {
      await this.alert(PAYOUTS_LOSS_ALERTS.reversalShortfall, {
        tenantId,
        saleId: sale.id,
        refundId,
        target,
        reversed: reversal.reversed,
        currency: written.currency,
        detail: reversal.detail,
      });
    }
    if (written.openDebt > 0) {
      await this.notifier
        .debtCharged({
          tenantId,
          saleId: sale.id,
          description: written.description,
          amount: written.openDebt,
          currency: written.currency,
          cause: 'refund',
        })
        .catch(() => undefined);
    }
    await this.checkFx(tenantId, sale, row, written.settle, charge).catch(() => undefined);
    if (written.stillPending && this.onSaleChanged) {
      await this.onSaleChanged(tenantId, sale.id).catch(() => undefined);
    }
    return { outcome: 'accounted', refundId, reversal, debt: written.openDebt };
  }

  // ── Interno ────────────────────────────────────────────────────────────

  private split(shares: GrossShares) {
    const platformFeeReturned = this.policy.refundPlatformFee ? shares.platform : 0;
    const platformFeeToCreator = this.policy.refundPlatformFee ? 0 : shares.platform;
    const cardFeeToCreator = this.policy.refundCardFeeBearer === 'creator' ? shares.stripe : 0;
    const cardFeeAbsorbed = this.policy.refundCardFeeBearer === 'platform' ? shares.stripe : 0;
    return { platformFeeReturned, platformFeeToCreator, cardFeeToCreator, cardFeeAbsorbed };
  }

  private settled(sale: SaleRow) {
    return {
      gross: sale.gross!,
      stripeFee: sale.stripeFee!,
      platformFee: sale.platformFee!,
      creatorNet: sale.creatorNet!,
    };
  }

  /** La venta del tenant, y si ahora mismo se puede reembolsar desde el panel. */
  private async loadRefundable(tenantId: string, saleId: string) {
    if (!UUID.test(saleId)) throw new PayoutsSaleNotFoundError();
    const found = await this.db.inTenant(tenantId, async (tx) => {
      const sale = await tx.modPayoutsSale.findFirst({ where: { id: saleId, tenantId } });
      if (!sale) return null;
      const openDisputes = await tx.modPayoutsDispute.count({
        where: { tenantId, saleId, outcome: null },
      });
      const accountedBefore = await sumAccounted(tx, tenantId, saleId);
      return { sale, openDisputes, accountedBefore };
    });
    if (!found) throw new PayoutsSaleNotFoundError();
    const { sale } = found;
    if (sale.status === 'FAILED') throw new PayoutsSaleNotRefundableError('needs_review');
    if (sale.status === 'AWAITING_FEE' || sale.gross === null || sale.transferAmount === null) {
      throw new PayoutsSaleNotRefundableError('not_settled');
    }
    if (found.openDisputes > 0) throw new PayoutsSaleNotRefundableError('disputed');
    if (sale.refundedAmount >= sale.gross)
      throw new PayoutsSaleNotRefundableError('fully_refunded');
    return found;
  }

  private async reservedAmount(tenantId: string, saleId: string): Promise<number> {
    return this.db.inTenant(tenantId, (tx) => sumReserved(tx, tenantId, saleId));
  }

  private readCharge(chargeId: string): Promise<ChargeFromApi> {
    return this.stripe.v1<ChargeFromApi>('GET', `/v1/charges/${encodeURIComponent(chargeId)}`);
  }

  private chargeAmountOf(charge: ChargeFromApi): number {
    if (!Number.isInteger(charge.amount) || (charge.amount ?? 0) <= 0) {
      throw new PayoutsInvalidAmountError(
        `importe del cargo ${charge.id}: ${String(charge.amount)}`,
      );
    }
    return charge.amount!;
  }

  /** Desde el panel no se reembolsa un cargo disputado (aunque la disputa aún no esté anotada). */
  private assertNotDisputed(charge: ChargeFromApi): void {
    if (charge.disputed === true) throw new PayoutsSaleNotRefundableError('disputed');
  }

  private async createInStripe(
    tenantId: string,
    row: RefundRow,
    chargeId: string,
  ): Promise<RefundFromApi> {
    // ¿Ya lo creó un intento anterior? (Stripe olvida la clave a las 24 h.)
    const list = await this.stripe.v1<{ data?: RefundFromApi[] }>('GET', '/v1/refunds', {
      charge: chargeId,
      limit: 100,
    });
    const adopted = (list.data ?? []).find((r) => r.metadata?.['didacta_refund_id'] === row.id);
    if (adopted) return adopted;
    try {
      return await this.stripe.v1<RefundFromApi>(
        'POST',
        '/v1/refunds',
        {
          charge: chargeId,
          amount: row.amount,
          reason: 'requested_by_customer',
          metadata: {
            didacta_refund_id: row.id,
            didacta_sale_id: row.saleId,
            didacta_tenant_id: tenantId,
          },
        },
        { idempotencyKey: IDEMPOTENCY_KEYS.refund(row.id) },
      );
    } catch (err) {
      if (!(err instanceof PlatformStripeApiError) || err.retryable) throw err;
      const detail = `${err.stripeCode ?? err.type ?? err.status}: ${err.detail ?? err.message}`;
      await this.db.inTenant(tenantId, (tx) =>
        tx.modPayoutsRefund.updateMany({
          where: { id: row.id, tenantId, stripeRefundId: null },
          data: { status: 'failed', reason: detail.slice(0, 500) },
        }),
      );
      throw new PayoutsRefundRejectedError(err.detail ?? err.message);
    }
  }

  /** Enlaza la fila con su `re_` y le pone el estado de Stripe. */
  private async link(
    tenantId: string,
    row: RefundRow,
    refund: RefundFromApi,
    chargeId: string,
  ): Promise<RefundRow> {
    const status = refund.status ?? 'pending';
    return this.db.inTenant(tenantId, async (tx) => {
      await tx.modPayoutsRefund.updateMany({
        where: {
          id: row.id,
          tenantId,
          OR: [{ stripeRefundId: null }, { stripeRefundId: refund.id }],
        },
        data: { stripeRefundId: refund.id, status },
      });
      await new RefsService(tx as unknown as PrismaClient).register({
        tenantId,
        stripeObjectId: refund.id,
        kind: 'refund',
        source: 'payouts',
        localRef: row.id,
        parentObjectId: chargeId,
        livemode: refund.livemode === true,
      });
      return tx.modPayoutsRefund.findFirstOrThrow({ where: { id: row.id, tenantId } });
    });
  }

  /** Fila de un reembolso visto en Stripe: la nuestra (por `re_` o metadata) o una nueva. */
  private async upsertFromStripe(
    tenantId: string,
    saleId: string,
    refund: RefundFromApi,
  ): Promise<RefundRow | null> {
    const status = refund.status ?? 'pending';
    const metaId = refund.metadata?.['didacta_refund_id'];
    const result = await this.db.inTenant(tenantId, async (tx) => {
      await lock(tx, saleLockKey(saleId));
      let row =
        (await tx.modPayoutsRefund.findFirst({ where: { tenantId, stripeRefundId: refund.id } })) ??
        (typeof metaId === 'string' && UUID.test(metaId)
          ? await tx.modPayoutsRefund.findFirst({ where: { tenantId, id: metaId, saleId } })
          : null);
      const previousStatus = row?.status ?? null;
      if (!row) {
        if (!Number.isInteger(refund.amount) || (refund.amount ?? 0) <= 0) return null;
        row = await tx.modPayoutsRefund.create({
          data: {
            tenantId,
            saleId,
            stripeRefundId: refund.id,
            amount: refund.amount!,
            currency: (refund.currency ?? '').toLowerCase(),
            initiatedBy: 'stripe_dashboard',
            reason: (refund.reason ?? 'manual').slice(0, 200),
            status,
          },
        });
        this.logger.warn(
          { tenantId, saleId, stripeRefundId: refund.id, amount: refund.amount },
          'payouts.refund: reembolso hecho fuera de Didacta (panel de Stripe); se anota igual',
        );
      } else if (row.stripeRefundId !== refund.id || row.status !== status) {
        await tx.modPayoutsRefund.updateMany({
          where: { id: row.id, tenantId },
          data: { stripeRefundId: refund.id, status },
        });
        row = await tx.modPayoutsRefund.findFirstOrThrow({ where: { id: row.id, tenantId } });
      }
      await new RefsService(tx as unknown as PrismaClient).register({
        tenantId,
        stripeObjectId: refund.id,
        kind: 'refund',
        source: 'payouts',
        localRef: row.id,
        parentObjectId: idOf(refund.charge),
        livemode: refund.livemode === true,
      });
      return { row, previousStatus };
    });
    if (!result) return null;
    const { row, previousStatus } = result;
    if (
      (row.status === 'failed' || row.status === 'canceled') &&
      previousStatus !== row.status &&
      row.reversalStatus !== null
    ) {
      await this.alert(PAYOUTS_LOSS_ALERTS.refundFailedAfterAccounting, {
        tenantId,
        saleId,
        refundId: row.id,
        stripeRefundId: refund.id,
        status: row.status,
        detail:
          'el reembolso ya estaba anotado (reversión/deuda) y Stripe lo da por fallido: el dinero volvió a la plataforma; revisar a mano',
      });
    }
    return row;
  }

  /**
   * Cargo en una moneda y liquidación en otra: Stripe devuelve al tipo de cambio
   * de HOY. La diferencia con lo anotado (en proporción al bruto) la absorbe la
   * plataforma, y se avisa: nunca en silencio.
   */
  private async checkFx(
    tenantId: string,
    sale: SaleRow,
    row: RefundRow,
    settle: number,
    charge: ChargeFromApi,
  ): Promise<void> {
    if (!row.stripeRefundId) return;
    if ((charge.currency ?? '').toLowerCase() === sale.currency) return;
    const refund = await this.stripe.v1<RefundFromApi>(
      'GET',
      `/v1/refunds/${encodeURIComponent(row.stripeRefundId)}`,
      { expand: ['balance_transaction'] },
    );
    const bt = refund.balance_transaction as { amount?: number; currency?: string } | null;
    if (!bt || typeof bt !== 'object' || typeof bt.amount !== 'number') return;
    const real = -bt.amount;
    if ((bt.currency ?? '').toLowerCase() !== sale.currency || real === settle) return;
    await this.alert(PAYOUTS_LOSS_ALERTS.refundFxDifference, {
      tenantId,
      saleId: sale.id,
      refundId: row.id,
      currency: sale.currency,
      ledger: settle,
      stripe: real,
      difference: real - settle,
      detail: 'diferencia de cambio del reembolso: la asume la plataforma',
    });
  }

  private async alert(alert: string, detail: Record<string, unknown>): Promise<void> {
    (this.logger.error ?? this.logger.warn).call(this.logger, { alert, ...detail }, `${alert}`);
    await this.notifier.operatorAlert(alert, detail).catch(() => undefined);
  }
}

class RefundBusyError extends Error {}

async function lock(tx: PayoutsTx, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`;
}

/** Reembolsos de la venta ya anotados, en la moneda del cargo. */
async function sumAccounted(tx: PayoutsTx, tenantId: string, saleId: string): Promise<number> {
  const rows = await tx.modPayoutsRefund.findMany({
    where: { tenantId, saleId, reversalStatus: { not: null } },
    select: { amount: true },
  });
  return rows.reduce((total, row) => total + row.amount, 0);
}

/** Reembolsos pedidos desde Didacta que aún no tienen `re_` (reservan importe). */
async function sumReserved(tx: PayoutsTx, tenantId: string, saleId: string): Promise<number> {
  const rows = await tx.modPayoutsRefund.findMany({
    where: { tenantId, saleId, stripeRefundId: null, status: 'pending' },
    select: { amount: true },
  });
  return rows.reduce((total, row) => total + row.amount, 0);
}

function describe(err: unknown): string {
  if (err instanceof PlatformStripeApiError)
    return `${err.operation}: ${err.detail ?? err.message}`;
  return err instanceof Error ? err.message : String(err);
}
