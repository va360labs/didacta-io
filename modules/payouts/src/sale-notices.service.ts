/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type {
  PayoutScheduleView,
  PayoutsDbPort,
  PayoutsLogger,
  PayoutsTx,
} from './accounts.service.js';
import { SILENT_NOTIFIER, type PayoutsNotifier, type SaleNoticeKind } from './losses.js';
import { estimatePayoutDate } from './reports.service.js';
import { TAX_PROFILE_HOLD_REASON } from './tax/tax-profile.service.js';

/**
 * Aviso de VENTA a quien administra el aula (ensayo general de Cloud: la
 * creadora no se enteraba de que había vendido hasta que abría «Ventas»).
 *
 * Una vez por venta, pase lo que pase:
 *  - El sello es `mod_payouts_sale.creator_notified_at`. Quien avisa primero lo
 *    reclama con `UPDATE … WHERE creator_notified_at IS NULL`; una reentrega
 *    del webhook, el barrido o el conciliador encuentran la venta sellada y no
 *    vuelven a avisar. Si el correo falla después de sellar, no se reintenta:
 *    preferimos un aviso de menos a dos avisos de la misma venta.
 *  - Lo dispara el webhook en cuanto la venta se anota y el acceso del alumno
 *    está dado (así ya existe su cuenta y se le puede nombrar), y lo recoge el
 *    barrido de la liquidación para las ventas que anotó el conciliador.
 *  - El barrido solo mira las ventas del último día: las que existían antes de
 *    que hubiera aviso nacen selladas (migración), y una venta vieja sin sello
 *    no debe disparar un correo días después.
 *
 * Qué se vendió: un curso (`ORDER`), el alta en una membresía o una renovación
 * (`SUBSCRIPTION_INVOICE`: renovación si la misma suscripción ya tenía una
 * venta anterior).
 */

export interface SaleNoticesServiceOptions {
  readonly notifier?: PayoutsNotifier;
  /** ¿Se retienen ahora las transferencias de este aula por los datos fiscales? */
  readonly taxGate?: { transferBlockReason(tenantId: string): Promise<string | null> } | null;
  readonly logger?: PayoutsLogger;
  readonly now?: () => Date;
  /** Hasta qué antigüedad recoge el barrido una venta sin avisar (por defecto, 24 h). */
  readonly sweepWindowMs?: number;
}

export type SaleNoticeOutcome = 'sent' | 'already' | 'not_found';

const SILENT: PayoutsLogger = { warn: () => undefined };
const DAY_MS = 24 * 60 * 60 * 1000;

export class PayoutsSaleNoticesService {
  private readonly notifier: PayoutsNotifier;
  private readonly taxGate: SaleNoticesServiceOptions['taxGate'];
  private readonly logger: PayoutsLogger;
  private readonly now: () => Date;
  private readonly sweepWindowMs: number;

  constructor(
    private readonly db: PayoutsDbPort,
    options: SaleNoticesServiceOptions = {},
  ) {
    this.notifier = options.notifier ?? SILENT_NOTIFIER;
    this.taxGate = options.taxGate ?? null;
    this.logger = options.logger ?? SILENT;
    this.now = options.now ?? (() => new Date());
    this.sweepWindowMs = options.sweepWindowMs ?? DAY_MS;
  }

