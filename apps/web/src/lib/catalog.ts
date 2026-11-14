/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cliente del CATÁLOGO PÚBLICO de cursos sueltos (viaje 2 — mod.billing).
 *
 * Todos los endpoints van SIN bearer: el visitante no tiene cuenta y el tenant
 * se resuelve por dominio (Host), igual que la página de membresía (/join).
 * Importes SIEMPRE en céntimos. El pago se pinta dentro de la ficha (Checkout
 * embebido) cuando el aula puede, y si no por el redirect a Stripe; la cuenta
 * del comprador se crea tras el pago con el email confirmado en Stripe.
 */

import type { WithdrawalWaiverAcceptance } from '@/lib/purchase-consent';
import { apiFetch } from './api-client';
import { normalizeCheckoutStart, type CheckoutStart, type RawCheckoutStart } from './checkout';

const PUBLIC_BASE = '/api/v1/modules/billing/public';

// ── Tipos ────────────────────────────────────────────────────────────────────

/** Una opción de compra del curso, tal y como la ve el visitante. */
export interface CatalogOption {
  id: string;
  /** "" cuando el curso tiene precio único. */
  name: string;
  perks: string[];
  unitAmount: number;
  compareAtAmount: number | null;
  currency: string;
  discountPercent: number | null;
  isFeatured: boolean;
  /**
   * Solo si el aula cobra por la plataforma: `true` cuando el pago enseñará el
   * precio en la moneda del alumno. Sin el campo, como siempre.
   */
  localCurrencyAtCheckout?: boolean;
}

export interface CatalogCourse {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  category: string | null;
  estimatedMinutes: number | null;
  /**
   * Temario: secciones con los títulos de sus lecciones, en orden. Opcional
   * para convivir con una API anterior que no lo manda.
   */
  syllabus?: Array<{ title: string; lessons: string[] }>;
  options: CatalogOption[];
}

// ── API ──────────────────────────────────────────────────────────────────────

export async function getPublicCatalog(): Promise<{ courses: CatalogCourse[] }> {
  return apiFetch<{ courses: CatalogCourse[] }>(`${PUBLIC_BASE}/catalog`, { method: 'GET' });
}

export async function startPublicCheckout(
  courseId: string,
  opts?: {
    optionId?: string;
    email?: string;
    withdrawalWaiver?: WithdrawalWaiverAcceptance;
    /** Código del enlace de referido con el que llegó (`?ref=`), si lo hay. */
    referralCode?: string;
    /**
     * `embedded`: pagar DENTRO de la ficha. El servidor lo concede si puede;
     * si no, devuelve el redirect de siempre (`mode: 'hosted'`).
     */
    uiMode?: 'embedded' | 'hosted';
  },
): Promise<CheckoutStart> {
  const raw = await apiFetch<RawCheckoutStart>(
    `${PUBLIC_BASE}/checkout/${encodeURIComponent(courseId)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...(opts?.optionId ? { optionId: opts.optionId } : {}),
        ...(opts?.email ? { email: opts.email } : {}),
        ...(opts?.withdrawalWaiver ? { withdrawalWaiver: opts.withdrawalWaiver } : {}),
        ...(opts?.referralCode ? { referralCode: opts.referralCode } : {}),
        ...(opts?.uiMode ? { uiMode: opts.uiMode } : {}),
      }),
    },
  );
  return normalizeCheckoutStart(raw);
}

// ── Helpers de presentación ──────────────────────────────────────────────────

/** Opción por defecto para la tarjeta: la destacada, si no la más barata. */
export function featuredOption(options: CatalogOption[]): CatalogOption | null {
  if (options.length === 0) return null;
  return options.find((o) => o.isFeatured) ?? options[0]!;
}
