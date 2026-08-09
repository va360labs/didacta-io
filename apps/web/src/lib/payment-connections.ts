'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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
import { formatCurrency } from '@/lib/i18n/format';

export type PaymentConnectionStatus = 'PENDING' | 'VERIFIED' | 'ERROR' | 'DISCONNECTED';

/** Forma con la que la badge de estado se pinta en el panel. */
export interface ConnectionStatusStyle {
  /** Sufijo de `adminPagos.connStatus.*`, o `null` si el estado es desconocido. */
  key: 'verified' | 'error' | 'pending' | 'disconnected' | null;
  className?: string;
  variant?: 'outline';
}

const CONNECTION_STATUS_STYLES: Record<PaymentConnectionStatus, ConnectionStatusStyle> = {
  VERIFIED: { key: 'verified', className: 'bg-success-600 text-white' },
  ERROR: { key: 'error', className: 'bg-danger-600 text-white' },
  PENDING: { key: 'pending', variant: 'outline' },
  DISCONNECTED: { key: 'disconnected', variant: 'outline' },
};

/**
 * Estilo neutro para un estado que este front no conoce. NO es un default
 * implícito: es el destino deliberado de un enum que crece en la API antes de
 * que se despliegue el web.
 */
const UNKNOWN_CONNECTION_STATUS_STYLE: ConnectionStatusStyle = { key: null, variant: 'outline' };

/**
 * Estilo de la badge de un estado de conexión.
 *
 * CAMINO DEGRADADO: `PaymentConnectionStatus` refleja un enum de Prisma que
 * puede crecer sin que este front se entere (basta un deploy de API por
 * delante del de web, o un módulo de terceros). Antes se indexaba el mapa a
 * pelo y un estado nuevo daba `undefined`: leer `.key` reventaba con un
 * TypeError que subía al error boundary y dejaba TODA la pantalla de conexiones
 * de pago en blanco. Con `key: null` el caller pinta el código crudo — feo,
 * pero la pantalla se ve y el admin puede seguir operando el resto de filas.
 */
export function connectionStatusStyle(status: string): ConnectionStatusStyle {
  return (
    CONNECTION_STATUS_STYLES[status as PaymentConnectionStatus] ?? UNKNOWN_CONNECTION_STATUS_STYLE
  );
}

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

/** Categoría normalizada del estado de una suscripción (espejo del módulo backend). */
export type SubscriptionStatusCategory =
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
  | 'paused'
  | 'unknown';

export interface SubscriptionStatusInfo {
  category: SubscriptionStatusCategory;
  /** Etiqueta legible en español (p.ej. "Dada de baja", "En impago"). */
  label: string;
  /** Si el estado concede acceso vigente hoy. */
  entitled: boolean;
}

/**
 * Clasifica el `status` crudo de una suscripción (Stripe / WooCommerce / PayPal)
 * en categoría + etiqueta legible. Espejo de `classifySubscriptionStatus` del
 * módulo `@didacta/mod-payment-connections` (mismo patrón que `formatAmount`):
 * la web no puede importar el módulo backend, así que se duplica la función pura.
 */
