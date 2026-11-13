/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

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
  /** El alumno con membresía puede cobrar lo ganado como descuento en su cuota. */
  allowCreditRedemption: boolean;
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
  /** CASH = pago aparte; CREDIT = descuento en la cuota. */
  method?: 'CASH' | 'CREDIT';
  /** REQUESTED = cobro en dinero pedido, aún sin pagar. */
  status?: 'PENDING' | 'REQUESTED' | 'DONE';
  /** Cobro en dinero: cuándo lo marcó pagado el creador. */
  paidAt?: string | null;
  /** Justificante correlativo del aula (cobro en dinero pagado). */
  receiptNumber?: number | null;
  createdAt: string;
}

/** Datos de cobro del alumno, ENMASCARADOS (lo que ve él). */
export interface PayeeMasked {
  fullName: string;
  country: string;
  taxIdMasked: string;
  ibanMasked: string;
  updatedAt: string | null;
}

export interface PayeeInput {
  fullName: string;
  country: string;
  taxId: string;
  iban: string;
}

/** Un cobro en dinero, para el creador: con lo necesario para pagar. */
export interface AdminCashPayout {
  id: string;
  referrerUserId: string;
  totalCents: number;
  currency: string;
  status: 'REQUESTED' | 'DONE';
  receiptNumber: number | null;
  externalReference: string | null;
  requestedAt: string;
  paidAt: string | null;
  payee: { fullName: string; country: string; taxId: string; iban: string } | null;
}

/** Lo que el alumno puede usar como descuento en su próxima cuota. */
export interface MemberCreditView {
  enabled: boolean;
  availableCents: number;
  currency: string | null;
  maxCents: number;
  pending: boolean;
}

export interface RedeemCreditResult {
  payoutId: string;
  totalCents: number;
  currency: string;
  count: number;
  stripeBalanceTransactionId: string;
}

export interface ReferralTermsStatus {
  /** Aceptó la versión vigente. */
  accepted: boolean;
  acceptedVersion: string | null;
  acceptedAt: string | null;
  currentVersion: string;
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
  /** Casilla «mayor de 18 y acepto las condiciones»: sin ella no hay enlace. */
  terms?: ReferralTermsStatus;
  /** Datos para cobrar en dinero, enmascarados (null si no los ha dado). */
  payee?: PayeeMasked | null;
  /** La instancia puede guardar datos de cobro (cobro en dinero disponible). */
  cashPayoutAvailable?: boolean;
  clicks: number;
  referrals: number;
  totals: { pendingCents: number; approvedCents: number; paidCents: number };
  commissions: ReferralCommissionRow[];
  payouts: ReferralPayoutRow[];
  credit?: MemberCreditView;
}

/**
 * Estado de un invitado (lo deriva el servidor):
 * trial = en prueba; paying = suscripción viva (ACTIVE/PAST_DUE);
 * bought_course = compra suelta sin suscripción viva; cancelled = tuvo
 * suscripción y ya no; joined = nada de lo anterior.
 */
export type InviteeState = 'trial' | 'paying' | 'bought_course' | 'cancelled' | 'joined';

/** Un invitado: solo iniciales, nunca nombre ni correo. */
export interface MemberInvitee {
  id: string;
  initials: string;
  joinedAt: string;
  state: InviteeState;
  /** Comisiones no anuladas que ha generado, en céntimos. */
  generatedCents: number;
  currency: string;
}

export interface MemberInvitees {
  /** Invitados con la suscripción viva ahora mismo. */
  payingNow: number;
  invitees: MemberInvitee[];
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
  if (!token)
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
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

  /** Usa lo ganado como descuento en la próxima cuota (saldo de cliente de Stripe). */
  /** «Declaro que soy mayor de 18 años y acepto las condiciones del programa». */
  async acceptTerms(version: string): Promise<{ version: string; acceptedAt: string }> {
    return apiFetch(
      `${BASE}/me/terms`,
      { method: 'POST', body: JSON.stringify({ version, adult: true }) },
      withAuth(),
    );
  },

  /** Guarda los datos para cobrar en dinero (se guardan cifrados). */
  async savePayee(input: PayeeInput): Promise<{ payee: PayeeMasked }> {
    return apiFetch(`${BASE}/me/payee`, { method: 'PUT', body: JSON.stringify(input) }, withAuth());
  },

  /** Pide el cobro en dinero de lo confirmado. */
  async requestPayout(): Promise<{ payoutId: string; totalCents: number; currency: string }> {
    return apiFetch(`${BASE}/me/payouts`, { method: 'POST', body: '{}' }, withAuth());
  },

  async redeemCredit(): Promise<RedeemCreditResult> {
    return apiFetch<RedeemCreditResult>(
      `${BASE}/me/redeem-credit`,
      { method: 'POST', body: JSON.stringify({}) },
      withAuth(),
    );
  },

  /** Tus invitados: iniciales, fecha, estado y lo que han generado. */
  async myInvitees(): Promise<MemberInvitees> {
    return apiFetch<MemberInvitees>(`${BASE}/me/invitees`, { method: 'GET' }, withAuth());
  },

  /** Condiciones públicas del programa del aula (sin sesión, tenant por dominio). */
  async publicTerms(): Promise<ReferralsPublicTerms> {
    return apiFetch<ReferralsPublicTerms>(`${BASE}/public/terms`, { method: 'GET' });
  },

  /** Registro público de clic (best-effort, sin sesión). */
  async track(code: string): Promise<{ registered: boolean; attributionWindowDays: number }> {
    return apiFetch<{ registered: boolean; attributionWindowDays: number }>(`${BASE}/track`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  },
};

/** Página pública con las condiciones del programa (es/en según el idioma). */
export const REFERRAL_TERMS_PATH = '/condiciones-referidos';

export interface ReferralsPublicTerms {
  version: string;
  active: boolean;
  commissionBps: number;
  scope: 'FIRST_PAYMENT' | 'RECURRING';
  recurringMonths: number | null;
  attributionWindowDays: number;
  guaranteeDays: number;
  minPayoutCents: number;
  allowCreditRedemption: boolean;
  creditMaxSharePercent: number;
}

/**
 * Descarga el justificante en PDF de un cobro en dinero (con la sesión: no se
 * puede enlazar a pelo). `admin` = la ruta del creador.
 */
export async function downloadReferralReceipt(
  payoutId: string,
  receiptNumber: number,
  admin = false,
): Promise<void> {
  const path = admin
    ? `${BASE}/admin/cash-payouts/${encodeURIComponent(payoutId)}/receipt`
    : `${BASE}/me/payouts/${encodeURIComponent(payoutId)}/receipt`;
  const res = await fetch(path, { headers: { Authorization: `Bearer ${withAuth()}` } });
  if (!res.ok) {
    throw new ApiHttpError({
      message: `No se pudo descargar el justificante (${res.status})`,
      status: res.status,
    });
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `justificante-${String(receiptNumber).padStart(4, '0')}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

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
  /** Cobros en dinero (pedidos y pagados) con lo necesario para pagar. */
  async listCashPayouts(): Promise<{ payouts: AdminCashPayout[] }> {
    return apiFetch(`${BASE}/admin/cash-payouts`, { method: 'GET' }, withAuth());
  },

  /** Marca pagado un cobro pedido, con la referencia de la transferencia. */
  async markCashPayoutPaid(id: string, externalReference: string): Promise<void> {
    await apiFetch(
      `${BASE}/admin/cash-payouts/${encodeURIComponent(id)}/paid`,
      { method: 'POST', body: JSON.stringify({ externalReference }) },
      withAuth(),
    );
  },

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
