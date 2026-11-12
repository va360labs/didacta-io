/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cobros de plataforma (`mod.payouts`) desde la web del aula.
 *
 * Backend: `apps/api/src/modules/payouts/payouts.controller.ts`. Las rutas
 * SOLO existen cuando la instalación está en modo plataforma (Didacta Cloud);
 * en Community responden 404 y la web sigue con «pega tu clave de Stripe».
 *
 *  - `GET  /api/v1/modules/payouts/status[?sync=1]` → estado (sync = consulta Stripe).
 *  - `POST /api/v1/modules/payouts/connect` → `{ account, onboardingUrl }`.
 *  - `POST /api/v1/modules/payouts/connect/link` → `{ url }` («Completar»).
 *  - `GET  /api/v1/modules/payouts/dashboard-link` → `{ url }` (panel Express).
 *  - `GET  /api/v1/modules/payouts/sales?page&pageSize` → ventas («Tus ventas»).
 *  - `GET  /api/v1/modules/payouts/summary` → resumen por divisa.
 */

import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';
import { formatCurrency, formatNumber, regionNameFormatter } from './i18n/format';

export type PayoutsAccountStatus =
  | 'NOT_CONNECTED'
  | 'ONBOARDING'
  | 'PENDING_REVIEW'
  | 'READY'
  | 'RESTRICTED'
  | 'REJECTED'
  | 'DISCONNECTED';

export type PayoutsRequirement =
  | 'bank_account'
  | 'identity_document'
  | 'personal_details'
  | 'business_details'
  | 'terms'
  | 'other';

export interface PayoutScheduleDto {
  interval: string;
  weeklyDay: string | null;
  monthlyDay: number | null;
  delayDays: number | null;
  minimumBalance: Record<string, number> | null;
}

export interface PayoutsAccountDto {
  status: PayoutsAccountStatus;
  stripeAccountId: string | null;
  country: string;
  entityType: string;
  defaultCurrency: string | null;
  payoutsEnabled: boolean;
  pendingRequirement: PayoutsRequirement | null;
  requirementsDeadline: string | null;
  disabledReason: string | null;
  payoutSchedule: PayoutScheduleDto | null;
  readyAt: string | null;
  lastSyncedAt: string | null;
}

export interface PayoutsStatusDto {
  platform: true;
  operatorName: string;
  mode: 'platform' | 'own' | 'none';
  ready: boolean;
  reason: string | null;
  account: PayoutsAccountDto | null;
  supportedCountries: string[];
  feeBps: number;
}

export type PayoutsEntityType = 'individual' | 'company';

/** Motivo que pone la API cuando el país de la cuenta dejó de estar admitido. */
export const COUNTRY_NOT_SUPPORTED_REASON = 'platform.country_unsupported';

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token)
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  return token;
}

export const payoutsApi = {
  /**
   * Estado de cobros. `null` = la instalación no está en modo plataforma (la
   * ruta no existe): quien llama sigue con la tarjeta de claves de siempre.
   */
  async status(options: { sync?: boolean } = {}): Promise<PayoutsStatusDto | null> {
    try {
      return await apiFetch<PayoutsStatusDto>(
        `/api/v1/modules/payouts/status${options.sync ? '?sync=1' : ''}`,
        { method: 'GET' },
        withAuth(),
      );
    } catch (err) {
      if (err instanceof ApiHttpError && err.status === 404) return null;
      throw err;
    }
  },
  connect(country: string, entityType: PayoutsEntityType) {
    return apiFetch<{ account: PayoutsAccountDto; onboardingUrl: string | null }>(
      '/api/v1/modules/payouts/connect',
      { method: 'POST', body: JSON.stringify({ country, entityType }) },
      withAuth(),
    );
  },
  onboardingLink() {
    return apiFetch<{ url: string }>(
      '/api/v1/modules/payouts/connect/link',
      { method: 'POST', body: JSON.stringify({}) },
      withAuth(),
    );
  },
  dashboardLink() {
    return apiFetch<{ url: string }>(
      '/api/v1/modules/payouts/dashboard-link',
      { method: 'GET' },
      withAuth(),
    );
  },
  /** Ventas del aula. `null` = sin modo plataforma (la ruta no existe). */
  async sales(page = 1, pageSize = 20): Promise<PayoutsSalesPageDto | null> {
    try {
      return await apiFetch<PayoutsSalesPageDto>(
        `/api/v1/modules/payouts/sales?page=${page}&pageSize=${pageSize}`,
        { method: 'GET' },
        withAuth(),
      );
    } catch (err) {
      if (err instanceof ApiHttpError && err.status === 404) return null;
      throw err;
    }
  },
  /** Resumen por divisa. `null` = sin modo plataforma. */
  async summary(): Promise<PayoutsSummaryDto | null> {
    try {
      return await apiFetch<PayoutsSummaryDto>(
        '/api/v1/modules/payouts/summary',
        { method: 'GET' },
        withAuth(),
      );
    } catch (err) {
      if (err instanceof ApiHttpError && err.status === 404) return null;
      throw err;
    }
  },
};

