/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PrismaClient } from '@didacta/database';
import type { PayoutsDbPort, PayoutsLogger } from './accounts.service.js';
import type { PlatformStripeEvent } from './account-events.js';
import type { PayoutsDebtsService } from './debts.service.js';
import type { PayoutsDisputesService } from './disputes.service.js';
import { idOf, routePlatformEvent, subscriptionIdFromInvoice } from './event-router.js';
import { recordCheckoutSale } from './handlers/checkout.js';
import { recordInvoiceSale } from './handlers/invoice.js';
import { registerSubscriptionChildren } from './handlers/subscription.js';
import type { PayoutsRefundsService } from './refunds.service.js';
import { findInvoiceOfCharge } from './stripe/invoice-shape.js';
import { computePlatformFee } from './money.js';
import { RefsService } from './refs.service.js';
import {
  PAYOUTS_ALERTS,
  type SettleSweepResult,
  type SettlementService,
} from './settlement.service.js';
import type { PlatformStripeClient } from './stripe/platform-stripe.client.js';

/**
 * Conciliador de cobros de plataforma (etapa E4). Red de seguridad de todo lo
 * que el webhook y la liquidación pueden perder; corre cada hora y una pasada
 * profunda al día (`payouts-reconcile.worker.ts`).
 *
 *  1. **Eventos perdidos.** Lista `GET /v1/events` de la ventana y reproduce
 *     los que no constan como procesados en `mod_payouts_webhook_event`, por
 *     el MISMO camino que el webhook (el host lo inyecta): un pedido cobrado
 *     cuyo `checkout.session.completed` nunca llegó recibe su acceso y su
 *     venta.
 *  2. **Ventas atascadas.** El barrido de liquidación (`AWAITING_FEE`,
 *     `READY`, `HELD` vencidas).
 *  3. **Cobros sin venta.** Lista `GET /v1/charges` de la ventana: un cargo
 *     cobrado en nombre de una cuenta conectada que no tiene fila de venta se
 *     anota si el registro lo atribuye (su sesión de checkout está registrada);
 *     si no, alerta. Un cargo sin `on_behalf_of` no es de un creador (p. ej.
 *     la facturación propia del operador) y se ignora.
 *  4. **Transferencias sin asiento.** Lista `GET /v1/transfers` de la
 *     ventana: la que no tiene venta ni asiento `TRANSFER` es una ALERTA. No
 *     se toca nunca: mover dinero por una transferencia que no hicimos
 *     nosotros es justo lo que no hay que hacer.
 *  5. **Invariantes del libro**, por venta y por cuenta y divisa (ver
 *     `ledger.service.ts`).
 *  6. **`balance_transaction` que no llega**: venta `AWAITING_FEE` con más de
 *     90 minutos → alerta.
 *
 * Nada de esto decide importes: lo que crea o avanza pasa por
 * `recordCheckoutSale` y `SettlementService`, que releen Stripe.
 *
 * Desde E5, el cargo de una factura de suscripción sin venta la crea
 * (`recordInvoiceSale`), con el tenant del registro de su suscripción.
 *
 * E6 (si el host pasa `losses`):
 *  7. **Reembolsos**: los listados en Stripe en la ventana se anotan (cubre
 *     un `charge.refunded` cuyo dinero falló al procesarse), y se completan
 *     los que quedaron a medias (`retryPending`). Valen igual para el cargo de
 *     una compra que para el de una factura de membresía: los dos tienen su
 *     venta con su `ch_`.
 *  8. **Disputas**: las nuevas de la ventana y TODAS las que siguen sin
 *     decidir se releen de Stripe (`disputes.sync`).
 *  9. **Deudas** (solo en la pasada profunda, una vez al día): recobro
 *     revirtiendo transferencias y aviso al operador de las grandes o viejas.
 */

