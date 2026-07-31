'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cliente HTTP de mod.billing.
 *
 * Endpoints vivos:
 *  - POST   /api/v1/modules/billing/checkout/:courseId  → arranca Stripe Checkout (alumno)
 *  - GET    /api/v1/modules/billing/products            → lista productos del tenant (admin)
 *  - POST   /api/v1/modules/billing/products            → vincula curso ↔ stripePriceId (admin)
 *  - PATCH  /api/v1/modules/billing/products/:id        → activar/desactivar / cambiar price (admin)
 *  - DELETE /api/v1/modules/billing/products/:id        → desvincular producto (admin)
 *
 * El backend construye `success_url` y `cancel_url` por sí mismo a partir de
 * `BILLING_SUCCESS_URL_BASE` / `BILLING_CANCEL_URL_BASE` (ver
 * `apps/api/src/modules/module-registry.service.ts`). Por eso el frontend
 * NO envía body — sólo el courseId en la ruta y el JWT en Authorization.
 *
 * Errores conocidos del backend (mapeados por `BillingErrorFilter`):
 *  - 404 BILLING_PRODUCT_NOT_FOUND   → el curso no es de pago
 *  - 409 BILLING_PRODUCT_INACTIVE    → producto desactivado por el admin
 *  - 502 BILLING_STRIPE_API_ERROR    → Stripe respondió error
 *  - 503 BILLING_STRIPE_CONFIG_MISSING → mod.billing no configurado en este tenant
 *
 * El módulo es CE — sin `<EeGate>`.
 */

import { apiFetch } from '@/lib/api-client';
import { authStorage } from '@/lib/auth-storage';

/**
 * Forma exacta del retorno del backend `BillingService.startCheckout`:
 * ver `modules/billing/src/billing.service.ts` → `StartCheckoutResult`.
 */
export interface StartCheckoutResult {
  orderId: string;
  sessionId: string;
  url: string;
}

/**
 * Producto admin: vínculo persistido entre un curso del tenant y un
 * `Stripe Price` concreto. Ver `BillingProductRow` en el service. El
 * `unitAmount` está en céntimos y `currency` en ISO-4217 minúsculas
 * (convención Stripe). Usar `formatPrice` para formato humano.
 */
export interface BillingProduct {
  id: string;
  tenantId: string;
  courseId: string;
  stripeProductId: string;
  stripePriceId: string;
  unitAmount: number;
  currency: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BillingProductsListResponse {
  products: BillingProduct[];
}

export interface BillingProductResponse {
  product: BillingProduct;
}

const BASE = '/api/v1/modules/billing';
const PRODUCTS = `${BASE}/products`;

export const billingApi = {
  /**
   * Arranca un Checkout Session en Stripe para el curso indicado.
   *
   * Flujo del cliente tras llamar:
   *   const { url } = await billingApi.startCheckout(courseId, token);
   *   window.location.href = url;
   *
   * El backend:
   *   1. resuelve el producto vinculado al curso en este tenant,
   *   2. crea una `mod_billing_order` PENDING,
   *   3. pide a Stripe la session con metadata { orderId, tenantId, ... },
   *   4. devuelve la URL hosted donde redirigir al alumno.
   */
  async startCheckout(
    courseId: string,
    accessToken: string,
    /** Opción de compra elegida. Sin ella el backend usa la destacada. */
    optionId?: string,
  ): Promise<StartCheckoutResult> {
    return apiFetch<StartCheckoutResult>(
      `${BASE}/checkout/${encodeURIComponent(courseId)}`,
      {
        method: 'POST',
        ...(optionId ? { body: JSON.stringify({ optionId }) } : {}),
      },
      accessToken,
    );
  },

  // ---------------- Admin ----------------

  async listProducts(bearer: string): Promise<BillingProductsListResponse> {
    return apiFetch<BillingProductsListResponse>(PRODUCTS, { method: 'GET' }, bearer);
  },

  async createProduct(
    bearer: string,
    courseId: string,
    stripePriceId: string,
  ): Promise<BillingProductResponse> {
    return apiFetch<BillingProductResponse>(
      PRODUCTS,
      { method: 'POST', body: JSON.stringify({ courseId, stripePriceId }) },
      bearer,
    );
  },

  async updateProduct(
    bearer: string,
    id: string,
    patch: { active?: boolean; stripePriceId?: string },
  ): Promise<BillingProductResponse> {
    return apiFetch<BillingProductResponse>(
      `${PRODUCTS}/${id}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
      bearer,
    );
  },

  async deleteProduct(bearer: string, id: string): Promise<{ deleted: boolean }> {
    return apiFetch<{ deleted: boolean }>(`${PRODUCTS}/${id}`, { method: 'DELETE' }, bearer);
  },
};

/**
 * Formatea un unitAmount (céntimos) + currency (ISO-4217 minúsculas) a una
 * cadena humana. Ej. (9900, 'eur') → "99,00 €".
 */
export function formatPrice(unitAmount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(unitAmount / 100);
  } catch {
    return `${(unitAmount / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** Una opción de compra del curso ("Curso", "Curso Intermedio", "Curso Avanzado"). */
export interface CourseOfferOption {
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

/** Oferta del curso tal y como la ve un alumno (GET /modules/billing/offer/:courseId). */
export interface CourseOffer {
  forSale: boolean;
  options: CourseOfferOption[];
}

const OFFER_VACIA: CourseOffer = { forSale: false, options: [] };

/**
 * Precio del curso para la ficha de venta. Nunca lanza: si el módulo de cobro
 * no está disponible, la ficha sigue renderizando y simplemente no ofrece la
 * compra (queda la membresía y el canje de código).
 */
export async function getCourseOffer(courseId: string): Promise<CourseOffer> {
  // El token va EXPLÍCITO: `apiFetch` solo pone la cabecera Authorization si se
  // le pasa. Sin ella el endpoint responde 401 y el cliente HTTP interpreta ese
  // 401 como "sesión caducada", la borra y echa al usuario a /signin — un
  // efecto muy peor que quedarse sin caja de precio.
  const bearer = authStorage.getAccessToken() ?? undefined;
  if (!bearer) return OFFER_VACIA;
  try {
    return await apiFetch<CourseOffer>(
      `/api/v1/modules/billing/offer/${encodeURIComponent(courseId)}`,
      { method: 'GET' },
      bearer,
    );
  } catch {
    return OFFER_VACIA;
  }
}
