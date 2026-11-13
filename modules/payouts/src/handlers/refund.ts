/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { idOf } from '../event-router.js';
import type { PayoutsRefundsService } from '../refunds.service.js';

/**
 * `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`
 * (etapa E6) → `PayoutsRefundsService.syncCharge`.
 *
 * El evento solo dice QUÉ cargo mirar. Los importes y el estado se releen de
 * la API (`GET /v1/refunds?charge=…`): un reembolso hecho a mano en el panel
 * de Stripe se detecta así, se da de alta y se anota igual que uno pedido
 * desde Didacta (reversión, asientos, deuda).
 *
 * La retirada del acceso del alumno no es de aquí: el mismo `charge.refunded`
 * sigue hacia `mod.billing` por el reparto a módulos, como siempre.
 */

export const REFUND_EVENT_TYPES: ReadonlySet<string> = new Set([
  'charge.refunded',
  'refund.created',
  'refund.updated',
  'refund.failed',
]);

export type RefundEventOutcome =
  | { readonly outcome: 'ignored' }
  | { readonly outcome: 'no_sale' }
  | { readonly outcome: 'synced'; readonly refunds: number; readonly accounted: number };

export async function handleRefundEvent(
  deps: { readonly refunds: Pick<PayoutsRefundsService, 'syncCharge'> },
  input: {
    readonly tenantId: string;
    readonly eventType: string;
    readonly object: Record<string, unknown>;
  },
): Promise<RefundEventOutcome> {
  if (!REFUND_EVENT_TYPES.has(input.eventType)) return { outcome: 'ignored' };
  const chargeId =
    input.eventType === 'charge.refunded' ? idOf(input.object['id']) : idOf(input.object['charge']);
  if (!chargeId || (!chargeId.startsWith('ch_') && !chargeId.startsWith('py_'))) {
    return { outcome: 'ignored' };
  }
  return deps.refunds.syncCharge(input.tenantId, chargeId);
}
