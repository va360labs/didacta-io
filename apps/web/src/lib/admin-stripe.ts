/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * Cliente HTTP del controlador admin de Stripe per-tenant (backend en
 * `apps/api/src/admin/admin-stripe.controller.ts`). Mirror de `admin-smtp.ts`.
 *
 *  - `GET /api/v1/admin/tenant-settings/stripe` → estado (nunca las claves).
 *  - `PUT /api/v1/admin/tenant-settings/stripe` → upsert. Campos vacíos u
 *    omitidos conservan lo guardado. Reset de `verifiedAt`.
 *  - `POST /api/v1/admin/tenant-settings/stripe/test` → prueba real contra
 *    la API de Stripe (balance.retrieve). Si éxito → marca `verifiedAt`.
 *
 * Un único par de credenciales sirve a mod.billing y mod.subscriptions (la
 * venta de cursos sueltos y las suscripciones/membresía comparten cuenta de
 * Stripe del tenant).
 */

import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export interface AdminStripeDto {
  hasSecretKey: boolean;
  hasWebhookSecret: boolean;
  hasSubscriptionsWebhookSecret: boolean;
  /** 'test'/'live' derivado del prefijo de la clave, o null si no hay ninguna. */
  mode: 'test' | 'live' | null;
  verifiedAt: string | null;
  verifiedByUserId: string | null;
  /** True si el tenant tiene config propia; false si solo hereda el fallback global. */
  hasTenantConfig: boolean;
  /** True si el despliegue tiene env globales que sirven de fallback. */
  hasGlobalFallback: boolean;
}

export interface AdminStripeUpsertPayload {
  /** Opcional: si se omite o viene vacío, se conserva la clave guardada. */
  secretKey?: string;
  webhookSecret?: string;
  subscriptionsWebhookSecret?: string;
}

export interface AdminStripeTestResult {
  ok: true;
  mode: 'test' | 'live';
  verifiedAt: string;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export const adminStripeApi = {
  async get(): Promise<AdminStripeDto> {
    return apiFetch<AdminStripeDto>(
      '/api/v1/admin/tenant-settings/stripe',
      { method: 'GET' },
      withAuth(),
    );
  },
  async upsert(payload: AdminStripeUpsertPayload): Promise<AdminStripeDto> {
    return apiFetch<AdminStripeDto>(
      '/api/v1/admin/tenant-settings/stripe',
      { method: 'PUT', body: JSON.stringify(payload) },
      withAuth(),
    );
  },
  async test(): Promise<AdminStripeTestResult> {
    return apiFetch<AdminStripeTestResult>(
      '/api/v1/admin/tenant-settings/stripe/test',
      { method: 'POST', body: JSON.stringify({}) },
      withAuth(),
    );
  },
  /**
   * Elimina la config Stripe del tenant. No hay endpoint dedicado; se borran
   * las dos rows de `tenant_setting` (stripe + stripe_meta) usando el
   * controlador genérico. Tras esto, si hay env globales el server cae al
   * fallback; si no, el checkout/venta responde 503 hasta guardar de nuevo.
   */
  async remove(): Promise<void> {
    const bearer = withAuth();
    await apiFetch<{ ok: true }>(
      '/api/v1/tenant-settings/billing/stripe',
      { method: 'DELETE' },
      bearer,
    ).catch((err) => {
      if (err instanceof ApiHttpError && err.status === 404) return { ok: true } as const;
      throw err;
    });
    await apiFetch<{ ok: true }>(
      '/api/v1/tenant-settings/billing/stripe_meta',
      { method: 'DELETE' },
      bearer,
    ).catch((err) => {
      if (err instanceof ApiHttpError && err.status === 404) return { ok: true } as const;
      throw err;
    });
  },
};

export type AdminStripeStatus = 'verified' | 'configured-unverified' | 'fallback' | 'none';

/**
 * Deriva el estado del banner a partir del DTO. Mismo criterio que
 * `deriveSmtpStatus`.
 */
export function deriveStripeStatus(dto: AdminStripeDto): AdminStripeStatus {
  if (dto.hasTenantConfig && dto.verifiedAt) return 'verified';
  if (dto.hasTenantConfig) return 'configured-unverified';
  if (dto.hasGlobalFallback) return 'fallback';
  return 'none';
}
