/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * El pago DENTRO de la página de venta del aula (Checkout embebido de Stripe)
 * y lo que lo rodea: quién vende, y qué pasó al volver.
 *
 * La página pide `uiMode: 'embedded'`; el servidor lo concede si sabe la clave
 * publicable de la cuenta que cobra y, si no, devuelve el redirect de siempre.
 * Por eso aquí todo empieza por `normalizeCheckoutStart`: una API anterior (sin
 * `mode`) o sin clave publicable es, sencillamente, el redirect.
 */

import { apiFetch } from './api-client';

/** Lo que devuelve el checkout público, ya normalizado. */
export type CheckoutStart =
  | {
      mode: 'embedded';
      sessionId: string;
      clientSecret: string;
      publishableKey: string;
      /** Lo que cobrará la sesión creada (unidad mínima). Manda sobre el precio pintado. */
      amountTotal: number | null;
      currency: string | null;
    }
  | { mode: 'hosted'; sessionId: string; url: string };

/** Respuesta cruda: la de hoy (con `mode`) o la de una API anterior (solo `url`). */
export interface RawCheckoutStart {
  mode?: 'embedded' | 'hosted';
  sessionId: string;
  url?: string | null;
  clientSecret?: string | null;
  publishableKey?: string | null;
  amountTotal?: number | null;
  currency?: string | null;
}

export function normalizeCheckoutStart(raw: RawCheckoutStart): CheckoutStart {
  if (raw.mode === 'embedded' && raw.clientSecret && raw.publishableKey) {
    return {
      mode: 'embedded',
      sessionId: raw.sessionId,
      clientSecret: raw.clientSecret,
      publishableKey: raw.publishableKey,
      amountTotal: typeof raw.amountTotal === 'number' ? raw.amountTotal : null,
      currency: raw.currency ?? null,
    };
  }
  if (!raw.url) throw new Error('Respuesta de pago sin URL ni pago embebido');
  return { mode: 'hosted', sessionId: raw.sessionId, url: raw.url };
}

/** Quién vende (para «Vende», «Lo imparte» y «Contacto» junto al pago). */
export interface CheckoutSeller {
  name: string;
  creator: { name: string; avatarUrl: string | null } | null;
  contactEmail: string | null;
}

export async function getCheckoutSeller(): Promise<CheckoutSeller | null> {
  try {
    return await apiFetch<CheckoutSeller>('/api/v1/public/checkout-seller', { method: 'GET' });
  } catch {
    return null;
  }
}

/** Lo que la pantalla de gracias sabe de un pago (nunca el id de la sesión). */
export interface CheckoutSessionView {
  status: 'open' | 'complete' | 'expired' | null;
  paid: boolean;
  amount: number | null;
  currency: string | null;
  /** ISO 8601. */
  at: string | null;
}

export interface CourseCheckoutSessionView extends CheckoutSessionView {
  course: { title: string; slug: string; thumbnailUrl: string | null } | null;
}

export interface MembershipCheckoutSessionView extends CheckoutSessionView {
  plan: { name: string } | null;
}

/** Id de una Checkout Session, con la forma que acepta la API. */
export function isCheckoutSessionId(value: string | null | undefined): value is string {
  return !!value && /^cs_(test|live)_[A-Za-z0-9]{10,255}$/.test(value);
}

export function getCourseCheckoutSession(sessionId: string): Promise<CourseCheckoutSessionView> {
  return apiFetch<CourseCheckoutSessionView>(
    `/api/v1/modules/billing/public/checkout-session/${encodeURIComponent(sessionId)}`,
    { method: 'GET' },
  );
}

export function getMembershipCheckoutSession(
  sessionId: string,
): Promise<MembershipCheckoutSessionView> {
  return apiFetch<MembershipCheckoutSessionView>(
    `/api/v1/membership/checkout-session/${encodeURIComponent(sessionId)}`,
    { method: 'GET' },
  );
}

/**
 * Qué enseñar al volver del pago:
 *  - `paid`      — pagado: resumen y siguiente paso;
 *  - `unpaid`    — la sesión sigue abierta o caducó: no se cobró, se puede reintentar;
 *  - `pending`   — completada pero el cobro aún no consta (un medio diferido);
 *  - `unknown`   — no se pudo comprobar: ni sí ni no (decir «gracias» a quien
 *                  no pagó es justo lo que esta pantalla evita).
 */
export type CheckoutOutcome = 'paid' | 'unpaid' | 'pending' | 'unknown';

export function checkoutOutcome(view: CheckoutSessionView | null): CheckoutOutcome {
  if (!view) return 'unknown';
  if (view.paid) return 'paid';
  if (view.status === 'complete') return 'pending';
  return 'unpaid';
}