// ── «Tus ventas» ─────────────────────────────────────────────────────────

export type PayoutsSaleStatus =
  | 'AWAITING_FEE'
  | 'READY'
  | 'TRANSFERRED'
  | 'SETTLED_NETTED'
  | 'HELD'
  | 'FAILED';

/** Una venta tal como la da `GET /modules/payouts/sales`. Importes en unidad mínima. */
export interface PayoutsSaleDto {
  id: string;
  chargedAt: string | null;
  description: string | null;
  sourceKind: string;
  status: PayoutsSaleStatus;
  /** Código del motivo si está retenida o en revisión (`transfer_rejected`…). */
  reason: string | null;
  /** Lo que pagó el alumno, en SU moneda. */
  presentmentAmount: number;
  presentmentCurrency: string;
  /** Moneda en la que cobra el creador; `null` mientras Stripe no ha asentado el pago. */
  currency: string | null;
  gross: number | null;
  stripeFee: number | null;
  feeBpsApplied: number | null;
  platformFee: number | null;
  creatorNet: number | null;
  debtNetted: number;
  transferAmount: number | null;
  refundedAmount: number;
  transferredAt: string | null;
  availableOn: string | null;
  /** `YYYY-MM-DD` (UTC): día estimado del pago al banco. */
  estimatedArrival: string | null;
}

export interface PayoutsSalesPageDto {
  items: PayoutsSaleDto[];
  page: number;
  pageSize: number;
  total: number;
}

export interface PayoutsCurrencySummaryDto {
  currency: string;
  salesCount: number;
  gross: number;
  stripeFees: number;
  platformFees: number;
  received: number;
  pending: number;
  debtNetted: number;
  debtOutstanding: number;
}

export interface PayoutsSummaryDto {
  currencies: PayoutsCurrencySummaryDto[];
  awaitingFeeCount: number;
  operatorName: string;
  feeBps: number;
}

/**
 * Divisas que Stripe trata SIN decimales: el importe de la API ya es la
 * unidad (1000 JPY = ¥1.000). El resto va en céntimos, incluidas las que
 * Stripe trata con dos decimales aunque `Intl` diga otra cosa (HUF, ISK, UGX).
 * Tabla de https://docs.stripe.com/currencies#zero-decimal.
 */
const STRIPE_ZERO_DECIMAL = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
]);

/** Importe de Stripe (unidad mínima) → unidades de la divisa. */
export function stripeMinorToMajor(amount: number, currency: string): number {
  return STRIPE_ZERO_DECIMAL.has(currency.toLowerCase()) ? amount : amount / 100;
}

/**
 * Importe de Stripe para enseñar al creador, CON sus decimales: se cuadra a
 * ojo contra su panel de pagos y su banco («93,25 €», nunca «93 €»).
 */
export function formatStripeAmount(amount: number, currency: string, locale?: string): string {
  // Los decimales los marca Stripe, no `Intl`: en HUF `Intl` redondea a
  // forintos enteros y 37.221,50 se vería como 37.222.
  const digits = STRIPE_ZERO_DECIMAL.has(currency.toLowerCase()) ? 0 : 2;
  return formatCurrency(stripeMinorToMajor(amount, currency), currency.toUpperCase(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    ...(locale ? { locale } : {}),
  });
}

/** Clave del estado en lenguaje llano (`adminPagos.payouts.sales.status.*`) y su tono. */
export type PayoutsSaleStatusKey =
  | 'calculating'
  | 'onTheWay'
  | 'sent'
  | 'netted'
  | 'heldAccount'
  | 'heldRetry'
  | 'refunded'
  | 'disputed'
  | 'review';

export interface PayoutsSaleStatusView {
  key: PayoutsSaleStatusKey;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
}

