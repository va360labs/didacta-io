/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PayoutsDbPort, PayoutsLogger } from '../accounts.service.js';
import { idOf } from '../event-router.js';
import { PAYOUTS_ALERTS } from '../settlement.service.js';
import type { PlatformStripeClient } from '../stripe/platform-stripe.client.js';

/**
 * `transfer.created`, `transfer.updated`, `transfer.reversed` (etapa E4):
 * SOLO comprobación. Ninguno mueve dinero ni cambia una venta.
 *
 * Las transferencias las crea la liquidación; el evento llega después (o, a
 * veces, antes de que la liquidación haya anotado la suya). Aquí se relee la
 * transferencia de la API y se coteja con la venta y el libro: importe,
 * divisa, cuenta de destino y lo revertido. Lo que no casa es una alerta para
 * un humano: una transferencia que no hicimos nosotros, o una reversión hecha
 * a mano en el panel de Stripe.
 *
 * E6: la transferencia NUEVA de una disputa ganada no es la de la venta: se
 * coteja con su asiento (`payouts:reinstate:…`). Y una reversión que Stripe ya
 * avisa pero aún se está anotando (reembolso o disputa en curso) no es una
 * discrepancia: se da por «en vuelo».
 */

export const TRANSFER_EVENT_TYPES: ReadonlySet<string> = new Set([
  'transfer.created',
  'transfer.updated',
  'transfer.reversed',
]);

export type TransferCheckOutcome =
  | { readonly outcome: 'ok'; readonly saleId: string }
  /** La liquidación aún no la ha anotado (está en vuelo): no es un fallo. */
  | { readonly outcome: 'in_flight'; readonly saleId: string }
  /** Ninguna venta de este tenant la respalda. */
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'mismatch'; readonly saleId: string; readonly problems: string[] }
  | { readonly outcome: 'ignored' };

interface TransferFromApi {
  readonly id: string;
  readonly amount?: number;
  readonly amount_reversed?: number;
  readonly currency?: string;
  readonly destination?: unknown;
  readonly metadata?: Record<string, unknown> | null;
}

