/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PayoutsSaleStatus } from '@didacta/database';
import type { PayoutScheduleView, PayoutsDbPort } from './accounts.service.js';
import { frozenDisputeSaleIds, wonDisputeFeeDebtIds, type DebtView } from './debts.service.js';
import type { DisputeView } from './disputes.service.js';
import { saleReasonCode } from './settlement.service.js';

/**
 * Lo que ven el creador («Tus ventas» y su resumen) y el plano de control
 * (volumen por aula, día y divisa). Solo lectura.
 *
 * Multidivisa: cada importe va con su divisa y NUNCA se suman divisas
 * distintas. El resumen es una fila por divisa de liquidación.
 */

export interface SaleView {
  readonly id: string;
  readonly chargedAt: string | null;
  readonly description: string | null;
  readonly sourceKind: string;
  readonly status: PayoutsSaleStatus;
  /** Código del motivo de una venta retenida o fallida (`transfer_rejected`…), sin el texto de Stripe. */
  readonly reason: string | null;
  /** Lo que pagó el alumno, en SU moneda. */
  readonly presentmentAmount: number;
  readonly presentmentCurrency: string;
  /** Divisa de liquidación; `null` mientras Stripe no ha asentado el cobro. */
  readonly currency: string | null;
  readonly gross: number | null;
  readonly stripeFee: number | null;
  readonly feeBpsApplied: number | null;
  readonly platformFee: number | null;
  readonly creatorNet: number | null;
  readonly debtNetted: number;
  readonly transferAmount: number | null;
  /** Devuelto al alumno, en la divisa de liquidación (lo ya anotado). */
  readonly refundedAmount: number;
  /** Lo que se le retiró al creador de esta venta (reembolsos, disputas, deudas). */
  readonly reversedAmount: number;
  /** `none` | `partial` | `full`: cuánto de la venta se ha devuelto. */
  readonly refundState: 'none' | 'partial' | 'full';
  /** El alumno reclamó el pago a su banco y aún no se ha decidido. */
  readonly disputeOpen: boolean;
  /** ¿Se puede pedir un reembolso desde el panel ahora? */
  readonly canRefund: boolean;
  /** Reclamación ya decidida: `won` (se le devolvió al creador) o `lost`. */
  readonly disputeOutcome: 'won' | 'lost' | null;
  /** Lo que se le transfirió de nuevo al ganar una reclamación. */
  readonly reinstatedAmount: number;
  readonly transferredAt: string | null;
  /** Cuándo quedan disponibles los fondos (`available_on`). */
  readonly availableOn: string | null;
  /** Día estimado del pago al banco, con el calendario de la cuenta. */
  readonly estimatedArrival: string | null;
}

export interface SalesPage {
  readonly items: SaleView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface CurrencySummary {
  readonly currency: string;
  readonly salesCount: number;
  /** Vendido (bruto en la divisa de liquidación). */
  readonly gross: number;
  readonly stripeFees: number;
  readonly platformFees: number;
  /** Ya transferido a la cuenta del creador. */
  readonly received: number;
  /** Calculado y pendiente de transferir (en camino o retenido). */
  readonly pending: number;
  /** Lo que se descontó de las ventas para saldar deuda. */
  readonly debtNetted: number;
  /** Deuda abierta hoy en esta divisa. */
  readonly debtOutstanding: number;
  /** Devuelto a alumnos (reembolsos anotados). */
  readonly refunded: number;
  /** Retirado de lo que ya se le había enviado (reembolsos, disputas, recobros). */
  readonly reversed: number;
}

export interface SalesSummary {
  readonly currencies: CurrencySummary[];
  /** Ventas cobradas cuyo reparto aún no se puede calcular (sin `balance_transaction`). */
  readonly awaitingFeeCount: number;
  /** Deudas abiertas, con su motivo, para el aviso «Te descontaremos…». */
  readonly debts: DebtView[];
  /** Disputas sin decidir, con su fecha límite. */
  readonly disputes: DisputeView[];
}

/** Fila del contrato `GET /admin/tenants/payouts/volume`. */
export interface VolumeRow {
  readonly tenantId: string;
  /** Día UTC del cobro (`YYYY-MM-DD`). */
  readonly day: string;
  readonly currency: string;
  readonly gmv: number;
  readonly stripeFees: number;
  readonly platformFees: number;
  readonly refunds: number;
  readonly disputes: number;
  readonly salesCount: number;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_MS = 86_400_000;

function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Día estimado en que el dinero de una venta sale hacia el banco del creador:
 * el primer día de pago de su calendario a partir de `available_on`. Es una
 * estimación (Stripe puede mover un pago por festivos o revisión): `null` si
 * el calendario es manual o desconocido.
 */
export function estimatePayoutDate(
  availableOn: Date | null,
  schedule: PayoutScheduleView | null,
): Date | null {
  if (!availableOn || !schedule) return null;
  const from = utcDay(availableOn);
  switch (schedule.interval) {
    case 'daily':
      return from;
    case 'weekly': {
      const target = WEEKDAYS.indexOf(schedule.weeklyDay ?? '');
      if (target === -1) return null;
      const delta = (target - from.getUTCDay() + 7) % 7;
      return new Date(from.getTime() + delta * DAY_MS);
    }
    case 'monthly': {
      const anchor = schedule.monthlyDay;
      if (!anchor || anchor < 1 || anchor > 31) return null;
      for (let offset = 0; offset < 2; offset += 1) {
        const year = from.getUTCFullYear();
        const month = from.getUTCMonth() + offset;
        const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        const candidate = new Date(Date.UTC(year, month, Math.min(anchor, lastDay)));
        if (candidate.getTime() >= from.getTime()) return candidate;
      }
      return null;
    }
    default:
      return null;
  }
}

const ARRIVAL_STATUSES = new Set<PayoutsSaleStatus>(['READY', 'TRANSFERRED']);

export class PayoutsReportsService {
  constructor(private readonly db: PayoutsDbPort) {}