export function saleStatusView(
  sale: Pick<PayoutsSaleDto, 'status' | 'reason'>,
): PayoutsSaleStatusView {
  switch (sale.status) {
    case 'AWAITING_FEE':
      return { key: 'calculating', tone: 'neutral' };
    case 'READY':
      return { key: 'onTheWay', tone: 'info' };
    case 'TRANSFERRED':
      return { key: 'sent', tone: 'success' };
    case 'SETTLED_NETTED':
      return { key: 'netted', tone: 'neutral' };
    case 'HELD':
      if (sale.reason === 'account_not_ready') return { key: 'heldAccount', tone: 'warning' };
      if (sale.reason === 'charge_refunded') return { key: 'refunded', tone: 'neutral' };
      if (sale.reason === 'charge_disputed') return { key: 'disputed', tone: 'danger' };
      return { key: 'heldRetry', tone: 'warning' };
    case 'FAILED':
    default:
      return { key: 'review', tone: 'danger' };
  }
}

/** Porcentaje legible de unos puntos básicos: 500 → «5», 250 → «2,5». */
export function feePercent(feeBps: number, locale?: string): string {
  return formatNumber(feeBps / 100, {
    maximumFractionDigits: 2,
    ...(locale ? { locale } : {}),
  });
}

/** Qué pinta la tarjeta. Una sola función para que los tests fijen la tabla. */
export type PayoutsCardView =
  /** Sin modo plataforma o con claves propias heredadas: tarjeta de claves. */
  | { kind: 'own-keys' }
  | { kind: 'not-connected' }
  | { kind: 'missing'; requirement: PayoutsRequirement }
  | { kind: 'review' }
  | { kind: 'country-unsupported'; country: string }
  | { kind: 'rejected' }
  | { kind: 'ready'; currency: string | null; schedule: PayoutScheduleDto | null };

export function derivePayoutsCardView(status: PayoutsStatusDto | null): PayoutsCardView {
  if (!status) return { kind: 'own-keys' };
  const account = status.account;
  if (!account || account.status === 'NOT_CONNECTED' || account.status === 'DISCONNECTED') {
    return { kind: 'not-connected' };
  }
  switch (account.status) {
    case 'READY':
      return {
        kind: 'ready',
        currency: account.defaultCurrency,
        schedule: account.payoutSchedule,
      };
    case 'PENDING_REVIEW':
      return { kind: 'review' };
    case 'REJECTED':
      return { kind: 'rejected' };
    case 'RESTRICTED':
      if (account.disabledReason === COUNTRY_NOT_SUPPORTED_REASON) {
        return { kind: 'country-unsupported', country: account.country };
      }
      return { kind: 'missing', requirement: account.pendingRequirement ?? 'other' };
    case 'ONBOARDING':
    default:
      return { kind: 'missing', requirement: account.pendingRequirement ?? 'other' };
  }
}

/**
 * Países que se ofrecen en el selector: los admitidos por la plataforma y,
 * detrás, los que más preguntan y todavía no se admiten (para enseñar el
 * mensaje de «todavía no podemos pagarte» en vez de dejarlos fuera sin
 * explicación).
 */
export const COMMON_UNSUPPORTED_COUNTRIES: readonly string[] = [
  'MX',
  'AR',
  'CO',
  'CL',
  'PE',
  'BR',
  'UY',
  'EC',
  'VE',
  'BO',
  'PY',
  'CR',
  'PA',
  'DO',
  'GT',
  'SV',
  'HN',
  'NI',
  'PR',
  'MA',
  'AD',
];

export function countryOptions(
  supported: readonly string[],
  locale: string,
): Array<{ code: string; name: string; supported: boolean }> {
  const name = regionNameFormatter(locale);
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, locale);
  const supportedSet = new Set(supported.map((c) => c.toUpperCase()));
  const yes = [...supportedSet].map((code) => ({ code, name: name(code), supported: true }));
  const no = COMMON_UNSUPPORTED_COUNTRIES.filter((c) => !supportedSet.has(c)).map((code) => ({
    code,
    name: name(code),
    supported: false,
  }));
  return [...yes.sort(byName), ...no.sort(byName)];
}

/** País por defecto del selector: el del navegador si se admite, si no el primero admitido. */
export function defaultCountry(supported: readonly string[], browserLocale: string): string {
  const region = browserLocale.split(/[-_]/)[1]?.toUpperCase();
  if (region && supported.includes(region)) return region;
  if (supported.includes('ES')) return 'ES';
  return supported[0] ?? 'ES';
}
