'use client';

/**
 * Cliente HTTP del endpoint informativo de rate limit (sexto piloto License SDK).
 *
 * Backend: `apps/api/src/rate-limit/rate-limit-info.controller.ts`. El endpoint
 * NO está gateado por la capability `feat:api.rate_limit.elevated` — sirve
 * tanto a la vista community (que muestra el upsell) como a la vista
 * enterprise (que muestra las cifras reales). Solo el botón "Upgrade" del
 * frontend va envuelto en `<EeGate>`.
 */

import { apiFetch } from './api-client';

export type RateLimitTier = 'community' | 'enterprise';

export interface RateLimitTierConfig {
  authenticated: number;
  public: number;
}

export interface RateLimitInfo {
  /** Tier efectivo para este tenant en este momento. */
  tier: RateLimitTier;
  /** Cifra y ventana del bucket autenticado en el tier activo. */
  authenticated: { limit: number; windowSeconds: number };
  /** Cifra y ventana del bucket público en el tier activo. */
  public: { limit: number; windowSeconds: number };
  /** Capability EE asociada — útil para el frontend al construir el upsell. */
  capability: string;
  /** Cifras del tier community (sin licencia EE). */
  community: RateLimitTierConfig;
  /** Cifras del tier enterprise (con licencia EE). */
  enterprise: RateLimitTierConfig;
}

const BASE = '/api/v1/admin/rate-limit';

export const rateLimitApi = {
  async info(bearer: string): Promise<RateLimitInfo> {
    return apiFetch<RateLimitInfo>(`${BASE}/info`, { method: 'GET' }, bearer);
  },
};
