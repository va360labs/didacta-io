'use client';

/**
 * Cliente HTTP de mod.subscriptions para el alumno.
 *
 * - GET  /api/v1/modules/subscriptions/me
 * - GET  /api/v1/modules/subscriptions/me/:id/invoices
 * - POST /api/v1/modules/subscriptions/checkout/:courseId
 * - POST /api/v1/modules/subscriptions/me/:id/cancel
 *
 * No es EE — todo CE. Sin `<EeGate>`.
 */

import { apiFetch } from './api-client';

export type SubscriptionStatus = 'PENDING' | 'ACTIVE' | 'PAST_DUE' | 'UNPAID' | 'CANCELED';
export type InvoiceStatus = 'OPEN' | 'PAID' | 'UNCOLLECTIBLE' | 'VOID';

export interface SubscriptionRow {
  id: string;
  tenantId: string;
  userId: string;
  courseId: string;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string;
  stripePriceId: string;
  status: SubscriptionStatus;
  unitAmount: number;
  currency: string;
  interval: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  gracePeriodEndsAt: string | null;
  canceledAt: string | null;
  canceledReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceRow {
  id: string;
  tenantId: string;
  subscriptionId: string;
  stripeInvoiceId: string;
  status: InvoiceStatus;
  amount: number;
  currency: string;
  hostedInvoiceUrl: string | null;
  paidAt: string | null;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  updatedAt: string;
}

export interface StartSubscriptionBody {
  stripePriceId: string;
}

export interface StartSubscriptionResult {
  subscriptionId: string;
  sessionId: string;
  url: string;
}

const BASE = '/api/v1/modules/subscriptions';

export const subscriptionsApi = {
  async listMine(bearer: string): Promise<{ subscriptions: SubscriptionRow[] }> {
    return apiFetch<{ subscriptions: SubscriptionRow[] }>(`${BASE}/me`, { method: 'GET' }, bearer);
  },

  async listInvoices(bearer: string, subscriptionId: string): Promise<{ invoices: InvoiceRow[] }> {
    return apiFetch<{ invoices: InvoiceRow[] }>(
      `${BASE}/me/${encodeURIComponent(subscriptionId)}/invoices`,
      { method: 'GET' },
      bearer,
    );
  },

  async startCheckout(
    bearer: string,
    courseId: string,
    body: StartSubscriptionBody,
  ): Promise<StartSubscriptionResult> {
    return apiFetch<StartSubscriptionResult>(
      `${BASE}/checkout/${encodeURIComponent(courseId)}`,
      { method: 'POST', body: JSON.stringify(body) },
      bearer,
    );
  },

  async cancel(
    bearer: string,
    subscriptionId: string,
    immediate: boolean = false,
  ): Promise<{ subscription: SubscriptionRow }> {
    return apiFetch<{ subscription: SubscriptionRow }>(
      `${BASE}/me/${encodeURIComponent(subscriptionId)}/cancel`,
      { method: 'POST', body: JSON.stringify({ immediate }) },
      bearer,
    );
  },
};

/**
 * Formatea importe de céntimos a string visual: 1999 + 'eur' → "19,99 €".
 */
export function formatAmount(unitAmount: number, currency: string): string {
  const value = unitAmount / 100;
  try {
    return new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export function formatInterval(interval: string): string {
  if (interval === 'month') return 'mensual';
  if (interval === 'year') return 'anual';
  if (interval === 'week') return 'semanal';
  if (interval === 'day') return 'diaria';
  return interval;
}
