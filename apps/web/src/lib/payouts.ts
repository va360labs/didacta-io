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
 */

import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';
import { regionNameFormatter } from './i18n/format';

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
};

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
