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

export interface BusinessMetrics {
  generatedAt: string;
  nps: {
    score: number | null;
    responses: number;
    promoters: number;
    passives: number;
    detractors: number;
  };
  revenue: { totalCents30d: number; currency: string; weekly: WeeklyPoint[] };
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