export function classifySubscriptionStatus(status: string): SubscriptionStatusInfo {
  switch ((status ?? '').toLowerCase().trim()) {
    case 'active':
      return { category: 'active', label: 'Activa', entitled: true };
    case 'trialing':
      return { category: 'active', label: 'En prueba', entitled: true };
    case 'past_due':
      return { category: 'past_due', label: 'Pago atrasado (impago)', entitled: true };
    case 'unpaid':
      return { category: 'unpaid', label: 'Impago — suspendida', entitled: false };
    case 'on-hold':
      // WooCommerce 'on-hold' = impago/espera de pago. El set activo de la
      // reconciliación de tiers (WC_ACTIVE_STATUSES) la cuenta como suscrita, así
      // que aquí también es `entitled` (con etiqueta de impago) para no contradecir
      // al sync de tiers — mismo criterio que el past_due de Stripe.
      return { category: 'past_due', label: 'En espera (impago)', entitled: true };
    case 'paused':
      return { category: 'paused', label: 'Pausada', entitled: false };
    case 'pending-cancel':
      return { category: 'canceled', label: 'Baja programada', entitled: true };
    case 'canceled':
    case 'cancelled':
      return { category: 'canceled', label: 'Dada de baja', entitled: false };
    case 'expired':
      return { category: 'canceled', label: 'Expirada', entitled: false };
    case 'incomplete':
    case 'incomplete_expired':
      return { category: 'incomplete', label: 'Pago no completado', entitled: false };
    case 'pending':
      return { category: 'incomplete', label: 'Pendiente de pago', entitled: false };
    default:
      return { category: 'unknown', label: status || 'Desconocido', entitled: false };
  }
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

/**
 * Importe en céntimos + moneda → "19,99 €" en el LOCALE ACTIVO.
 *
 * Sigue conservando decimales SIEMPRE (no usa `formatCents`, que los quita en
 * cantidades redondas): la moneda la manda un proveedor externo (Stripe,
 * WooCommerce, PayPal) y estas cifras se leen contra su panel, donde «19,00 €»
 * y «19 €» no son la misma línea. El `catch` también se queda: un código de
 * moneda inválido del proveedor haría reventar a `Intl`.
 */
export function formatAmount(unitAmount: number | null, currency: string | null): string {
  if (unitAmount === null) return '—';
  const value = unitAmount / 100;
  const cur = (currency ?? 'eur').toUpperCase();
  try {
    return formatCurrency(value, cur);
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

// ── Dashboard de control de suscripciones ─────────────────────────────────────

/** Una fila de suscriptor materializado (lo que devuelve el dashboard). */
export interface DashboardSubscriber {
  id: string;
  connectionId: string;
  provider: string;
  subscriptionId: string;
  subscriptionCustomerId: string | null;
  userId: string | null;
  userEmail: string;
  status: string;
  statusCategory: string;
  entitled: boolean;
  productName: string | null;
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
  currentPeriodEnd: string | null;
  renewalUrl: string | null;
  lastSeenAt: string;
}

export interface SubscribersSummary {
  total: number;
  byCategory: Record<string, number>;
  byProvider: Record<string, number>;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
}

export interface SubscriberSyncOutcome {
  connections: number;
  upserted: number;
  markedGone: number;
  failures: Array<{ provider: string; connectionName: string; message: string }>;
}

export interface SubscribersListFilters {
  statusCategory?: string;
  provider?: string;
  connectionId?: string;
  onlyUnmatched?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

export const subscriptionsDashboardApi = {
  /** Sincroniza on-demand (puede tardar varios segundos por cuenta). */
  async sync(bearer: string): Promise<SubscriberSyncOutcome> {
    return apiFetch<SubscriberSyncOutcome>(
      `${BASE}/subscriptions-dashboard/sync`,
      { method: 'POST' },
      bearer,
    );
  },
  async list(
    bearer: string,
    filters: SubscribersListFilters = {},
  ): Promise<{ rows: DashboardSubscriber[]; total: number }> {
    const qs = new URLSearchParams();
    if (filters.statusCategory) qs.set('statusCategory', filters.statusCategory);
    if (filters.provider) qs.set('provider', filters.provider);
    if (filters.connectionId) qs.set('connectionId', filters.connectionId);
    if (filters.onlyUnmatched) qs.set('onlyUnmatched', 'true');
    if (filters.q) qs.set('q', filters.q);
    if (filters.limit != null) qs.set('limit', String(filters.limit));
    if (filters.offset != null) qs.set('offset', String(filters.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiFetch<{ rows: DashboardSubscriber[]; total: number }>(
      `${BASE}/subscriptions-dashboard${suffix}`,
      { method: 'GET' },
      bearer,
    );
  },
  async summary(bearer: string): Promise<SubscribersSummary> {
    return apiFetch<SubscribersSummary>(
      `${BASE}/subscriptions-dashboard/summary`,
      { method: 'GET' },
      bearer,
    );
  },
  /** Resuelve (lazy) el enlace de renovación read-only del suscriptor. */
  async renewalUrl(bearer: string, id: string): Promise<{ url: string | null }> {
    return apiFetch<{ url: string | null }>(
      `${BASE}/subscriptions-dashboard/subscribers/${encodeURIComponent(id)}/renewal-url`,
      { method: 'GET' },
      bearer,
    );
  },
  async sendRenewalEmail(
    bearer: string,
    id: string,
    payload: RenewalTemplate,
  ): Promise<{ ok: boolean; to: string }> {
    return apiFetch<{ ok: boolean; to: string }>(
      `${BASE}/subscriptions-dashboard/subscribers/${encodeURIComponent(id)}/renewal-email`,
      { method: 'POST', body: JSON.stringify(payload) },
      bearer,
    );
  },
  async getTemplate(bearer: string): Promise<RenewalTemplate> {
    return apiFetch<RenewalTemplate>(
      `${BASE}/subscriptions-dashboard/renewal-template`,
      { method: 'GET' },
      bearer,
    );
  },
  async putTemplate(bearer: string, template: RenewalTemplate): Promise<RenewalTemplate> {
    return apiFetch<RenewalTemplate>(
      `${BASE}/subscriptions-dashboard/renewal-template`,
      { method: 'PUT', body: JSON.stringify(template) },
      bearer,
    );
  },
  /** URL del Customer Portal de Stripe (enlace de cancelación de los avisos de 7 días). */
  async getCancelPortalUrl(bearer: string): Promise<{ url: string | null }> {
    return apiFetch<{ url: string | null }>(
      `${BASE}/subscriptions-dashboard/cancel-portal-url`,
      { method: 'GET' },
      bearer,
    );
  },
  async setCancelPortalUrl(bearer: string, url: string): Promise<{ url: string | null }> {
    return apiFetch<{ url: string | null }>(
      `${BASE}/subscriptions-dashboard/cancel-portal-url`,
      { method: 'PUT', body: JSON.stringify({ url }) },
      bearer,
    );
  },
  /** Dispara ahora el barrido diario (resumen admin + avisos 7 días). QA/manual. */
  async runDailyNow(bearer: string): Promise<{ ok: boolean }> {
    return apiFetch<{ ok: boolean }>(
      `${BASE}/subscriptions-dashboard/daily/run-now`,
      { method: 'POST', body: '{}' },
      bearer,
    );
  },
};

/** Plantilla del email de renovación (asunto + cuerpo). */
export interface RenewalTemplate {
  subject: string;
  body: string;
}
