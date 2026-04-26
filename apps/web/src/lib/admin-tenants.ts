'use client';

import { apiFetch } from './api-client';

export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';

export interface TenantListItem {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  createdAt: string;
  domains: Array<{ hostname: string; isPrimary: boolean; isVerified: boolean }>;
  userCount: number;
  courseCount: number;
}

export interface CreateTenantInput {
  slug: string;
  name: string;
  adminEmail: string;
  adminName?: string;
  primaryHostname: string;
}

export const adminTenantsApi = {
  async list(bearer: string): Promise<TenantListItem[]> {
    return apiFetch<TenantListItem[]>('/api/v1/admin/tenants', { method: 'GET' }, bearer);
  },
  async getOne(bearer: string, id: string): Promise<TenantListItem> {
    return apiFetch<TenantListItem>(`/api/v1/admin/tenants/${id}`, { method: 'GET' }, bearer);
  },
  async create(bearer: string, dto: CreateTenantInput): Promise<TenantListItem> {
    return apiFetch<TenantListItem>(
      '/api/v1/admin/tenants',
      { method: 'POST', body: JSON.stringify(dto) },
      bearer,
    );
  },
  async setStatus(bearer: string, id: string, status: TenantStatus): Promise<TenantListItem> {
    return apiFetch<TenantListItem>(
      `/api/v1/admin/tenants/${id}/status`,
      { method: 'PATCH', body: JSON.stringify({ status }) },
      bearer,
    );
  },
  async addDomain(bearer: string, id: string, hostname: string): Promise<TenantListItem> {
    return apiFetch<TenantListItem>(
      `/api/v1/admin/tenants/${id}/domains`,
      { method: 'POST', body: JSON.stringify({ hostname }) },
      bearer,
    );
  },
  async removeDomain(bearer: string, id: string, hostname: string): Promise<TenantListItem> {
    return apiFetch<TenantListItem>(
      `/api/v1/admin/tenants/${id}/domains/${encodeURIComponent(hostname)}`,
      { method: 'DELETE' },
      bearer,
    );
  },
};

export const STATUS_LABELS: Record<TenantStatus, string> = {
  ACTIVE: 'Activo',
  SUSPENDED: 'Suspendido',
  ARCHIVED: 'Archivado',
};
