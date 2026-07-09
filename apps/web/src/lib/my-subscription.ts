'use client';

/**
 * Cliente HTTP self-service de mod.payment-connections para el usuario final.
 *
 * - GET  /api/v1/modules/payment-connections/me/subscription   → mi suscripción externa
 * - POST /api/v1/modules/payment-connections/me/billing-portal → sesión de Customer Portal
 *
 * Distinto de mod.subscriptions (suscripción recurrente propia de Didacta):
 * esto es la suscripción del usuario en la cuenta de pago EXTERNA del tenant
 * (Stripe/PayPal/Woo), materializada por el sync.
 */

import { apiFetch } from '@/lib/api-client';

export interface MySubscriptionItem {
  /** Id de la fila de suscriptor (se pasa al abrir el portal). */
  id: string;
  provider: string;
  planName: string | null;
  status: string;
  statusLabel: string;
  statusCategory: string;
  entitled: boolean;
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
  currentPeriodEnd: string | null;
  connectionId: string;
  /** True si se puede autogestionar vía Customer Portal (Stripe con customer). */
  manageable: boolean;
  renewalUrl: string | null;
}

const BASE = '/api/v1/modules/payment-connections';

export const mySubscriptionApi = {
  async get(bearer: string): Promise<{ subscriptions: MySubscriptionItem[] }> {
    return apiFetch<{ subscriptions: MySubscriptionItem[] }>(
      `${BASE}/me/subscription`,
      { method: 'GET' },
      bearer,
    );
  },

  async billingPortal(bearer: string, subscriberId: string): Promise<{ url: string }> {
    return apiFetch<{ url: string }>(
      `${BASE}/me/billing-portal`,
      { method: 'POST', body: JSON.stringify({ subscriberId }) },
      bearer,
    );
  },
};
