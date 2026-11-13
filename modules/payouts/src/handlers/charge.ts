/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { PayoutsDbPort } from '../accounts.service.js';
import type { SettleOutcome, SettlementService } from '../settlement.service.js';

/**
 * Eventos del cargo (`charge.succeeded`, `charge.updated`) → liquidación
 * (etapa E4).
 *
 * El `balance_transaction` del cargo (la comisión real de Stripe) llega vacío
 * al cobrar y se rellena segundos u horas después: Stripe lo avisa con
 * `charge.updated`. El evento es solo un AVISO: no se lee de él ni un importe.
 * La liquidación relee el cargo de la API y decide.
 *
 * `charge.refunded` NO pasa por aquí: los reembolsos (reversión de la
 * transferencia, deuda) son de E6 (`handlers/refund.ts`). Si el cargo ya está
 * reembolsado cuando llega a liquidarse, la liquidación lo retiene (`HELD`,
 * `charge_refunded`) en vez de transferir.
 */

export const SETTLEMENT_TRIGGER_EVENT_TYPES: ReadonlySet<string> = new Set([
  'charge.succeeded',
  'charge.updated',
]);

export type ChargeEventOutcome =
  /** Aún no hay venta de este cargo: la creará el checkout (o el conciliador). */
  | { readonly outcome: 'no_sale' }
  | { readonly outcome: 'ignored' }
  | { readonly outcome: 'settled'; readonly result: SettleOutcome };

export async function handleChargeEvent(
  deps: { readonly db: PayoutsDbPort; readonly settlement: SettlementService },
  input: {
    readonly tenantId: string;
    readonly eventType: string;
    readonly chargeId: string | null;
  },
): Promise<ChargeEventOutcome> {
  if (!SETTLEMENT_TRIGGER_EVENT_TYPES.has(input.eventType) || !input.chargeId) {
    return { outcome: 'ignored' };
  }
  const chargeId = input.chargeId;
  const sale = await deps.db.inTenant(input.tenantId, (tx) =>
    tx.modPayoutsSale.findFirst({
      where: { tenantId: input.tenantId, stripeChargeId: chargeId },
      select: { id: true },
    }),
  );
  if (!sale) return { outcome: 'no_sale' };
  const result = await deps.settlement.settleSale(input.tenantId, sale.id, { force: true });
  return { outcome: 'settled', result };
}
