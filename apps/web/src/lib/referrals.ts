import { ApiHttpError, apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

/**
 * Client de mod.referrals: área del miembro (/referidos), captura del enlace
 * en /unete?ref= y administración (/admin/referidos).
 */

const BASE = '/api/v1/modules/referrals';

export type ReferralScope = 'FIRST_PAYMENT' | 'RECURRING';
export type ReferralCommissionStatus = 'PENDING' | 'APPROVED' | 'PAID' | 'REVOKED';

export interface ReferralsConfig {
  active: boolean;
  commissionBps: number;
  scope: ReferralScope;
  recurringMonths: number | null;
  attributionWindowDays: number;
  guaranteeDays: number;
  minPayoutCents: number;
  requireActiveMembership: boolean;
  memberCopy: string | null;
}

export interface ReferralCommissionRow {
  id: string;
  amountCents: number;
  baseAmountCents: number;
  currency: string;
  status: ReferralCommissionStatus;
  revokeReason?: string | null;
  createdAt: string;
}

export interface ReferralPayoutRow {
  id: string;
  totalCents: number;
  currency: string;
  externalReference: string;
  createdAt: string;
}

export interface MemberReferralStats {
  programActive: boolean;
  memberCopy: string | null;
  commissionBps: number;
  scope: ReferralScope;
  recurringMonths: number | null;
  minPayoutCents: number;
  attributionWindowDays: number;
  code: string | null;
  clicks: number;
  referrals: number;
  totals: { pendingCents: number; approvedCents: number; paidCents: number };
  commissions: ReferralCommissionRow[];
  payouts: ReferralPayoutRow[];
}

export interface AdminCommissionRow extends ReferralCommissionRow {
  tenantId: string;
  referralId: string;
  referrerUserId: string;
  stripeInvoiceId: string;
  commissionBps: number;
  approveAfter: string;
}

export interface AdminReferrerRow {
  referrerUserId: string;
  code: string;
  clicks: number;
  referrals: number;
  pendingCents: number;
  approvedCents: number;
  paidCents: number;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

// ── Miembro ──────────────────────────────────────────────────────────────────

export const referralsApi = {
  /** Código + enlace del usuario (lo crea si no existe). 404 = programa inactivo. */
  async me(): Promise<{ code: string; url: string }> {
    return apiFetch<{ code: string; url: string }>(`${BASE}/me`, { method: 'GET' }, withAuth());
  },

  async myStats(): Promise<MemberReferralStats> {
    return apiFetch<MemberReferralStats>(`${BASE}/me/stats`, { method: 'GET' }, withAuth());
  },

  /** Registro público de clic (best-effort, sin sesión). */
  async track(code: string): Promise<{ registered: boolean; attributionWindowDays: number }> {
    return apiFetch<{ registered: boolean; attributionWindowDays: number }>(`${BASE}/track`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  },
};

// ── Captura client-side del enlace (?ref=) ───────────────────────────────────

const STORAGE_KEY = 'didacta.referral';
const DEFAULT_TTL_DAYS = 30;

interface StoredReferral {
  code: string;
  expiresAt: number;
}

/**
 * Persiste el código del enlace con TTL (last-click gana). La ventana real la
 * decide el servidor al devengar; esto solo limita cuánto viaja el código.
 */
export function storeReferralCode(code: string, ttlDays: number = DEFAULT_TTL_DAYS): void {
  try {
    const payload: StoredReferral = {
      code,
      expiresAt: Date.now() + ttlDays * 24 * 60 * 60 * 1000,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage lleno/bloqueado: el checkout seguirá sin atribución.
  }
}

/** Código vigente almacenado, o null si no hay o caducó. */
export function getStoredReferralCode(): string | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredReferral;
    if (!parsed.code || typeof parsed.expiresAt !== 'number') return null;
    if (Date.now() > parsed.expiresAt) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed.code;
  } catch {
    return null;
  }
}

// ── Admin ────────────────────────────────────────────────────────────────────

export const referralsAdminApi = {
  async getConfig(): Promise<ReferralsConfig> {
    return apiFetch<ReferralsConfig>(`${BASE}/admin/config`, { method: 'GET' }, withAuth());
  },

  async updateConfig(input: Partial<ReferralsConfig>): Promise<ReferralsConfig> {
    return apiFetch<ReferralsConfig>(
      `${BASE}/admin/config`,
      { method: 'PUT', body: JSON.stringify(input) },
      withAuth(),
    );
  },

  async listCommissions(
    filter: {
      status?: ReferralCommissionStatus;
      referrerUserId?: string;
    } = {},
  ): Promise<{
    commissions: AdminCommissionRow[];
    totalsByStatus: Array<{ status: ReferralCommissionStatus; totalCents: number; count: number }>;
  }> {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.referrerUserId) params.set('referrerUserId', filter.referrerUserId);
    const qs = params.toString();
    return apiFetch(
      `${BASE}/admin/commissions${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      withAuth(),
    );
  },

  async listReferrers(): Promise<AdminReferrerRow[]> {
    return apiFetch<AdminReferrerRow[]>(`${BASE}/admin/referrers`, { method: 'GET' }, withAuth());
  },

  async approveCommission(id: string): Promise<void> {
    await apiFetch(`${BASE}/admin/commissions/${id}/approve`, { method: 'POST' }, withAuth());
  },

  async revokeCommission(id: string, reason: string): Promise<void> {
    await apiFetch(
      `${BASE}/admin/commissions/${id}/revoke`,
      { method: 'POST', body: JSON.stringify({ reason }) },
      withAuth(),
    );
  },

  async recordPayout(input: {
    referrerUserId: string;
    commissionIds: string[];
    externalReference: string;
  }): Promise<{ payoutId: string; totalCents: number; currency: string; count: number }> {
    return apiFetch(
      `${BASE}/admin/payouts`,
      { method: 'POST', body: JSON.stringify(input) },
      withAuth(),
    );
  },
};

/** Céntimos → "12,34 €" (es-ES). */
export function formatReferralCents(cents: number, currency = 'eur'): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}