export async function checkTransferEvent(
  deps: {
    readonly db: PayoutsDbPort;
    readonly stripe: PlatformStripeClient;
    readonly logger?: PayoutsLogger;
  },
  input: {
    readonly tenantId: string;
    readonly eventType: string;
    readonly transferId: string | null;
  },
): Promise<TransferCheckOutcome> {
  if (!TRANSFER_EVENT_TYPES.has(input.eventType) || !input.transferId) {
    return { outcome: 'ignored' };
  }
  const transfer = await deps.stripe.v1<TransferFromApi>(
    'GET',
    `/v1/transfers/${encodeURIComponent(input.transferId)}`,
  );
  const metaSaleId =
    typeof transfer.metadata?.['didacta_sale_id'] === 'string'
      ? (transfer.metadata['didacta_sale_id'] as string)
      : null;

  // Transferencia de una disputa ganada: se coteja con su propio asiento.
  if (typeof transfer.metadata?.['didacta_dispute_id'] === 'string') {
    const entry = await deps.db.inTenant(input.tenantId, (tx) =>
      tx.modPayoutsLedgerEntry.findFirst({
        where: { tenantId: input.tenantId, stripeObjectId: transfer.id, type: 'TRANSFER' },
        select: { amount: true, currency: true, saleId: true },
      }),
    );
    if (!entry) return { outcome: 'in_flight', saleId: metaSaleId ?? '' };
    if (
      entry.amount !== -(transfer.amount ?? NaN) ||
      entry.currency !== (transfer.currency ?? '').toLowerCase()
    ) {
      const problems = [`importe ${String(transfer.amount)} ≠ asiento ${-entry.amount}`];
      (deps.logger?.error ?? deps.logger?.warn)?.call(
        deps.logger,
        {
          alert: PAYOUTS_ALERTS.transferMismatch,
          tenantId: input.tenantId,
          transferId: transfer.id,
          problems,
        },
        `${PAYOUTS_ALERTS.transferMismatch}: la transferencia de la disputa no casa con su asiento`,
      );
      return { outcome: 'mismatch', saleId: entry.saleId ?? '', problems };
    }
    return { outcome: 'ok', saleId: entry.saleId ?? '' };
  }

  const found = await deps.db.inTenant(input.tenantId, async (tx) => {
    const sale =
      (await tx.modPayoutsSale.findFirst({
        where: { tenantId: input.tenantId, stripeTransferId: transfer.id },
      })) ??
      (metaSaleId && /^[0-9a-f-]{36}$/i.test(metaSaleId)
        ? await tx.modPayoutsSale.findFirst({ where: { tenantId: input.tenantId, id: metaSaleId } })
        : null);
    if (!sale) return null;
    const account = await tx.modPayoutsAccount.findFirst({
      where: { id: sale.accountId, tenantId: input.tenantId },
      select: { stripeAccountId: true },
    });
    // Reembolsos o disputas de la venta que aún se están anotando (E6).
    const accounting =
      (await tx.modPayoutsRefund.count({
        where: { tenantId: input.tenantId, saleId: sale.id, reversalStatus: null },
      })) +
      (await tx.modPayoutsDispute.count({
        where: { tenantId: input.tenantId, saleId: sale.id, outcome: null },
      }));
    return { sale, destination: account?.stripeAccountId ?? null, accounting };
  });

  const warn = (alert: string, obj: Record<string, unknown>, msg: string) =>
    (deps.logger?.error ?? deps.logger?.warn)?.call(
      deps.logger,
      { alert, ...obj },
      `${alert}: ${msg}`,
    );

  if (!found) {
    warn(
      PAYOUTS_ALERTS.transferUnrecorded,
      { tenantId: input.tenantId, transferId: transfer.id, eventType: input.eventType },
      'transferencia de plataforma sin venta que la respalde (no se toca)',
    );
    return { outcome: 'unknown' };
  }
  const { sale, destination, accounting } = found;
  if (sale.stripeTransferId !== transfer.id) {
    // La liquidación la está anotando ahora mismo (la creó y aún no cerró su
    // transacción), o la anotará el próximo intento al encontrarla en Stripe.
    if (sale.stripeTransferId === null && (sale.status === 'READY' || sale.status === 'HELD')) {
      return { outcome: 'in_flight', saleId: sale.id };
    }
  }

  const problems: string[] = [];
  if (sale.stripeTransferId !== transfer.id) {
    problems.push(`la venta tiene la transferencia ${String(sale.stripeTransferId)}`);
  }
  if (transfer.amount !== sale.transferAmount) {
    problems.push(`importe ${String(transfer.amount)} ≠ ${String(sale.transferAmount)}`);
  }
  if ((transfer.currency ?? '').toLowerCase() !== sale.currency) {
    problems.push(`divisa ${String(transfer.currency)} ≠ ${String(sale.currency)}`);
  }
  if (idOf(transfer.destination) !== destination) {
    problems.push(`destino ${String(idOf(transfer.destination))} ≠ ${String(destination)}`);
  }
  const reversedInStripe = transfer.amount_reversed ?? 0;
  if (reversedInStripe > sale.reversedAmount && accounting > 0 && problems.length === 0) {
    return { outcome: 'in_flight', saleId: sale.id };
  }
  if (reversedInStripe !== sale.reversedAmount) {
    problems.push(
      `revertido en Stripe ${String(transfer.amount_reversed ?? 0)} ≠ anotado ${sale.reversedAmount}`,
    );
  }
  if (problems.length > 0) {
    warn(
      PAYOUTS_ALERTS.transferMismatch,
      { tenantId: input.tenantId, saleId: sale.id, transferId: transfer.id, problems },
      'la transferencia de Stripe no casa con la venta (no se toca)',
    );
    return { outcome: 'mismatch', saleId: sale.id, problems };
  }
  return { outcome: 'ok', saleId: sale.id };
}