  /** Avisa de UNA venta si nadie lo ha hecho todavía. Nunca lanza por el aviso. */
  async notify(tenantId: string, saleId: string): Promise<SaleNoticeOutcome> {
    const claimed = await this.db.inTenant(tenantId, async (tx) => {
      const { count } = await tx.modPayoutsSale.updateMany({
        where: { id: saleId, tenantId, creatorNotifiedAt: null },
        data: { creatorNotifiedAt: this.now() },
      });
      const sale = await tx.modPayoutsSale.findFirst({
        where: { id: saleId, tenantId },
        select: {
          id: true,
          accountId: true,
          sourceKind: true,
          sourceRef: true,
          description: true,
          presentmentAmount: true,
          presentmentCurrency: true,
          buyerEmail: true,
          stripeInvoiceId: true,
          chargedAt: true,
          createdAt: true,
          currency: true,
          gross: true,
          stripeFee: true,
          platformFee: true,
          feeBpsApplied: true,
          debtNetted: true,
          creatorNet: true,
          transferAmount: true,
          status: true,
          availableOn: true,
        },
      });
      if (!sale) return { outcome: 'not_found' as const };
      if (count === 0) return { outcome: 'already' as const };
      // Calendario de pagos del creador, para decir hacia qué día llega.
      const account = await tx.modPayoutsAccount.findFirst({
        where: { id: sale.accountId, tenantId },
        select: { payoutSchedule: true },
      });
      return {
        outcome: 'claimed' as const,
        sale,
        kind: await saleKind(tx, tenantId, sale),
        schedule: (account?.payoutSchedule as PayoutScheduleView | null | undefined) ?? null,
      };
    });
    if (claimed.outcome !== 'claimed') return claimed.outcome;

    const { sale, kind, schedule } = claimed;
    let heldForTaxData = false;
    try {
      heldForTaxData =
        (await this.taxGate?.transferBlockReason(tenantId)) === TAX_PROFILE_HOLD_REASON;
    } catch {
      // Sin poder leerlo, el aviso sale igual (sin la línea de los datos fiscales).
    }
    try {
      await this.notifier.saleMade?.({
        tenantId,
        saleId: sale.id,
        kind,
        description: sale.description,
        amount: sale.presentmentAmount,
        currency: sale.presentmentCurrency,
        buyerEmail: sale.buyerEmail,
        heldForTaxData,
        sourceRef: sale.sourceRef,
        chargedAt: sale.chargedAt ?? sale.createdAt,
        split: {
          currency: sale.currency,
          gross: sale.gross,
          stripeFee: sale.stripeFee,
          platformFee: sale.platformFee,
          feeBpsApplied: sale.feeBpsApplied,
          debtNetted: sale.debtNetted,
          creatorNet: sale.creatorNet,
          transferAmount: sale.transferAmount,
          status: sale.status,
          estimatedArrival:
            sale.status === 'READY' || sale.status === 'TRANSFERRED'
              ? estimatePayoutDate(sale.availableOn, schedule)
              : null,
        },
      });
    } catch (err) {
      this.logger.warn(
        { tenantId, saleId, err: err instanceof Error ? err.message : String(err) },
        'payouts.sale_notice: el aviso de la venta no salió (no se reintenta)',
      );
    }
    return 'sent';
  }

  /**
   * Ventas recientes sin avisar, de todas las aulas (acceso global sancionado
   * para encontrarlas; cada una se avisa con su tenant). Las anota el
   * conciliador, o el webhook murió entre anotar y avisar.
   */
  async sweep(limit = 50): Promise<{ checked: number; sent: number; errors: number }> {
    const since = new Date(this.now().getTime() - this.sweepWindowMs);
    const pending = await this.db.global((tx) =>
      tx.modPayoutsSale.findMany({
        where: { creatorNotifiedAt: null, createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: { id: true, tenantId: true },
      }),
    );
    let sent = 0;
    let errors = 0;
    for (const row of pending) {
      try {
        if ((await this.notify(row.tenantId, row.id)) === 'sent') sent += 1;
      } catch (err) {
        errors += 1;
        this.logger.warn(
          {
            tenantId: row.tenantId,
            saleId: row.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'payouts.sale_notice: no se pudo avisar de una venta (se reintenta en el barrido)',
        );
      }
    }
    return { checked: pending.length, sent, errors };
  }
}

/**
 * Curso, alta o renovación. Una factura de suscripción es renovación si la
 * MISMA suscripción ya tenía una venta cobrada antes (el registro de objetos
 * cuelga cada factura de su `sub_…`).
 */
async function saleKind(
  tx: PayoutsTx,
  tenantId: string,
  sale: {
    readonly sourceKind: string;
    readonly stripeInvoiceId: string | null;
    readonly chargedAt: Date | null;
    readonly createdAt: Date;
  },
): Promise<SaleNoticeKind> {
  if (sale.sourceKind !== 'SUBSCRIPTION_INVOICE') return 'course';
  if (!sale.stripeInvoiceId) return 'membership';
  const invoiceRef = await tx.modPayoutsObjectRef.findFirst({
    where: { tenantId, stripeObjectId: sale.stripeInvoiceId },
    select: { parentObjectId: true },
  });
  if (!invoiceRef?.parentObjectId) return 'membership';
  const siblings = await tx.modPayoutsObjectRef.findMany({
    where: {
      tenantId,
      kind: 'invoice',
      parentObjectId: invoiceRef.parentObjectId,
      NOT: { stripeObjectId: sale.stripeInvoiceId },
    },
    select: { stripeObjectId: true },
    take: 100,
  });
  if (siblings.length === 0) return 'membership';
  const when = sale.chargedAt ?? sale.createdAt;
  const earlier = await tx.modPayoutsSale.count({
    where: {
      tenantId,
      stripeInvoiceId: { in: siblings.map((s) => s.stripeObjectId) },
      OR: [{ chargedAt: { lt: when } }, { chargedAt: null, createdAt: { lt: when } }],
    },
  });
  return earlier > 0 ? 'renewal' : 'membership';
}