export interface ReconcilerDeps {
  readonly db: PayoutsDbPort;
  readonly stripe: PlatformStripeClient;
  readonly settlement: SettlementService;
  /** Procesa un evento por el mismo camino que el webhook de plataforma. */
  readonly replayEvent: (event: PlatformStripeEvent) => Promise<{ readonly outcome: string }>;
  readonly logger?: PayoutsLogger;
  readonly now?: () => Date;
  /** Reembolsos, disputas y deudas (E6). Sin esto, esos pasos no se hacen. */
  readonly losses?: {
    readonly refunds: Pick<PayoutsRefundsService, 'syncCharge' | 'retryPending'>;
    readonly disputes: Pick<PayoutsDisputesService, 'sync' | 'listUnresolved'>;
    readonly debts: Pick<PayoutsDebtsService, 'recoverOpenDebts' | 'alertOldOrLargeDebts'>;
  };
}

export interface ReconcileOptions {
  /** Pasada profunda: ventana larga e invariantes de todas las ventas. */
  readonly deep: boolean;
  /** Horas hacia atrás. Por defecto 6 (horaria) o 72 (profunda). */
  readonly windowHours?: number;
  /** Tope de páginas de 100 por listado (protección). Por defecto 50. */
  readonly maxPages?: number;
}

export interface InvariantViolation {
  readonly kind: 'sale' | 'account_balance' | 'debt_balance';
  readonly tenantId: string;
  readonly accountId: string;
  readonly saleId?: string;
  readonly currency: string | null;
  readonly detail: string;
}

export interface ReconcileReport {
  readonly deep: boolean;
  readonly windowHours: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly events: {
    listed: number;
    replayed: number;
    failed: number;
    outcomes: Record<string, number>;
  };
  readonly sales: SettleSweepResult;
  readonly charges: {
    listed: number;
    withoutSale: number;
    created: number;
    unattributed: number;
    unhandled: number;
  };
  readonly transfers: { listed: number; unrecorded: number; inFlight: number; mismatched: number };
  readonly invariants: { salesChecked: number; violations: InvariantViolation[] };
  readonly lateBalanceTransactions: number;
  /** E6: reembolsos, disputas y deudas. `null` si el host no los pasa. */
  readonly losses: {
    readonly refunds: { listed: number; synced: number; retried: number; errors: number };
    readonly disputes: { checked: number; errors: number };
    readonly debts: {
      recovered: Array<{ currency: string; amount: number }>;
      alerts: number;
    } | null;
  } | null;
}

const LATE_BALANCE_TRANSACTION_MS = 90 * 60_000;
/** Una transferencia recién creada puede no estar anotada aún. */
const TRANSFER_IN_FLIGHT_MS = 15 * 60_000;
const MAX_REPORTED_VIOLATIONS = 100;

interface StripeList<T> {
  readonly data?: T[];
  readonly has_more?: boolean;
}

interface ChargeListItem {
  readonly id: string;
  readonly status?: string;
  readonly paid?: boolean;
  readonly on_behalf_of?: unknown;
  readonly payment_intent?: unknown;
  readonly invoice?: unknown;
}

interface TransferListItem {
  readonly id: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly destination?: unknown;
  readonly created?: number;
  readonly metadata?: Record<string, unknown> | null;
}

export class PayoutsReconcilerService {
  private readonly now: () => Date;

