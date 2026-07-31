'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export interface CommunityStats {
  totalMembers: number;
  totalCourses: number;
}

export interface CommunityMember {
  id: string;
  name: string | null;
  email: string;
  roles: string[];
  createdAt: string;
}

export interface PaginatedMembers {
  members: CommunityMember[];
  total: number;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new Error('No autenticado');
  return token;
}

export const communityStatsApi = {
  async getStats(): Promise<CommunityStats> {
    const token = withAuth();
    return apiFetch<CommunityStats>('/api/v1/modules/community/stats', { method: 'GET' }, token);
  },

  async listMembers(
    query: { search?: string; page?: number; limit?: number } = {},
  ): Promise<PaginatedMembers> {
    const token = withAuth();
    const usp = new URLSearchParams();
    if (query.search) usp.set('search', query.search);
    if (query.page) usp.set('page', String(query.page));
    if (query.limit) usp.set('limit', String(query.limit));
    const qs = usp.toString();
    return apiFetch<PaginatedMembers>(
      `/api/v1/modules/community/members${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      token,
    );
  },
};
