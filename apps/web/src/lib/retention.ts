'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { apiFetch } from './api-client';
import { authStorage } from './auth-storage';

/**
 * Oferta al darse de baja, lado de la creadora: qué se ofrece («Cuando alguien
 * quiere irse», en Ajustes) y el resumen de quién se quiso ir y por qué
 * (Alumnos).
 */

export interface RetentionConfig {
  pauseEnabled: boolean;
  pauseMaxMonths: number;
  discountEnabled: boolean;
  discountPercent: number;
  discountMonths: number;
}

export type ExitOutcome = 'PAUSED' | 'DISCOUNTED' | 'CANCELED';

export interface RetentionSummary {
  sinceDays: number;
  total: number;
  stayed: number;
  paused: number;
  discounted: number;
  canceled: number;
  reasons: Array<{ reason: string; count: number }>;
  pausedNow: number;
  pausesScheduled: number;
  recent: Array<{
    id: string;
    createdAt: string;
    outcome: ExitOutcome;
    reason: string;
    reasonText: string | null;
    userId: string;
    userName: string | null;
    userEmail: string | null;
    pauseMonths: number | null;
    pauseEndsAt: string | null;
    discountPercent: number | null;
    discountMonths: number | null;
    discountDuration: string | null;
  }>;
}

/** Opciones de los desplegables (la API acepta 1–3 meses, 5–90 % y 1–12 meses). */
export const PAUSE_MAX_OPTIONS = [1, 2, 3] as const;
export const DISCOUNT_PERCENT_OPTIONS = [10, 15, 20, 25, 30, 40, 50] as const;
export const DISCOUNT_MONTH_OPTIONS = [1, 2, 3, 6, 12] as const;

const BASE = '/api/v1/membership/admin/retention';

function token(): string | undefined {
  return authStorage.getAccessToken() ?? undefined;
}

export const retentionApi = {
  get(): Promise<RetentionConfig> {
    return apiFetch<RetentionConfig>(BASE, { method: 'GET' }, token());
  },
  update(body: Partial<RetentionConfig>): Promise<RetentionConfig> {
    return apiFetch<RetentionConfig>(BASE, { method: 'PUT', body: JSON.stringify(body) }, token());
  },
  summary(days = 90): Promise<RetentionSummary> {
    return apiFetch<RetentionSummary>(`${BASE}/summary?days=${days}`, { method: 'GET' }, token());
  },
};
