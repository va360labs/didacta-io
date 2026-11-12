/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import type { DisputeSyncOutcome, PayoutsDisputesService } from '../disputes.service.js';
import { idOf } from '../event-router.js';

/**
 * `charge.dispute.created`, `.funds_withdrawn`, `.funds_reinstated`,
 * `.closed` (etapa E6) → `PayoutsDisputesService.sync`.
 *
 * Los cuatro hacen lo mismo: releer la disputa de la API (con sus
 * `balance_transactions`, que traen los importes REALES de la retirada y de la
 * devolución) y llevar nuestro estado hasta el de Stripe. El tipo del evento
 * no decide nada: si `closed` llega antes que `funds_withdrawn`, el resultado
 * es el mismo.
 */

export const DISPUTE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
  'charge.dispute.closed',
]);

export type DisputeEventOutcome = { readonly outcome: 'ignored' } | DisputeSyncOutcome;

export async function handleDisputeEvent(
  deps: { readonly disputes: Pick<PayoutsDisputesService, 'sync'> },
  input: {
    readonly tenantId: string;
    readonly eventType: string;
    readonly object: Record<string, unknown>;
  },
): Promise<DisputeEventOutcome> {
  if (!DISPUTE_EVENT_TYPES.has(input.eventType)) return { outcome: 'ignored' };
  const disputeId = idOf(input.object['id']);
  if (!disputeId) return { outcome: 'ignored' };
  return deps.disputes.sync(input.tenantId, disputeId);
}