  /** Ventas del tenant, de la más reciente a la más antigua. */
  async listSales(
    tenantId: string,
    options: { readonly page?: number; readonly pageSize?: number } = {},
  ): Promise<SalesPage> {
    const pageSize = Math.min(Math.max(Math.trunc(options.pageSize ?? 20), 1), 100);
    const page = Math.max(Math.trunc(options.page ?? 1), 1);
    const { rows, total, schedule, disputed, outcomes, reinstated } = await this.db.inTenant(
      tenantId,
      async (tx) => {
        const [rows, total, account] = await Promise.all([
          tx.modPayoutsSale.findMany({
            where: { tenantId },
            orderBy: [{ chargedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.modPayoutsSale.count({ where: { tenantId } }),
          tx.modPayoutsAccount.findFirst({
            where: { tenantId, closedAt: null },
            orderBy: { createdAt: 'desc' },
            select: { payoutSchedule: true },
          }),
        ]);
        const disputed = new Set(await frozenDisputeSaleIds(tx, tenantId));
        const ids = rows.map((r) => r.id);
        const decided = ids.length
          ? await tx.modPayoutsDispute.findMany({
              where: { tenantId, saleId: { in: ids }, outcome: { not: null } },
              select: { saleId: true, outcome: true },
            })
          : [];
        const reinstated = ids.length
          ? await tx.modPayoutsLedgerEntry.groupBy({
              by: ['saleId'],
              where: {
                tenantId,
                saleId: { in: ids },
                type: 'TRANSFER',
                idempotencyKey: { startsWith: 'payouts:reinstate:' },
              },
              _sum: { amount: true },
              orderBy: { saleId: 'asc' },
            })
          : [];
        return {
          rows,
          total,
          schedule: (account?.payoutSchedule as PayoutScheduleView | null | undefined) ?? null,
          disputed,
          outcomes: new Map(decided.map((d) => [d.saleId, d.outcome])),
          reinstated: new Map(reinstated.map((r) => [r.saleId, -(r._sum.amount ?? 0)])),
        };
      },
    );
    const items = rows.map((row): SaleView => {
      const arrival = ARRIVAL_STATUSES.has(row.status)
        ? estimatePayoutDate(row.availableOn, schedule)
        : null;
      return {
        id: row.id,
        chargedAt: row.chargedAt?.toISOString() ?? null,
        description: row.description,
        sourceKind: row.sourceKind,
        status: row.status,
        reason:
          row.status === 'HELD' || row.status === 'FAILED' ? saleReasonCode(row.lastError) : null,
        presentmentAmount: row.presentmentAmount,
        presentmentCurrency: row.presentmentCurrency,
        currency: row.currency,
        gross: row.gross,
        stripeFee: row.stripeFee,
        feeBpsApplied: row.feeBpsApplied,
        platformFee: row.platformFee,
        creatorNet: row.creatorNet,
        debtNetted: row.debtNetted,
        transferAmount: row.transferAmount,
        refundedAmount: row.refundedAmount,
        reversedAmount: row.reversedAmount,
        refundState:
          row.refundedAmount <= 0
            ? 'none'
            : row.gross !== null && row.refundedAmount >= row.gross
              ? 'full'
              : 'partial',
        disputeOpen: disputed.has(row.id),
        disputeOutcome: disputed.has(row.id)
          ? null
          : outcomes.get(row.id) === 'won'
            ? 'won'
            : outcomes.get(row.id) === 'lost'
              ? 'lost'
              : null,
        reinstatedAmount: reinstated.get(row.id) ?? 0,
        canRefund:
          row.status !== 'AWAITING_FEE' &&
          row.status !== 'FAILED' &&
          row.gross !== null &&
          row.transferAmount !== null &&
          row.refundedAmount < row.gross &&
          // Con disputa (abierta o decidida) Stripe no deja reembolsar el cargo.
          !disputed.has(row.id) &&
          !outcomes.has(row.id),
        transferredAt: row.transferredAt?.toISOString() ?? null,
        availableOn: row.availableOn?.toISOString() ?? null,
        estimatedArrival: arrival ? arrival.toISOString().slice(0, 10) : null,
      };
    });
    return { items, page, pageSize, total };
  }

  /** Resumen por divisa de liquidación. Nunca suma divisas distintas. */
  async summary(tenantId: string): Promise<SalesSummary> {
    const { groups, debts, awaiting, openDebts, openDisputes, frozen, wonFee } =
      await this.db.inTenant(tenantId, async (tx) => {
        const open = await tx.modPayoutsDebt.findMany({
          where: { tenantId, status: 'OPEN', amountOutstanding: { gt: 0 } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 50,
        });
        return {
          groups: await tx.modPayoutsSale.groupBy({
            by: ['currency', 'status'],
            where: { tenantId, currency: { not: null } },
            _count: { _all: true },
            _sum: {
              gross: true,
              stripeFee: true,
              platformFee: true,
              transferAmount: true,
              debtNetted: true,
              refundedAmount: true,
              reversedAmount: true,
            },
            orderBy: [{ currency: 'asc' }, { status: 'asc' }],
          }),
          debts: await tx.modPayoutsDebt.groupBy({
            by: ['currency'],
            where: { tenantId, status: 'OPEN' },
            _sum: { amountOutstanding: true },
            orderBy: { currency: 'asc' },
          }),
          awaiting: await tx.modPayoutsSale.count({ where: { tenantId, currency: null } }),
          openDebts: open,
          openDisputes: await tx.modPayoutsDispute.findMany({
            where: { tenantId, outcome: null },
            orderBy: [{ evidenceDueBy: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
            take: 50,
          }),
          frozen: await frozenDisputeSaleIds(tx, tenantId),
          wonFee: await wonDisputeFeeDebtIds(tx, tenantId, open),
        };
      });
    const saleIds = [
      ...new Set([
        ...openDebts.map((d) => d.originSaleId).filter((id): id is string => !!id),
        ...openDisputes.map((d) => d.saleId),
      ]),
    ];
    const descriptions = saleIds.length
      ? new Map(
          (
            await this.db.inTenant(tenantId, (tx) =>
              tx.modPayoutsSale.findMany({
                where: { tenantId, id: { in: saleIds } },
                select: { id: true, description: true },
              }),
            )
          ).map((sale) => [sale.id, sale.description]),
        )
      : new Map<string, string | null>();

    const byCurrency = new Map<string, Mutable<CurrencySummary>>();
    const bucket = (currency: string) => {
      let entry = byCurrency.get(currency);
      if (!entry) {
        entry = {
          currency,
          salesCount: 0,
          gross: 0,
          stripeFees: 0,
          platformFees: 0,
          received: 0,
          pending: 0,
          debtNetted: 0,
          debtOutstanding: 0,
          refunded: 0,
          reversed: 0,
        };
        byCurrency.set(currency, entry);
      }
      return entry;
    };
    for (const group of groups) {
      if (!group.currency) continue;
      const entry = bucket(group.currency);
      const sum = group._sum;
      entry.salesCount += group._count._all;
      entry.gross += sum.gross ?? 0;
      entry.stripeFees += sum.stripeFee ?? 0;
      entry.platformFees += sum.platformFee ?? 0;
      entry.debtNetted += sum.debtNetted ?? 0;
      entry.refunded += sum.refundedAmount ?? 0;
      entry.reversed += sum.reversedAmount ?? 0;
      if (group.status === 'TRANSFERRED') entry.received += sum.transferAmount ?? 0;
      if (group.status === 'READY' || group.status === 'HELD') {
        entry.pending += sum.transferAmount ?? 0;
      }
    }
    for (const debt of debts) {
      const amount = debt._sum.amountOutstanding ?? 0;
      if (amount !== 0) bucket(debt.currency).debtOutstanding += amount;
    }
    return {
      currencies: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
      awaitingFeeCount: awaiting,
      debts: openDebts.map((debt) => ({
        id: debt.id,
        reason: debt.reason,
        amountOriginal: debt.amountOriginal,
        amountOutstanding: debt.amountOutstanding,
        currency: debt.currency,
        createdAt: debt.createdAt.toISOString(),
        saleId: debt.originSaleId,
        saleDescription: debt.originSaleId ? (descriptions.get(debt.originSaleId) ?? null) : null,
        frozen:
          debt.reason === 'DISPUTE' &&
          debt.originSaleId !== null &&
          frozen.includes(debt.originSaleId),
        fromWonDispute: wonFee.has(debt.id),
      })),
      disputes: openDisputes.map((dispute) => ({
        id: dispute.id,
        saleId: dispute.saleId,
        saleDescription: descriptions.get(dispute.saleId) ?? null,
        status: dispute.status,
        amount: dispute.amount,
        currency: dispute.currency,
        reason: dispute.reason,
        evidenceDueBy: dispute.evidenceDueBy?.toISOString() ?? null,
      })),
    };
  }

  /**
   * Volumen de TODAS las aulas por día (del cobro, UTC) y divisa de
   * liquidación, entre `from` (incluido) y `to` (excluido). Acceso global
   * sancionado: solo para el plano de control.
   *
   * Una venta cuenta cuando su reparto se conoce (tiene `gross`): una cobrada
   * el día D y liquidada el D+1 aparece en el día D a partir del D+1. Quien
   * consuma esto debe volver a pedir los últimos días.
   */
  async volume(from: Date, to: Date): Promise<VolumeRow[]> {
    const { sales, refunds, disputes } = await this.db.global(async (tx) => ({
      sales: await tx.modPayoutsSale.findMany({
        where: { chargedAt: { gte: from, lt: to }, currency: { not: null }, gross: { not: null } },
        select: {
          tenantId: true,
          chargedAt: true,
          currency: true,
          gross: true,
          stripeFee: true,
          platformFee: true,
        },
      }),
      refunds: await tx.modPayoutsRefund.findMany({
        where: { createdAt: { gte: from, lt: to }, status: 'succeeded' },
        select: { tenantId: true, createdAt: true, currency: true, amount: true },
      }),
      disputes: await tx.modPayoutsDispute.findMany({
        where: { createdAt: { gte: from, lt: to } },
        select: { tenantId: true, createdAt: true, currency: true, amount: true },
      }),
    }));

    const rows = new Map<string, Mutable<VolumeRow>>();
    const row = (tenantId: string, at: Date, currency: string) => {
      const day = at.toISOString().slice(0, 10);
      const key = `${day}|${tenantId}|${currency}`;
      let entry = rows.get(key);
      if (!entry) {
        entry = {
          tenantId,
          day,
          currency,
          gmv: 0,
          stripeFees: 0,
          platformFees: 0,
          refunds: 0,
          disputes: 0,
          salesCount: 0,
        };
        rows.set(key, entry);
      }
      return entry;
    };
    for (const sale of sales) {
      const entry = row(sale.tenantId, sale.chargedAt!, sale.currency!);
      entry.gmv += sale.gross ?? 0;
      entry.stripeFees += sale.stripeFee ?? 0;
      entry.platformFees += sale.platformFee ?? 0;
      entry.salesCount += 1;
    }
    for (const refund of refunds) {
      row(refund.tenantId, refund.createdAt, refund.currency).refunds += refund.amount;
    }
    for (const dispute of disputes) {
      row(dispute.tenantId, dispute.createdAt, dispute.currency).disputes += dispute.amount;
    }
    return [...rows.values()].sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        a.tenantId.localeCompare(b.tenantId) ||
        a.currency.localeCompare(b.currency),
    );
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
