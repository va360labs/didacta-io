/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { ApiHttpError, apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export interface FormadorStats {
  coursesPublished: number;
  coursesDraft: number;
  totalActiveEnrollments: number;
  totalCompletedEnrollments: number;
  averageProgressPercent: number;
  pendingGradings: number;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new ApiHttpError({ message: 'Sesión expirada', status: 401 });
  return token;
}

export const formadorStatsApi = {
  async get(): Promise<FormadorStats> {
    return apiFetch<FormadorStats>('/api/v1/formador/stats', { method: 'GET' }, withAuth());
  },
};
