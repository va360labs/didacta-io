'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export type StatsRange = 'all' | '7d' | '30d';

export interface AdminStats {
  range: StatsRange;
  activeUsers: number;
  coursesPublished: number;
  totalEnrollments: number;
  certificatesIssued: number;
  completionRate: number;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token)
    throw new ApiHttpError({ message: 'Sesión expirada', status: 401, code: 'sessionExpired' });
  return token;
}

export const adminStatsApi = {
  async get(range: StatsRange = 'all'): Promise<AdminStats> {
    const params = new URLSearchParams({ range });
    return apiFetch<AdminStats>(
      `/api/v1/admin/stats?${params.toString()}`,
      { method: 'GET' },
      withAuth(),
    );
  },
};
