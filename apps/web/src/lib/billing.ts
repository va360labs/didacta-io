'use client';

/**
 * Cliente HTTP de mod.billing para el alumno.
 *
 * Endpoint vivo:
 *  - POST /api/v1/modules/billing/checkout/:courseId  → arranca Stripe Checkout
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

import { apiFetch } from './api-client';

/**
 * Forma exacta del retorno del backend `BillingService.startCheckout`:
 * ver `modules/billing/src/billing.service.ts` → `StartCheckoutResult`.
 */
export interface StartCheckoutResult {
  orderId: string;
  sessionId: string;
  url: string;
}

const BASE = '/api/v1/modules/billing';

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
  async startCheckout(courseId: string, accessToken: string): Promise<StartCheckoutResult> {
    return apiFetch<StartCheckoutResult>(
      `${BASE}/checkout/${encodeURIComponent(courseId)}`,
      { method: 'POST' },
      accessToken,
    );
  },
};
