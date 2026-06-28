'use client';

/**
 * Cliente HTTP de mod.payment-connections (panel admin · super_admin).
 *
 * - POST   /api/v1/modules/payment-connections/connections
 * - GET    /api/v1/modules/payment-connections/connections
 * - POST   /api/v1/modules/payment-connections/connections/:id/verify
 * - DELETE /api/v1/modules/payment-connections/connections/:id
 * - GET    /api/v1/modules/payment-connections/connections/:id/reconcile
 * - POST   /api/v1/modules/payment-connections/connections/:id/invite
 *
 * Todos los datos vienen en vivo de la API (Stripe + BD real). Cero mocks.
 */

import { apiFetch } from '@/lib/api-client';

export type PaymentConnectionStatus = 'PENDING' | 'VERIFIED' | 'ERROR' | 'DISCONNECTED';

export interface ConnectionPublicMetadata {
  accountId?: string;
  email?: string | null;
  country?: string | null;
  businessName?: string | null;
  livemode?: boolean;
}

export interface PaymentConnection {
  id: string;
  provider: string;
  displayName: string;
  status: PaymentConnectionStatus;
  publicMetadata: ConnectionPublicMetadata | null;
  lastVerifiedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StripeSubscriber {
  subscriptionId: string;
  status: string;
  customerId: string | null;
  email: string | null;
  name: string | null;
  priceId: string | null;
  productId: string | null;
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
  currentPeriodEnd: number | null;
  created: number;
}

export interface DidactaUserLite {
  id: string;
  email: string;
  name: string | null;
  status: string;
  avatarUrl: string | null;
}

export interface ReconcileResult {
  connectionId: string;
  accountId: string | null;
  livemode: boolean;
  matched: Array<{ subscription: StripeSubscriber; user: DidactaUserLite }>;
  unmatched: StripeSubscriber[];
  truncated: boolean;
  counts: { total: number; matched: number; unmatched: number; withoutEmail: number };
}

export type InviteOutcome = 'invited' | 'already_member' | 'error';
export interface InviteResultRow {
  email: string;
  outcome: InviteOutcome;
  userId?: string;
  message?: string;
}

export type ConnectBody =
  | { provider: 'stripe'; displayName: string; apiKey: string }
  | {
      provider: 'paypal';
      displayName: string;
      clientId: string;
      clientSecret: string;
      environment: 'sandbox' | 'live';
    }
  | {
      provider: 'woocommerce';
      displayName: string;
      storeUrl: string;
      consumerKey: string;
      consumerSecret: string;
    };

const BASE = '/api/v1/modules/payment-connections';

export const paymentConnectionsApi = {
  async list(bearer: string): Promise<{ connections: PaymentConnection[] }> {
    return apiFetch<{ connections: PaymentConnection[] }>(
      `${BASE}/connections`,
      { method: 'GET' },
      bearer,
    );
  },

  async create(bearer: string, body: ConnectBody): Promise<{ connection: PaymentConnection }> {
    return apiFetch<{ connection: PaymentConnection }>(
      `${BASE}/connections`,
      { method: 'POST', body: JSON.stringify(body) },
      bearer,
    );
  },

  async verify(bearer: string, id: string): Promise<{ connection: PaymentConnection }> {
    return apiFetch<{ connection: PaymentConnection }>(
      `${BASE}/connections/${encodeURIComponent(id)}/verify`,
      { method: 'POST' },
      bearer,
    );
  },

  async remove(bearer: string, id: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(
      `${BASE}/connections/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      bearer,
    );
  },

  async reconcile(bearer: string, id: string): Promise<ReconcileResult> {
    return apiFetch<ReconcileResult>(
      `${BASE}/connections/${encodeURIComponent(id)}/reconcile`,
      { method: 'GET' },
      bearer,
    );
  },

  async invite(
    bearer: string,
    id: string,
    emails: string[],
  ): Promise<{ results: InviteResultRow[] }> {
    return apiFetch<{ results: InviteResultRow[] }>(
      `${BASE}/connections/${encodeURIComponent(id)}/invite`,
      { method: 'POST', body: JSON.stringify({ emails }) },
      bearer,
    );
  },
};

/** Importe en céntimos + moneda → "19,99 €". */
export function formatAmount(unitAmount: number | null, currency: string | null): string {
  if (unitAmount === null) return '—';
  const value = unitAmount / 100;
  const cur = (currency ?? 'eur').toUpperCase();
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: cur }).format(value);
  } catch {
    return `${value.toFixed(2)} ${cur}`;
  }
}

/** Deep-link a la suscripción en el dashboard de Stripe (test o live). */
export function stripeSubscriptionUrl(livemode: boolean, subscriptionId: string): string {
  const prefix = livemode ? '' : 'test/';
  return `https://dashboard.stripe.com/${prefix}subscriptions/${encodeURIComponent(subscriptionId)}`;
}

// ---------------- Tiers ----------------

export interface PaymentTier {
  id: string;
  name: string;
  isFree: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /** Nº de usuarios cuyo tier efectivo es este (lo rellena listCatalog). */
  memberCount?: number;
}

export interface UserTier {
  userId: string;
  /** Tier a mostrar; null → "Desconocido". */
  effectiveLabel: string | null;
  source: 'manual' | 'derived' | null;
  manualTierId: string | null;
  manualTierName: string | null;
  derivedLabel: string | null;
  derivedProvider: string | null;
}

const TIERS_BASE = '/api/v1/modules/payment-connections';

export const paymentTiersApi = {
  async listCatalog(bearer: string): Promise<{ tiers: PaymentTier[] }> {
    return apiFetch<{ tiers: PaymentTier[] }>(
      `${TIERS_BASE}/tiers/catalog`,
      { method: 'GET' },
      bearer,
    );
  },

  async createTier(
    bearer: string,
    body: { name: string; isFree?: boolean; sortOrder?: number },
  ): Promise<{ tier: PaymentTier }> {
    return apiFetch<{ tier: PaymentTier }>(
      `${TIERS_BASE}/tiers/catalog`,
      { method: 'POST', body: JSON.stringify(body) },
      bearer,
    );
  },

  async updateTier(
    bearer: string,
    id: string,
    body: { name?: string; isFree?: boolean; sortOrder?: number },
  ): Promise<{ tier: PaymentTier }> {
    return apiFetch<{ tier: PaymentTier }>(
      `${TIERS_BASE}/tiers/catalog/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
      bearer,
    );
  },

  async deleteTier(bearer: string, id: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(
      `${TIERS_BASE}/tiers/catalog/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      bearer,
    );
  },

  async getUserTiers(bearer: string, userIds: string[]): Promise<{ tiers: UserTier[] }> {
    if (userIds.length === 0) return { tiers: [] };
    const qs = encodeURIComponent(userIds.join(','));
    return apiFetch<{ tiers: UserTier[] }>(
      `${TIERS_BASE}/user-tiers?userIds=${qs}`,
      { method: 'GET' },
      bearer,
    );
  },

  async assignUserTier(
    bearer: string,
    userId: string,
    tierId: string | null,
  ): Promise<{ tier: UserTier }> {
    return apiFetch<{ tier: UserTier }>(
      `${TIERS_BASE}/user-tiers/${encodeURIComponent(userId)}`,
      { method: 'PUT', body: JSON.stringify({ tierId }) },
      bearer,
    );
  },

  async syncFromPayments(bearer: string): Promise<TierSyncResult> {
    return apiFetch<TierSyncResult>(`${TIERS_BASE}/user-tiers/sync`, { method: 'POST' }, bearer);
  },
};

export interface TierSyncResult {
  updated: number;
  /** Nº de tiers de catálogo creados desde planes nuevos. */
  tiersCreated: number;
  connections: number;
  matched: number;
  errors: Array<{ connectionId: string; message: string }>;
}