  constructor(private readonly deps: ReconcilerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async run(options: ReconcileOptions): Promise<ReconcileReport> {
    const started = this.now();
    const windowHours = options.windowHours ?? (options.deep ? 72 : 6);
    const since = Math.floor(started.getTime() / 1000) - windowHours * 3600;
    const maxPages = options.maxPages ?? 50;

    const events = await this.replayEvents(since, maxPages);
    const sales = await this.deps.settlement.sweep(200);
    const charges = await this.chargesWithoutSale(since, maxPages);
    const transfers = await this.transfersWithoutEntry(since, maxPages);
    const losses = await this.losses(since, maxPages, options.deep);
    const invariants = await this.checkInvariants(options.deep ? null : new Date(since * 1000));
    const lateBalanceTransactions = await this.lateBalanceTransactions();

    const report: ReconcileReport = {
      deep: options.deep,
      windowHours,
      startedAt: started.toISOString(),
      finishedAt: this.now().toISOString(),
      events,
      sales,
      charges,
      transfers,
      invariants,
      lateBalanceTransactions,
      losses,
    };
    this.deps.logger?.log?.(
      {
        deep: report.deep,
        windowHours,
        events: report.events,
        sales: report.sales,
        charges: report.charges,
        transfers: report.transfers,
        violations: report.invariants.violations.length,
        lateBalanceTransactions,
        losses,
      },
      'payouts.reconcile: pasada completada',
    );
    return report;
  }

  // ── 1. Eventos ─────────────────────────────────────────────────────────

  private async replayEvents(since: number, maxPages: number) {
    const listed = await this.listAll<PlatformStripeEvent>(
      '/v1/events',
      { created: { gte: since } },
      maxPages,
    );
    // Stripe lista del más nuevo al más viejo; se reproducen en el orden en
    // que ocurrieron (el `completed` antes que el `charge.updated`).
    const candidates = listed
      .filter((event) => {
        const route = routePlatformEvent(event);
        return route.kind === 'objects';
      })
      .reverse();
    let replayed = 0;
    let failed = 0;
    const outcomes: Record<string, number> = {};
    for (const event of candidates) {
      const row = await this.deps.db.global((tx) =>
        tx.modPayoutsWebhookEvent.findUnique({
          where: { stripeEventId: event.id },
          select: { processedAt: true },
        }),
      );
      if (row?.processedAt) continue;
      try {
        const result = await this.deps.replayEvent(event);
        replayed += 1;
        outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
      } catch (err) {
        failed += 1;
        this.alert(
          PAYOUTS_ALERTS.eventReplayFailed,
          { eventId: event.id, type: event.type, err: describe(err) },
          'no se pudo reproducir un evento (se reintenta en la próxima pasada)',
        );
      }
    }
    return { listed: listed.length, replayed, failed, outcomes };
  }

  // ── 3. Cobros sin venta ────────────────────────────────────────────────

  private async chargesWithoutSale(since: number, maxPages: number) {
    const charges = await this.listAll<ChargeListItem>(
      '/v1/charges',
      { created: { gte: since } },
      maxPages,
    );
    let withoutSale = 0;
    let created = 0;
    let unattributed = 0;
    let unhandled = 0;
    for (const charge of charges) {
      if (charge.status !== 'succeeded' || charge.paid !== true) continue;
      if (!idOf(charge.on_behalf_of)) continue;
      const existing = await this.deps.db.global((tx) =>
        tx.modPayoutsSale.findUnique({
          where: { stripeChargeId: charge.id },
          select: { id: true },
        }),
      );
      if (existing) continue;
      withoutSale += 1;

      const paymentIntentId = idOf(charge.payment_intent);
      const sessions =
        paymentIntentId && !idOf(charge.invoice)
          ? await this.deps.stripe.v1<StripeList<{ id?: unknown }>>(
              'GET',
              '/v1/checkout/sessions',
              { payment_intent: paymentIntentId, limit: 1 },
            )
          : null;
      const sessionId = idOf(sessions?.data?.[0]?.id);

      // E5: sin sesión de pago, puede ser el cargo de una factura de
      // suscripción (la sesión de una suscripción no tiene PaymentIntent) →
      // su venta SUBSCRIPTION_INVOICE.
      if (!sessionId) {
        const invoiceId = await findInvoiceOfCharge(this.deps.stripe, charge);
        if (invoiceId) {
          const invoiceSale = await this.invoiceSaleOfCharge(charge.id, invoiceId);
          if (invoiceSale === 'created') created += 1;
          else if (invoiceSale === 'unattributed') unattributed += 1;
          else if (invoiceSale === 'unhandled') unhandled += 1;
          continue;
        }
      }

      const ref = sessionId
        ? await this.deps.db.global((tx) =>
            new RefsService(tx as unknown as PrismaClient).find(sessionId),
          )
        : null;
      if (!ref || ref.kind !== 'checkout_session' || ref.source !== 'billing' || !ref.localRef) {
        unattributed += 1;
        this.alert(
          PAYOUTS_ALERTS.chargeUnattributed,
          {
            chargeId: charge.id,
            paymentIntentId,
            sessionId,
            onBehalfOf: idOf(charge.on_behalf_of),
          },
          'cargo en nombre de una cuenta conectada que el registro no atribuye a ningún aula',
        );
        continue;
      }
      try {
        const result = await recordCheckoutSale(
          { db: this.deps.db, stripe: this.deps.stripe },
          { tenantId: ref.tenantId, sessionId: ref.stripeObjectId, orderId: ref.localRef },
        );
        if (result.outcome === 'created') created += 1;
      } catch (err) {
        unattributed += 1;
        this.alert(
          PAYOUTS_ALERTS.chargeUnattributed,
          { chargeId: charge.id, sessionId, tenantId: ref.tenantId, err: describe(err) },
          'cargo atribuido cuya venta no se pudo anotar',
        );
      }
    }
    return { listed: charges.length, withoutSale, created, unattributed, unhandled };
  }

  /**
   * E5: el cargo sin venta es de una factura. El tenant sale del registro de
   * la suscripción (o, si nunca se registró, de su sesión de checkout de
   * origen, consultada a Stripe) y la venta la anota `recordInvoiceSale`, que
   * relee todo de la API.
   */
  private async invoiceSaleOfCharge(
    chargeId: string,
    invoiceId: string,
  ): Promise<'created' | 'exists' | 'unattributed' | 'unhandled'> {
    const invoice = await this.deps.stripe.v1<Record<string, unknown>>(
      'GET',
      `/v1/invoices/${encodeURIComponent(invoiceId)}`,
    );
    const subscriptionId = subscriptionIdFromInvoice(invoice);
    if (!subscriptionId) {
      this.alert(
        PAYOUTS_ALERTS.chargeUnhandled,
        { chargeId, invoiceId },
        'cargo de una factura sin suscripción (no es de ningún flujo de venta)',
      );
      return 'unhandled';
    }
    try {
      const findRef = (id: string) =>
        this.deps.db.global((tx) => new RefsService(tx as unknown as PrismaClient).find(id));
      let tenantId = (await findRef(subscriptionId))?.tenantId ?? null;
      if (!tenantId) {
        const sessions = await this.deps.stripe.v1<StripeList<{ id?: unknown }>>(
          'GET',
          '/v1/checkout/sessions',
          { subscription: subscriptionId, limit: 1 },
        );
        const sessionId = idOf(sessions.data?.[0]?.id);
        const sessionRef = sessionId ? await findRef(sessionId) : null;
        if (sessionRef) {
          const children = await registerSubscriptionChildren(
            { db: this.deps.db, stripe: this.deps.stripe },
            { tenantId: sessionRef.tenantId, sessionRef },
          );
          if (children.outcome === 'registered') tenantId = sessionRef.tenantId;
        }
      }
      if (!tenantId) {
        this.alert(
          PAYOUTS_ALERTS.chargeUnattributed,
          { chargeId, invoiceId, subscriptionId },
          'cargo de una factura cuya suscripción el registro no atribuye a ningún aula',
        );
        return 'unattributed';
      }
      const result = await recordInvoiceSale(
        { db: this.deps.db, stripe: this.deps.stripe },
        { tenantId, invoiceId },
      );
      if (result.outcome === 'created' || result.outcome === 'exists') return result.outcome;
      this.alert(
        PAYOUTS_ALERTS.chargeUnhandled,
        { chargeId, invoiceId, tenantId, outcome: result.outcome },
        'cargo cobrado de una factura que Stripe no da por cobrada',
      );
      return 'unhandled';
    } catch (err) {
      this.alert(
        PAYOUTS_ALERTS.chargeUnattributed,
        { chargeId, invoiceId, subscriptionId, err: describe(err) },
        'cargo de factura atribuido cuya venta no se pudo anotar',
      );
      return 'unattributed';
    }
  }

  // ── 4. Transferencias sin asiento ──────────────────────────────────────

  private async transfersWithoutEntry(since: number, maxPages: number) {
    const transfers = await this.listAll<TransferListItem>(
      '/v1/transfers',
      { created: { gte: since } },
      maxPages,
    );
    const nowMs = this.now().getTime();
    let unrecorded = 0;
    let inFlight = 0;
    let mismatched = 0;
    for (const transfer of transfers) {
      const known = await this.deps.db.global(async (tx) => ({
        sale: await tx.modPayoutsSale.findFirst({
          where: { stripeTransferId: transfer.id },
          select: { id: true, tenantId: true, transferAmount: true, currency: true },
        }),
        entry: await tx.modPayoutsLedgerEntry.findFirst({
          where: { stripeObjectId: transfer.id, type: 'TRANSFER' },
          select: { amount: true, currency: true },
        }),
      }));
      // Transferencia nueva de una disputa ganada (E6): sin venta propia, con asiento.
      if (!known.sale && known.entry) {
        if (
          known.entry.amount !== -(transfer.amount ?? NaN) ||
          known.entry.currency !== (transfer.currency ?? '').toLowerCase()
        ) {
          mismatched += 1;
          this.alert(
            PAYOUTS_ALERTS.transferMismatch,
            {
              transferId: transfer.id,
              stripeAmount: transfer.amount,
              ledgerAmount: known.entry.amount,
            },
            'la transferencia de Stripe no casa con su asiento (no se toca)',
          );
        }
        continue;
      }
      if (known.sale && known.entry) {
        if (
          known.entry.amount !== -(transfer.amount ?? NaN) ||
          known.entry.currency !== (transfer.currency ?? '').toLowerCase() ||
          known.sale.transferAmount !== transfer.amount
        ) {
          mismatched += 1;
          this.alert(
            PAYOUTS_ALERTS.transferMismatch,
            {
              transferId: transfer.id,
              saleId: known.sale.id,
              tenantId: known.sale.tenantId,
              stripeAmount: transfer.amount,
              ledgerAmount: known.entry.amount,
            },
            'la transferencia de Stripe no casa con su asiento (no se toca)',
          );
        }
        continue;
      }
      const metaSaleId = transfer.metadata?.['didacta_sale_id'];
      const recent =
        typeof transfer.created === 'number' &&
        nowMs - transfer.created * 1000 < TRANSFER_IN_FLIGHT_MS;
      if (recent && typeof metaSaleId === 'string') {
        inFlight += 1;
        continue;
      }
      unrecorded += 1;
      this.alert(
        PAYOUTS_ALERTS.transferUnrecorded,
        {
          transferId: transfer.id,
          amount: transfer.amount,
          currency: transfer.currency,
          destination: idOf(transfer.destination),
          saleId: typeof metaSaleId === 'string' ? metaSaleId : null,
        },
        'transferencia en Stripe sin venta ni asiento (no se toca)',
      );
    }
    return { listed: transfers.length, unrecorded, inFlight, mismatched };
  }

  // ── 7–9. Reembolsos, disputas y deudas (E6) ────────────────────────────

  private async losses(
    since: number,
    maxPages: number,
    deep: boolean,
  ): Promise<ReconcileReport['losses']> {
    const deps = this.deps.losses;
    if (!deps) return null;
    let errors = 0;
    const saleTenantOf = (chargeId: string) =>
      this.deps.db.global((tx) =>
        tx.modPayoutsSale.findUnique({
          where: { stripeChargeId: chargeId },
          select: { tenantId: true },
        }),
      );

    // Reembolsos de la ventana: cada cargo con venta se pone al día.
    const refunds = await this.listAll<{ id: string; charge?: unknown }>(
      '/v1/refunds',
      { created: { gte: since } },
      maxPages,
    );
    const charges = [
      ...new Set(refunds.map((r) => idOf(r.charge)).filter((id): id is string => !!id)),
    ];
    let synced = 0;
    for (const chargeId of charges) {
      const sale = await saleTenantOf(chargeId);
      if (!sale) continue;
      try {
        await deps.refunds.syncCharge(sale.tenantId, chargeId);
        synced += 1;
      } catch (err) {
        errors += 1;
        this.deps.logger?.warn(
          { chargeId, tenantId: sale.tenantId, err: describe(err) },
          'payouts.reconcile: no se pudieron poner al día los reembolsos de un cargo',
        );
      }
    }
    const retried = await deps.refunds.retryPending();
    errors += retried.errors;

    // Disputas: las nuevas de la ventana (si su cargo tiene venta) y las abiertas.
    const disputes = await this.listAll<{ id: string; charge?: unknown }>(
      '/v1/disputes',
      { created: { gte: since } },
      maxPages,
    );
    const toSync = new Map<string, string>();
    for (const dispute of disputes) {
      const chargeId = idOf(dispute.charge);
      if (!chargeId) continue;
      const sale = await saleTenantOf(chargeId);
      if (sale) toSync.set(dispute.id, sale.tenantId);
    }
    for (const open of await deps.disputes.listUnresolved()) {
      toSync.set(open.stripeDisputeId, open.tenantId);
    }
    let disputeErrors = 0;
    for (const [disputeId, tenantId] of toSync) {
      try {
        await deps.disputes.sync(tenantId, disputeId);
      } catch (err) {
        disputeErrors += 1;
        this.deps.logger?.warn(
          { disputeId, tenantId, err: describe(err) },
          'payouts.reconcile: no se pudo poner al día una disputa',
        );
      }
    }

    // Deudas: una vez al día.
    let debts: { recovered: Array<{ currency: string; amount: number }>; alerts: number } | null =
      null;
    if (deep) {
      const recovery = await deps.debts.recoverOpenDebts();
      const alerts = await deps.debts.alertOldOrLargeDebts();
      debts = { recovered: recovery.recovered, alerts: alerts.alerts };
    }
    return {
      refunds: { listed: refunds.length, synced, retried: retried.accounted, errors },
      disputes: { checked: toSync.size, errors: disputeErrors },
      debts,
    };
  }

  // ── 5. Invariantes ─────────────────────────────────────────────────────

  /**
   * @param updatedSince `null` = todas las ventas (pasada profunda); si no,
   *   las tocadas desde entonces. Los saldos por cuenta se miran siempre.
   */
  async checkInvariants(
    updatedSince: Date | null,
  ): Promise<{ salesChecked: number; violations: InvariantViolation[] }> {
    const violations: InvariantViolation[] = [];
    const data = await this.deps.db.global(async (tx) => {
      const sales = await tx.modPayoutsSale.findMany({
        where: {
          transferAmount: { not: null },
          status: { in: ['READY', 'HELD', 'TRANSFERRED', 'SETTLED_NETTED'] },
          ...(updatedSince ? { updatedAt: { gte: updatedSince } } : {}),
        },
        select: {
          id: true,
          tenantId: true,
          accountId: true,
          status: true,
          currency: true,
          gross: true,
          stripeFee: true,
          feeBpsApplied: true,
          platformFee: true,
          creatorNet: true,
          debtNetted: true,
          transferAmount: true,
          stripeTransferId: true,
        },
      });
      // Solo los asientos del REPARTO de la venta: los de reembolsos, disputas
      // y recobros (E6) van en grupos aparte que suman 0 por sí mismos.
      const entries = sales.length
        ? await tx.modPayoutsLedgerEntry.groupBy({
            by: ['saleId', 'type'],
            where: {
              saleId: { in: sales.map((s) => s.id) },
              OR: [
                { idempotencyKey: { startsWith: 'payouts:sale:' } },
                { idempotencyKey: { startsWith: 'payouts:transfer:' } },
                { type: 'DEBT_RECOVERED', idempotencyKey: { contains: ':sale:' } },
              ],
            },
            _sum: { amount: true },
            orderBy: [{ saleId: 'asc' }, { type: 'asc' }],
          })
        : [];
      const balances = await tx.modPayoutsLedgerEntry.groupBy({
        by: ['tenantId', 'accountId', 'currency'],
        _sum: { amount: true },
        orderBy: [{ tenantId: 'asc' }, { accountId: 'asc' }, { currency: 'asc' }],
      });
      const debtEntries = await tx.modPayoutsLedgerEntry.groupBy({
        by: ['tenantId', 'accountId', 'currency'],
        where: { type: { in: ['DEBT_CREATED', 'DEBT_RECOVERED'] } },
        _sum: { amount: true },
        orderBy: [{ tenantId: 'asc' }, { accountId: 'asc' }, { currency: 'asc' }],
      });
      const pending = await tx.modPayoutsSale.groupBy({
        by: ['tenantId', 'accountId', 'currency'],
        where: { status: { in: ['READY', 'HELD'] }, transferAmount: { not: null } },
        _sum: { transferAmount: true },
        orderBy: [{ tenantId: 'asc' }, { accountId: 'asc' }, { currency: 'asc' }],
      });
      const debts = await tx.modPayoutsDebt.groupBy({
        by: ['tenantId', 'accountId', 'currency'],
        where: { status: 'OPEN' },
        _sum: { amountOutstanding: true },
        orderBy: [{ tenantId: 'asc' }, { accountId: 'asc' }, { currency: 'asc' }],
      });
      return { sales, entries, balances, debtEntries, pending, debts };
    });

    // Por venta.
    const bySale = new Map<string, Map<string, number>>();
    for (const entry of data.entries) {
      if (!entry.saleId) continue;
      const types = bySale.get(entry.saleId) ?? new Map<string, number>();
      types.set(entry.type, Number(entry._sum.amount ?? 0));
      bySale.set(entry.saleId, types);
    }
    for (const sale of data.sales) {
      const problems: string[] = [];
      const gross = sale.gross ?? 0;
      const fee = sale.stripeFee ?? 0;
      const platformFee = sale.platformFee ?? 0;
      const net = sale.creatorNet ?? 0;
      const transfer = sale.transferAmount ?? 0;
      if (gross - fee - platformFee !== net) problems.push(`bruto − comisiones ≠ neto (${net})`);
      if (net !== transfer + sale.debtNetted) problems.push(`neto ≠ transferencia + deuda`);
      if (
        sale.feeBpsApplied !== null &&
        computePlatformFee(gross, sale.feeBpsApplied) !== platformFee
      ) {
        problems.push(`comisión del operador ≠ ${sale.feeBpsApplied} pb del bruto`);
      }
      const types = bySale.get(sale.id) ?? new Map<string, number>();
      const expect = (type: string, value: number) => {
        const actual = types.get(type) ?? 0;
        if (actual !== value) problems.push(`asiento ${type} ${actual} ≠ ${value}`);
      };
      expect('SALE_GROSS', gross);
      expect('STRIPE_FEE', -fee);
      expect('PLATFORM_FEE', -platformFee);
      expect('DEBT_RECOVERED', -sale.debtNetted);
      expect('TRANSFER', sale.status === 'TRANSFERRED' ? -transfer : 0);
      if (sale.status === 'TRANSFERRED' && !sale.stripeTransferId) {
        problems.push('transferida sin id de transferencia');
      }
      if (problems.length > 0) {
        violations.push({
          kind: 'sale',
          tenantId: sale.tenantId,
          accountId: sale.accountId,
          saleId: sale.id,
          currency: sale.currency,
          detail: problems.join('; '),
        });
      }
    }

    // Por cuenta y divisa.
    const key = (g: { tenantId: string; accountId: string; currency: string | null }) =>
      `${g.tenantId}|${g.accountId}|${g.currency ?? ''}`;
    const pendingBy = new Map(
      data.pending.map((g) => [key(g), Number(g._sum.transferAmount ?? 0)]),
    );
    const debtBy = new Map(data.debts.map((g) => [key(g), Number(g._sum.amountOutstanding ?? 0)]));
    const debtEntriesBy = new Map(
      data.debtEntries.map((g) => [key(g), Number(g._sum.amount ?? 0)]),
    );
    const accounts = new Set([
      ...data.balances.map(key),
      ...pendingBy.keys(),
      ...debtBy.keys(),
      ...debtEntriesBy.keys(),
    ]);
    const balanceBy = new Map(data.balances.map((g) => [key(g), Number(g._sum.amount ?? 0)]));
    for (const k of accounts) {
      const [tenantId, accountId, currency] = k.split('|') as [string, string, string];
      const balance = balanceBy.get(k) ?? 0;
      const owed = pendingBy.get(k) ?? 0;
      if (balance !== owed) {
        violations.push({
          kind: 'account_balance',
          tenantId,
          accountId,
          currency,
          detail: `libro ${balance} ≠ pendiente de transferir ${owed}`,
        });
      }
      const debtLedger = debtEntriesBy.get(k) ?? 0;
      const debtOpen = debtBy.get(k) ?? 0;
      if (debtLedger !== debtOpen) {
        violations.push({
          kind: 'debt_balance',
          tenantId,
          accountId,
          currency,
          detail: `asientos de deuda ${debtLedger} ≠ deuda abierta ${debtOpen}`,
        });
      }
    }

    for (const violation of violations.slice(0, MAX_REPORTED_VIOLATIONS)) {
      this.alert(PAYOUTS_ALERTS.ledgerInvariant, { ...violation }, 'el libro no cuadra');
    }
    return {
      salesChecked: data.sales.length,
      violations: violations.slice(0, MAX_REPORTED_VIOLATIONS),
    };
  }

  // ── 6. `balance_transaction` que no llega ──────────────────────────────

  private async lateBalanceTransactions(): Promise<number> {
    const limit = new Date(this.now().getTime() - LATE_BALANCE_TRANSACTION_MS);
    const late = await this.deps.db.global((tx) =>
      tx.modPayoutsSale.findMany({
        where: { status: 'AWAITING_FEE', chargedAt: { lt: limit } },
        select: { id: true, tenantId: true, stripeChargeId: true, chargedAt: true },
        take: MAX_REPORTED_VIOLATIONS,
      }),
    );
    for (const sale of late) {
      this.alert(
        PAYOUTS_ALERTS.balanceTransactionLate,
        {
          saleId: sale.id,
          tenantId: sale.tenantId,
          chargeId: sale.stripeChargeId,
          chargedAt: sale.chargedAt?.toISOString(),
        },
        'cobro de hace más de 90 minutos sin comisión de Stripe asentada',
      );
    }
    return late.length;
  }

  // ── Utilidades ─────────────────────────────────────────────────────────

  private async listAll<T extends { id: string }>(
    path: string,
    params: Record<string, unknown>,
    maxPages: number,
  ): Promise<T[]> {
    const out: T[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const list = await this.deps.stripe.v1<StripeList<T>>('GET', path, {
        ...params,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      const data = list.data ?? [];
      out.push(...data);
      if (!list.has_more || data.length === 0) return out;
      startingAfter = data[data.length - 1]!.id;
    }
    this.deps.logger?.warn(
      { path, pages: maxPages },
      'payouts.reconcile: listado cortado por el tope de páginas (ventana demasiado grande)',
    );
    return out;
  }

  private alert(alert: string, obj: Record<string, unknown>, msg: string): void {
    const logger = this.deps.logger;
    if (!logger) return;
    (logger.error ?? logger.warn).call(logger, { alert, ...obj }, `${alert}: ${msg}`);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
