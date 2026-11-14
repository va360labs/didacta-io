'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cliente HTTP de mod.subscriptions para el alumno.
 *
 * - GET  /api/v1/modules/subscriptions/me
 * - GET  /api/v1/modules/subscriptions/me/:id/invoices
 * - POST /api/v1/modules/subscriptions/checkout/:courseId
 * - POST /api/v1/modules/subscriptions/me/:id/cancel
 * - GET  /api/v1/modules/subscriptions/me/:id/leave  (oferta al darse de baja)
 * - POST /api/v1/modules/subscriptions/me/:id/leave
 *
 * No es EE — todo CE. Sin `<EeGate>`.
 */

import { apiFetch } from '@/lib/api-client';
import { formatCentsExact } from '@/lib/i18n/format';

export type SubscriptionStatus =
  | 'PENDING'
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'UNPAID'
  | 'CANCELED'
  | 'PAUSED';
export type InvoiceStatus = 'OPEN' | 'PAID' | 'UNCOLLECTIBLE' | 'VOID';

export interface SubscriptionRow {
  id: string;
  tenantId: string;
  userId: string;
  /** null en suscripciones de MEMBRESÍA (acceso a todo vía grupo). */
  courseId: string | null;
  /** Plan de membresía (solo filas de membresía). */
  planId: string | null;
  /** Nombre real del plan ("Membresía Anual") — lo resuelve el backend. */
  planName?: string | null;
  /** Título real del curso (filas por curso) — lo resuelve el backend. */
  courseTitle?: string | null;
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
  /** Fin del periodo de prueba (solo status TRIALING). */
  trialEndsAt: string | null;
  /** Pausa aceptada al darse de baja: empieza al acabar lo pagado. */
  pauseStartsAt?: string | null;
  /** Primer cobro tras la pausa (vuelve el acceso). */
  pauseEndsAt?: string | null;
  /** Descuento de retención vivo, o null. */
  retentionDiscount?: {
    percent: number;
    months: number | null;
    duration: string;
    endsAt: string | null;
  } | null;
  /**
   * Hay portal de cliente para esta suscripción (tarjeta, facturas y baja con
   * el nombre de la academia). Lo decide el backend: hoy, las cobradas a
   * través de la plataforma.
   */
  billingPortal?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceRow {
  id: string;
  tenantId: string;
  subscriptionId: string;
  stripeInvoiceId: string;
  status: InvoiceStatus;
  /** Lo cobrado (cuota − saldo de referidos). */
  amount: number;
  /** La cuota entera facturada (null en facturas anteriores al cambio). */
  totalCents?: number | null;
  /** «Pago con saldo de referidos»: el saldo que Stripe gastó. */
  creditAppliedCents?: number;
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

/** Motivos de baja (mismo orden que la API). */
export const EXIT_REASONS = [
  'too_expensive',
  'no_time',
  'not_expected',
  'learned_enough',
  'missing_topics',
  'other',
] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

/** Lo que el aula ofrece a esta suscripción al darse de baja. */
export interface LeaveOffer {
  subscriptionId: string;
  canLeave: boolean;
  reasons: ExitReason[];
  /** Hasta cuándo conserva el acceso si se da de baja. */
  accessEndsAt: string | null;
  pause: { months: number[]; startsAt: string; endsAtByMonths: Record<string, string> } | null;
  discount: {
    percent: number;
    months: number | null;
    duration: 'repeating' | 'once';
    amountCents: number;
    discountedAmountCents: number;
    currency: string;
    nextChargeAt: string | null;
  } | null;
}

export interface LeaveBody {
  reason: ExitReason;
  reasonText?: string | null;
  choice: 'pause' | 'discount' | 'cancel';
  pauseMonths?: number;
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

  /** Oferta al darse de baja (motivos, pausa y descuento disponibles). */
  async leaveOffer(bearer: string, subscriptionId: string): Promise<LeaveOffer> {
    return apiFetch<LeaveOffer>(
      `${BASE}/me/${encodeURIComponent(subscriptionId)}/leave`,
      { method: 'GET' },
      bearer,
    );
  },

  /** Lo que decide: pausar, quedarse con el descuento o darse de baja (con su motivo). */
  async leave(
    bearer: string,
    subscriptionId: string,
    body: LeaveBody,
  ): Promise<{ outcome: 'PAUSED' | 'DISCOUNTED' | 'CANCELED'; subscription: SubscriptionRow }> {
    return apiFetch<{
      outcome: 'PAUSED' | 'DISCOUNTED' | 'CANCELED';
      subscription: SubscriptionRow;
    }>(
      `${BASE}/me/${encodeURIComponent(subscriptionId)}/leave`,
      { method: 'POST', body: JSON.stringify(body) },
      bearer,
    );
  },

  /** Abre el portal de cliente de Stripe de una suscripción propia: devuelve su URL. */
  async billingPortal(
    bearer: string,
    subscriptionId: string,
  ): Promise<{ url: string; subscriptionId: string }> {
    return apiFetch<{ url: string; subscriptionId: string }>(
      `${BASE}/me/portal`,
      { method: 'POST', body: JSON.stringify({ subscriptionId }) },
      bearer,
    );
  },

  /**
   * Termina el periodo de prueba de la MEMBRESÍA ya: Stripe cobra el primer
   * periodo y (si el cargo entra) se desbloquea todo el contenido.
   */
  async membershipPayNow(bearer: string): Promise<{ subscription: SubscriptionRow }> {
    return apiFetch<{ subscription: SubscriptionRow }>(
      `${BASE}/me/membership/pay-now`,
      { method: 'POST', body: JSON.stringify({}) },
      bearer,
    );
  },
};

/**
 * Formatea importe de céntimos a string visual en el LOCALE ACTIVO:
 * 1999 + 'eur' → "19,99 €".
 *
 * Conserva decimales SIEMPRE (no usa `formatCents`): son importes de
 * suscripción que se cotejan con el panel del proveedor. El `catch` cubre un
 * código de moneda inválido, que haría reventar a `Intl`.
 */
export function formatAmount(unitAmount: number, currency: string): string {
  // Decimales según Stripe (`stripe-currencies.ts`), no `Intl`.
  return formatCentsExact(unitAmount, currency.toUpperCase());
}

export function formatInterval(interval: string): string {
  if (interval === 'month') return 'mensual';
  if (interval === 'year') return 'anual';
  if (interval === 'week') return 'semanal';
  if (interval === 'day') return 'diaria';
  return interval;
}
