/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cliente del CATÁLOGO PÚBLICO de cursos sueltos (viaje 2 — mod.billing).
 *
 * Todos los endpoints van SIN bearer: el visitante no tiene cuenta y el tenant
 * se resuelve por dominio (Host), igual que la página de membresía (/unete).
 * Importes SIEMPRE en céntimos. El checkout es Stripe hosted (redirect) y la
 * cuenta del comprador se crea tras el pago con el email confirmado en Stripe.
 */

import { apiFetch } from './api-client';

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
}

export interface CatalogCourse {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  category: string | null;
  estimatedMinutes: number | null;
  options: CatalogOption[];
}

export interface PublicOffer {
  forSale: boolean;
  options: CatalogOption[];
}

// ── API ──────────────────────────────────────────────────────────────────────

export async function getPublicCatalog(): Promise<{ courses: CatalogCourse[] }> {
  return apiFetch<{ courses: CatalogCourse[] }>(`${PUBLIC_BASE}/catalog`, { method: 'GET' });
}

export async function getPublicOffer(courseId: string): Promise<PublicOffer> {
  return apiFetch<PublicOffer>(`${PUBLIC_BASE}/offer/${encodeURIComponent(courseId)}`, {
    method: 'GET',
  });
}

export async function startPublicCheckout(
  courseId: string,
  opts?: { optionId?: string; email?: string },
): Promise<{ url: string; sessionId: string }> {
  return apiFetch<{ url: string; sessionId: string }>(
    `${PUBLIC_BASE}/checkout/${encodeURIComponent(courseId)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...(opts?.optionId ? { optionId: opts.optionId } : {}),
        ...(opts?.email ? { email: opts.email } : {}),
      }),
    },
  );
}

// ── Helpers de presentación ──────────────────────────────────────────────────

/** Opción por defecto para la tarjeta: la destacada, si no la más barata. */
export function featuredOption(options: CatalogOption[]): CatalogOption | null {
  if (options.length === 0) return null;
  return options.find((o) => o.isFeatured) ?? options[0]!;
}
