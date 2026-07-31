'use client';

/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

import { apiFetch } from './api-client';
import { authStorage } from './auth-storage';

export interface Group {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  description: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroupDetail extends Group {
  members: Array<{
    userId: string;
    role: string;
    joinedAt: string;
  }>;
}

export interface GroupWithRole extends Group {
  myRole: string;
}

export interface PaginatedGroups {
  groups: Group[];
  total: number;
}

function withAuth(): string {
  const token = authStorage.getAccessToken();
  if (!token) throw new Error('No autenticado');
  return token;
}

export const groupsApi = {
  async list(page = 1, limit = 20): Promise<PaginatedGroups> {
    const token = withAuth();
    return apiFetch<PaginatedGroups>(
      `/api/v1/modules/groups?page=${page}&limit=${limit}`,
      { method: 'GET' },
      token,
    );
  },

  async listMine(): Promise<GroupWithRole[]> {
    const token = withAuth();
    return apiFetch<GroupWithRole[]>('/api/v1/modules/groups/me', { method: 'GET' }, token);
  },

  async getOne(id: string): Promise<GroupDetail> {
    const token = withAuth();
    return apiFetch<GroupDetail>(`/api/v1/modules/groups/${id}`, { method: 'GET' }, token);
  },

  async join(id: string): Promise<{ joined: boolean }> {
    const token = withAuth();
    return apiFetch<{ joined: boolean }>(
      `/api/v1/modules/groups/${id}/join`,
      { method: 'POST' },
      token,
    );
  },

  async leave(id: string): Promise<{ left: boolean }> {
    const token = withAuth();
    return apiFetch<{ left: boolean }>(
      `/api/v1/modules/groups/${id}/leave`,
      { method: 'DELETE' },
      token,
    );
  },
};
