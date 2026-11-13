/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';

/** Cliente del panel de métricas de negocio (bloque 7). */

export interface WeeklyPoint {
  weekStart: string;
  value: number;
}

/**
 * Ventas de UNA moneda. El API nunca suma monedas distintas: un aula que cobra
 * en EUR y CHF recibe dos entradas. Importes en la unidad mínima de la moneda
 * según Stripe (céntimos en EUR; yenes en JPY). Orden: la moneda con más
 * cobros primero y, a igualdad, alfabético.
 */
export interface CurrencyRevenue {
  /** ISO 4217 en minúsculas (`eur`, `chf`…). */
  currency: string;
  totalMinor30d: number;
  weekly: WeeklyPoint[];
}

export interface BusinessMetrics {
  generatedAt: string;
  nps: {
    score: number | null;
    responses: number;
    promoters: number;
    passives: number;
    detractors: number;
  };
  /** `byCurrency` vacío si no hubo cobros en las últimas 12 semanas. */
  revenue: { byCurrency: CurrencyRevenue[] };
  arrears: { subscriptions: number; external: number; total: number };
  members: { newMembers30d: number; cancellations30d: number; weeklySignups: WeeklyPoint[] };
  connections: { active7d: number; active30d: number; totalActive: number };
  aiTutor: { activeUsers30d: number; questions30d: number };
  community: { posts30d: number };
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token)
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  return token;
}

export const adminBusinessMetricsApi = {
  async get(): Promise<BusinessMetrics> {
    return apiFetch<BusinessMetrics>(
      '/api/v1/admin/metrics/business',
      { method: 'GET' },
      withAuth(),
    );
  },
};
